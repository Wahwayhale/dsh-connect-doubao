/**
 * Doubao credentials — the sealed browser session, and the DPAPI helper under it.
 *
 * WHY THERE IS ONLY ONE SOURCE
 *
 * This module used to decrypt the desktop client's cookie jar: read the DPAPI
 * master key out of `<User Data>\Local State`, open
 * `<User Data>\Default\Network\Cookies` as SQLite, AES-GCM each `v10` value and
 * strip Chrome's host-binding prefix. It was removed, not merely deprecated,
 * because of a defect that no amount of care could fix from outside the app:
 *
 *   the client holds `Default\Network\Cookies` with an EXCLUSIVE lock while it
 *   runs, and this plugin exists precisely for an account whose app IS running.
 *   So the live read failed in the normal case, the code fell back to a 12-hour
 *   sealed copy, and once the server rotated the session every request was
 *   rejected upstream — with a local state that still looked "signed in", and
 *   therefore no local explanation for the user.
 *
 * The browser sign-in in `./doubao-auth-browser.ts` has neither of those
 * failure modes: it captures the cookies over CDP from a throwaway Chromium
 * profile, so there is no lock to lose, and what this module seals is exactly
 * what was just captured, so there is no stale copy to prefer. One source also
 * means one account: no fallback can silently serve whoever else happened to be
 * signed in somewhere on this machine.
 *
 * SECURITY: cookie values live in this process's memory and in one platform
 * sealed store — Windows DPAPI (current-user scope) or the macOS login
 * keychain — which no other account and no other machine can open. Nothing
 * here is logged, and nothing leaves except the outbound request's
 * `Cookie:` header.
 *
 * @module dsh-connect-doubao/auth
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

export interface DoubaoCredentials {
  /** Cookie pairs ready for a `Cookie:` header. */
  header: string
  /** Individual pairs, for selective use (e.g. msToken in a query string). */
  pairs: Map<string, string>
  /** True when a usable session was loaded. */
  ok: boolean
  /** Human-readable reason when `ok` is false. Never contains a secret. */
  reason?: string
}

/**
 * How long a loaded session stays in the process cache.
 *
 * Not a security boundary: unsealing costs a child process (the PowerShell
 * DPAPI helper on Windows, `security(1)` on macOS), and every upstream call
 * wants the header, so the cache is what keeps a chat turn from spawning one
 * process per request. Doubao rotates its own cookies server-side; the first
 * rejected request is the accurate expiry signal.
 */
export const CREDENTIAL_TTL_MS = 10 * 60 * 1000

/**
 * Cookie names Doubao's chat backend actually needs for authentication.
 * Verified in M1/M2: this exact set authenticated while the app was closed.
 */
export const REQUIRED_COOKIE_NAMES = [
  'sessionid',
  'sessionid_ss',
  'sid_tt',
  'sid_guard',
  'uid_tt',
  'ttwid',
  'odin_tt',
  'passport_csrf_token',
  's_v_web_id',
] as const

/* ------------------------------------------------------------------ *
 * Windows DPAPI
 * ------------------------------------------------------------------ */

interface DataBlob {
  cbData: number
  pbData: Buffer
}

/**
 * Absolute path to Windows PowerShell, or the bare name as a last resort.
 *
 * Resolving through PATH means a planted `powershell.exe` earlier in the search
 * order receives this call's input on stdin — which is a session cookie or the
 * DPAPI master key. The system copy lives at a fixed location, so ask for it.
 */
function powershellPath(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const direct = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(direct) ? direct : 'powershell.exe'
}

/**
 * The environment handed to the DPAPI helper.
 *
 * An explicit allow-list rather than a spread of the host environment: that
 * environment carries every API key this DSH install has, and none of them has
 * any business in a process whose only job is one crypt32 call.
 */
function dpapiChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  if (env.SystemRoot === undefined && env.windir !== undefined) env.SystemRoot = env.windir
  return env
}

/**
 * Call CryptProtectData / CryptUnprotectData via a short-lived PowerShell child.
 *
 * Node has no built-in DPAPI binding and the plugin must not pull in a native
 * addon, so we shell out to the Windows Data Protection API. The payload travels
 * over stdin and stdout and never touches disk.
 */
function dpapiCall(mode: 'protect' | 'unprotect', blob: Buffer): Buffer {
  // The script is written to a temp .ps1 and run with `-File`, not passed via
  // -Command/-EncodedCommand: the C# P/Invoke source needs real newlines, and
  // any inline form flattens the here-string header into a parse error.
  const script = [
    // A param block must be the first statement in the file.
    'param([string]$Mode = "unprotect")',
    "$ErrorActionPreference = 'Stop'",
    '$ProgressPreference = "SilentlyContinue"',
    // The C# source is built with -TypeDefinition rather than -MemberDefinition.
    //
    // Two constraints drive that choice, both learned the hard way:
    //  * -MemberDefinition demands -Name, which then moves the struct into a
    //    nested namespace where PowerShell cannot resolve `[DshCrypt.DshDataBlob]`;
    //  * declaring the out-param as `ref IntPtr` is WRONG. The native
    //    DATA_BLOB is { DWORD cbData; pbData } = 16 bytes, but `ref IntPtr`
    //    only writes 8, so the pointer half stays zero and the following
    //    Marshal.Copy reads freed memory and faults the process.
    //    The struct below is the only correct shape.
    // PowerShell single-quoted string, C# double quotes — one level only.
    '$cs = \'using System; using System.Runtime.InteropServices; [StructLayout(LayoutKind.Sequential)] public struct DshDataBlob { public int cbData; public IntPtr pbData; } public static class DshCrypt { [DllImport("crypt32.dll", SetLastError = true)] public static extern bool CryptUnprotectData(ref DshDataBlob pDataIn, IntPtr szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DshDataBlob pDataOut); [DllImport("crypt32.dll", SetLastError = true)] public static extern bool CryptProtectData(ref DshDataBlob pDataIn, IntPtr szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DshDataBlob pDataOut); }\'',
    'Add-Type -TypeDefinition $cs',
    // The payload arrives on STDIN, never in the environment: `env` of a child
    // process is visible to every other process of the same user (Task Manager,
    // WMI, a crashed-process dump), and this payload is a plaintext session —
    // the whole point of sealing it is that it does not travel in the clear.
    '$in = [Console]::In.ReadToEnd()',
    '$bytes = [System.Convert]::FromBase64String($in.Trim())',
    '$len = [int]$bytes.Length',
    '$mem = [Runtime.InteropServices.Marshal]::AllocHGlobal($len)',
    '[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $mem, $len)',
    '$inBlob = New-Object DshDataBlob',
    '$inBlob.cbData = $len',
    '$inBlob.pbData = $mem',
    '$outBlob = New-Object DshDataBlob',
    // CRYPTPROTECT_UI_FORBIDDEN = 0x1. Protect and unprotect share every
    // argument shape except the entry point, so the mode is one branch.
    "if ($Mode -eq 'protect') {",
    '  $ok = [DshCrypt]::CryptProtectData([ref]$inBlob, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 1, [ref]$outBlob)',
    '} else {',
    '  $ok = [DshCrypt]::CryptUnprotectData([ref]$inBlob, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 1, [ref]$outBlob)',
    '}',
    "if (-not $ok) { [Console]::Out.Write('DPAPI_CALL_FAILED'); exit 3 }",
    '$res = New-Object byte[] $outBlob.cbData',
    '[Runtime.InteropServices.Marshal]::Copy($outBlob.pbData, $res, 0, $outBlob.cbData)',
    '[Console]::Out.Write([System.Convert]::ToBase64String($res))',
    '',
  ].join('\r\n')

  const scratch = mkdtempSync(join(tmpdir(), 'dsh-doubao-dpapi-'))
  const scriptPath = join(scratch, 'unprotect.ps1')
  try {
    // UTF8 without a BOM: a BOM in a -File script makes PowerShell choke on the
    // very first line, which surfaces as a bare non-zero exit with no stderr.
    writeFileSync(scriptPath, script, 'utf8')
    // spawnSync rather than execFileSync: PowerShell writes a CLIXML preamble to
    // stderr even on success, and execFileSync discards stdout when that happens.
    const result = spawnSync(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, mode],
      {
        encoding: 'utf8',
        maxBuffer: 1 << 24,
        windowsHide: true,
        // The payload rides on stdin (see the script above); the environment is
        // narrowed to what PowerShell needs to start.
        input: blob.toString('base64'),
        env: dpapiChildEnv(),
      },
    )
    const stdout = result.stdout ?? ''
    if (stdout.trim() === '') {
      const stderr = result.stderr ?? ''
      throw new Error(
        `Windows DPAPI helper produced no output (status=${result.status}, ` +
        `stdout=${JSON.stringify(stdout.slice(0, 120))}, ` +
        `stderr=${JSON.stringify(stderr.slice(-400))})`,
      )
    }
    for (const line of stdout.split(/\r?\n/).reverse()) {
      const candidate = line.trim()
      if (!candidate || candidate.startsWith('#') || candidate.startsWith('<')) continue
      if (candidate === 'DPAPI_CALL_FAILED') {
        throw new Error('Windows DPAPI rejected the blob (CryptUnprotectData returned false)')
      }
      const decoded = Buffer.from(candidate, 'base64')
      if (decoded.length > 0) return decoded
    }
    throw new Error('DPAPI helper returned no usable output')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ *
 * macOS login keychain
 * ------------------------------------------------------------------ */

/**
 * Keychain identity of the sealed session.
 *
 * One generic-password item per install: `security find-generic-password
 * -s dsh-connect-doubao` finds exactly the one thing to read or delete.
 */
const KEYCHAIN_SERVICE = 'dsh-connect-doubao'
const KEYCHAIN_ACCOUNT = 'browser-session'

/**
 * Why the last keychain read failed, for the card's message. Never a secret.
 *
 * `loadBrowserCredentials` is a total function by design (absent == undefined),
 * and that used to be fine on Windows, where "no file" really does mean "never
 * signed in". On macOS a LOCKED or denied keychain produces the same undefined,
 * so the card said「重新登录」for a state where logging in again changes nothing.
 * Keep the last reason here and let the caller append it.
 */
let lastKeychainError: string | undefined

/**
 * Run one `security(1)` invocation.
 *
 * The login keychain is the at-rest boundary on macOS — the counterpart of
 * DPAPI on Windows: the blob is encrypted under the user's keybag instead of
 * sitting in a readable file. Two deliberate properties, measured 2026-11-18
 * on this macOS:
 *
 *  * the payload travels in the argv of a short-lived `security` child. This
 *    `security add-generic-password` has no stdin option and no prompt
 *    (omitting `-w` silently creates an EMPTY-password item; a pty gets the
 *    same), so argv is the only channel. The exposure is a same-user `ps` read
 *    during the child's milliseconds-long life;
 *  * `/usr/bin/security` is a fixed path, for the same reason `powershellPath()`
 *    is absolute: a planted `security` earlier in PATH would receive the
 *    payload in its argv.
 *
 * Exit status is the only success signal `add-generic-password` gives: it prints
 * NOTHING on success. Treating empty stdout as failure (measured 2026-11-18 on
 * a real Chrome login) made every macOS save throw while the item had in fact
 * been written.
 */
function securityRun(argv: string[], mode: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('/usr/bin/security', argv, { encoding: 'utf8', maxBuffer: 1 << 24 })
  const status = result.status
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (status !== 0) {
    throw new Error(
      `security(1) ${mode} failed (status=${String(status)}, ` +
      `stderr=${JSON.stringify(stderr.slice(-200))})`,
    )
  }
  return { status, stdout, stderr }
}

/** Write (or overwrite) the sealed session item. Throws on failure. */
function keychainProtect(blob: Buffer): void {
  securityRun(
    ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', blob.toString('utf8')],
    'protect',
  )
}

/** Read the sealed session payload. Throws on failure. */
function keychainUnprotect(): string {
  const { stdout } = securityRun(
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
    'unprotect',
  )
  if (stdout === '') throw new Error('security(1) unprotect returned no payload')
  // `find-generic-password -w` appends one newline; the payload is JSON and
  // cannot end in one, so stripping exactly one is unambiguous.
  return stdout.replace(/\n$/, '')
}

/** Delete the sealed session item. Absence is success. */
function keychainDelete(): void {
  try {
    securityRun(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT], 'delete')
  } catch { /* already gone */ }
}

/* ------------------------------------------------------------------ *
 * The sealed browser session
 * ------------------------------------------------------------------ */

/**
 * Where the one usable session lives on Windows.
 *
 * macOS stores the same payload as the login-keychain item
 * (`dsh-connect-doubao` / `browser-session`) rather than a file.
 *
 * The file name keeps the `-browser` suffix it was introduced with so an
 * existing sealed session survives the upgrade that removed the client path.
 *
 * There is no TTL here, on purpose: the session lives ~30 days server-side and
 * the FIRST rejected request is the accurate expiry signal. A clock on top of
 * that could only invent failures for a session that still works.
 */
const BROWSER_CACHE_FILENAME = 'doubao-credentials-browser.dpapi'

function browserCachePath(): string {
  return join(homedir(), '.dsh', BROWSER_CACHE_FILENAME)
}

/**
 * Seal browser-harvested cookies to the platform store — the DPAPI file on
 * Windows, the login keychain on macOS. Throws on a sealing failure.
 */
export function saveBrowserCredentials(pairs: Map<string, string>): void {
  const header = [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  const payload = JSON.stringify({
    savedAt: Date.now(),
    source: 'browser',
    header,
    pairs: [...pairs.entries()],
  })
  const blob = Buffer.from(payload, 'utf8')
  if (process.platform === 'darwin') {
    keychainProtect(blob)
    lastKeychainError = undefined
    return
  }
  if (process.platform !== 'win32') {
    throw new Error('当前系统不支持凭据密封（支持 Windows / macOS）')
  }
  const sealed = dpapiCall('protect', blob)
  mkdirSync(dirname(browserCachePath()), { recursive: true })
  writeFileSync(browserCachePath(), sealed, { mode: 0o600 })
}

/** Read the sealed browser session, or `undefined` when absent/unusable. */
export function loadBrowserCredentials(): DoubaoCredentials | undefined {
  try {
    const json = process.platform === 'darwin'
      ? keychainUnprotect()
      : dpapiCall('unprotect', readFileSync(browserCachePath())).toString('utf8')
    const parsed = JSON.parse(json) as { header?: unknown; pairs?: unknown }
    if (typeof parsed.header !== 'string' || !Array.isArray(parsed.pairs)) return undefined
    const pairs = new Map<string, string>()
    for (const entry of parsed.pairs) {
      if (!Array.isArray(entry) || entry.length !== 2) continue
      const [name, value] = entry as [unknown, unknown]
      if (typeof name === 'string' && typeof value === 'string' && name !== '') pairs.set(name, value)
    }
    const missing = REQUIRED_COOKIE_NAMES.filter((name) => !pairs.get(name))
    // A sealed blob that opens but lacks a required cookie is a HALF session:
    // the scan was abandoned mid-flow or the server rotated part of the jar.
    // Serving it would fail upstream with a message about the account, not
    // about the login, so treat it as absent and let the card ask for a scan.
    if (missing.length > 0) return undefined
    lastKeychainError = undefined
    return { ok: true, header: parsed.header, pairs }
  } catch (error: unknown) {
    // Remember WHY, so the card can tell "never signed in" apart from "the
    // keychain refused/did not answer". Only macOS reads this; the Windows
    // message is unchanged.
    if (process.platform === 'darwin') {
      lastKeychainError = error instanceof Error ? error.message : String(error)
    }
    return undefined
  }
}

/** True when a sealed browser session is present in the platform store. */
export function hasBrowserCredentials(): boolean {
  return loadBrowserCredentials() !== undefined
}

/** Drop the sealed session (a re-login always overwrites it). */
export function clearBrowserCredentials(): void {
  if (process.platform === 'darwin') {
    keychainDelete()
    lastKeychainError = undefined
    return
  }
  try { unlinkSync(browserCachePath()) } catch { /* already gone */ }
}

/* ------------------------------------------------------------------ *
 * Profile location
 * ------------------------------------------------------------------ */

/**
 * Locate the Doubao Chromium profile directory on this machine.
 *
 * Discovery lives in `./doubao-profile.ts` and is re-exported here because
 * every caller (discovery, upstream, doctor, probe) reaches for it through this
 * module. It is no longer hardcoded to `%LOCALAPPDATA%`: the app lets users put
 * `User Data` on another drive, and a fixed path made those installs look "not
 * installed". The cookie jar inside that folder is no longer read — the paths
 * still matter for the task-mode workspace and for diagnostics.
 */
export {
  findDoubaoUserDataDir,
  listDoubaoProfiles,
  describeProfileLocation,
  extractUserDataDir,
  resolveUserProvided,
  setProfileOverride,
  looksLikeProfile,
  PROFILE_ENV,
  type DoubaoProfileLocation,
  type ProfileSource,
} from './doubao-profile.ts'

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

let cached: { at: number; credentials: DoubaoCredentials } | undefined

/**
 * The session this plugin runs on: the sealed browser sign-in, or a failure that
 * tells the user what to do about it.
 *
 * Cached in process memory for `CREDENTIAL_TTL_MS` because the read costs a
 * PowerShell child process. A failure is reported as `{ ok: false, reason }`
 * rather than thrown so the provider can surface an actionable message instead
 * of a stack trace; the login route drops this cache, so a fresh scan is visible
 * immediately.
 */
export function loadDoubaoCredentials(options: { force?: boolean } = {}): DoubaoCredentials {
  const now = Date.now()
  if (!options.force && cached !== undefined && now - cached.at < CREDENTIAL_TTL_MS) {
    return cached.credentials
  }

  const sealed = loadBrowserCredentials()
  // On macOS an item that exists but cannot be read (locked keychain, denied
  // access) is NOT "never signed in": telling the user to scan again would send
  // them in a circle. Name the real cause instead. Windows text stays as is.
  const keychainHint = process.platform === 'darwin' && lastKeychainError !== undefined
    ? `（读取登录钥匙串失败：${lastKeychainError}）`
    : ''
  const credentials: DoubaoCredentials = sealed ?? {
    ok: false,
    reason: '还没有浏览器登录态。请在豆包卡片里点「重新登录」扫码一次。' + keychainHint,
    header: '',
    pairs: new Map(),
  }

  cached = { at: now, credentials }
  return credentials
}

/** Drop the in-memory cache. Used by tests and by explicit user refresh. */
export function invalidateCredentialCache(): void {
  cached = undefined
}

/**
 * Revoke the sealed session on disk as well.
 *
 * Called when the server refuses the session. Replacing it needs a fresh QR
 * scan, so keeping the file would only make every later request fail the same
 * way while the card still showed a signed-in account — the user's fix
 * (「重新登录」) would then look like it had no effect. Deleting it makes the
 * next request say "log in", which is the truth.
 */
export function clearCredentialCache(): void {
  cached = undefined
  clearBrowserCredentials()
}
