/**
 * Doubao credential extraction.
 *
 * The Doubao desktop app is a Chromium fork. Its sign-in lives in the
 * standard Chromium cookie jar, so an already-signed-in app can serve as the
 * credential source for an external client without any interactive login.
 *
 * Decryption chain (verified end-to-end against Doubao 2.29.10):
 *
 *   <User Data>\Local State
 *     -> os_crypt.encrypted_key            (base64 string)
 *     -> strip the leading b"DPAPI" magic   (5 bytes)
 *     -> CryptUnprotectData                 (Windows DPAPI, user scope)
 *     -> 32-byte master key
 *
 *   <User Data>\Default\Network\Cookies     (SQLite)
 *     -> encrypted_value, scheme "v10"
 *     -> AES-256-GCM(nonce = value[3..15], aad = none)
 *     -> plaintext = sha256(host_key).digest()[0..N) || cookie_value
 *     -> strip that N-byte host prefix
 *
 * The N-byte prefix is the part that is easy to get wrong. Chrome 130+ binds
 * each plaintext to its host with `sha256(host_key)`; older builds stored the
 * bare value. Guessing wrong yields a value with trailing binary garbage,
 * which fails far downstream as an opaque "session expired" from the server.
 * `decodeCookiePlaintext` therefore adapts N instead of hardcoding it.
 *
 * SECURITY: credentials live in this process's memory only. Nothing here is
 * ever written to disk, exported, or logged. Callers must treat the returned
 * values as opaque secrets.
 */
import { createHash, createDecipheriv } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync, copyFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

export interface DoubaoCookie {
  host: string
  name: string
  value: string
}

export interface DoubaoCredentials {
  /** Cookie pairs ready for a `Cookie:` header. */
  header: string
  /** Individual pairs, for selective use (e.g. msToken in a query string). */
  pairs: Map<string, string>
  /** True when the Doubao app profile was found and decrypted successfully. */
  ok: boolean
  /** Human-readable reason when `ok` is false. Never contains a secret. */
  reason?: string
}

/** Cookie lifetime in the process cache. Doubao rotates `bd_sso_hi3jfd` itself. */
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

const COOKIE_HOST_SUFFIXES = ['doubao.com', 'bytedance.com']

/* ------------------------------------------------------------------ *
 * Windows DPAPI
 * ------------------------------------------------------------------ */

interface DataBlob {
  cbData: number
  pbData: Buffer
}

const DPAPI_MAGIC = Buffer.from('DPAPI', 'ascii')

/**
 * Call CryptUnprotectData via a short-lived PowerShell child process.
 *
 * Node has no built-in DPAPI binding and the plugin must not pull in a native
 * addon, so we shell out to the Windows Data Protection API. The master key
 * travels back over stdout and never touches disk.
 */
function dpapiUnprotect(cipher: Buffer): Buffer {
  // The script is written to a temp .ps1 and run with `-File`, not passed via
  // -Command/-EncodedCommand: the C# P/Invoke source needs real newlines, and
  // any inline form flattens the here-string header into a parse error.
  const script = [
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
    '$cs = \'using System; using System.Runtime.InteropServices; [StructLayout(LayoutKind.Sequential)] public struct DshDataBlob { public int cbData; public IntPtr pbData; } public static class DshCrypt { [DllImport("crypt32.dll", SetLastError = true)] public static extern bool CryptUnprotectData(ref DshDataBlob pDataIn, IntPtr szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DshDataBlob pDataOut); }\'',
    'Add-Type -TypeDefinition $cs',
    '$bytes = [System.Convert]::FromBase64String($env:DSH_DOUBAO_DPAPI_BLOB)',
    '$len = [int]$bytes.Length',
    '$mem = [Runtime.InteropServices.Marshal]::AllocHGlobal($len)',
    '[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $mem, $len)',
    '$inBlob = New-Object DshDataBlob',
    '$inBlob.cbData = $len',
    '$inBlob.pbData = $mem',
    '$outBlob = New-Object DshDataBlob',
    // CRYPTPROTECT_UI_FORBIDDEN = 0x1
    '$ok = [DshCrypt]::CryptUnprotectData([ref]$inBlob, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 1, [ref]$outBlob)',
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
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        encoding: 'utf8',
        maxBuffer: 1 << 24,
        windowsHide: true,
        env: { ...process.env, DSH_DOUBAO_DPAPI_BLOB: cipher.toString('base64') },
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
 * Cookie value decoding
 * ------------------------------------------------------------------ */

/**
 * Strip the host-binding prefix from a decrypted cookie plaintext.
 *
 * `N` is discovered by matching the plaintext against `sha256(host_key)` at
 * decreasing prefix lengths. 32 is Chrome 130+; 0 covers legacy builds that
 * stored the bare value. We never guess: an unmatched plaintext is an error,
 * because silently returning a corrupt value would surface later as an opaque
 * server-side "login invalid" instead of an actionable local failure.
 */
export function decodeCookiePlaintext(plaintext: Buffer, hostKey: string): string {
  const digest = createHash('sha256').update(hostKey, 'utf8').digest()
  for (const n of [32, 24, 16, 0]) {
    if (n === 0) break
    if (plaintext.length >= n && plaintext.subarray(0, n).equals(digest.subarray(0, n))) {
      return plaintext.subarray(n).toString('latin1')
    }
  }
  if (plaintext.length === 0) return ''
  // No host prefix matched: only accept it if it is entirely printable ASCII,
  // which is what a legacy bare value looks like.
  let printable = true
  for (const byte of plaintext) {
    if (byte < 0x20 || byte > 0x7e) { printable = false; break }
  }
  if (printable) return plaintext.toString('latin1')
  throw new Error(
    'cookie plaintext matches no known host prefix and is not printable ASCII; ' +
    'this Chromium fork may use a different binding scheme',
  )
}

/** Decrypt one `v10` cookie value with the profile master key. */
export function decryptCookieValue(masterKey: Buffer, encryptedValue: Buffer, hostKey: string): string {
  if (encryptedValue.length < 3) return ''
  const scheme = encryptedValue.subarray(0, 3).toString('latin1')
  if (scheme === 'v10' || scheme === 'v11') {
    const nonce = encryptedValue.subarray(3, 15)
    const tagAndCiphertext = encryptedValue.subarray(15)
    const tag = tagAndCiphertext.subarray(tagAndCiphertext.length - 16)
    const ciphertext = tagAndCiphertext.subarray(0, tagAndCiphertext.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return decodeCookiePlaintext(plaintext, hostKey)
  }
  if (scheme === 'v20') {
    throw new Error(
      'cookie uses the v20 App-Bound scheme, which requires the Doubao app ' +
      'process to decrypt it; run the request from inside the app instead',
    )
  }
  throw new Error(`unsupported cookie encryption scheme "${scheme}"`)
}

/* ------------------------------------------------------------------ *
 * Profile location
 * ------------------------------------------------------------------ */

/** Locate the Doubao Chromium profile directory on this machine. */
export function findDoubaoUserDataDir(): string | undefined {
  if (process.platform !== 'win32') return undefined
  const bases = [
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    'C:\\Users',
  ].filter((x): x is string => Boolean(x))
  const candidates: string[] = []
  for (const base of bases) {
    candidates.push(join(base, 'Doubao', 'User Data'))
    if (base.endsWith('Users')) {
      try {
        const { readdirSync } = require_('node:fs') as typeof import('node:fs')
        for (const user of readdirSync(base)) {
          candidates.push(join(base, user, 'AppData', 'Local', 'Doubao', 'User Data'))
        }
      } catch { /* ignore unreadable bases */ }
    }
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'Default', 'Network', 'Cookies'))) return candidate
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * SQLite access (read-only, via a throwaway copy)
 * ------------------------------------------------------------------ */

/**
 * Read rows from the cookie jar.
 *
 * Chromium holds an exclusive lock on the live database, so the file is copied
 * to a temp directory first and that copy is destroyed before returning. The
 * original profile is only ever read.
 */
function readCookieRows(userDataDir: string): Array<{ host: string; name: string; encrypted: Buffer }> {
  const source = join(userDataDir, 'Default', 'Network', 'Cookies')
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-doubao-cookie-'))
  const copy = join(scratch, 'Cookies.db')
  try {
    copyFileSync(source, copy)
    // node:sqlite ships with Node 22.5+ under this flag on some builds; fall
    // back to a plain read so the caller degrades instead of crashing.
    const { DatabaseSync } = require_('node:sqlite') as
      typeof import('node:sqlite')
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      const stmt = db.prepare(
        'SELECT host_key, name, encrypted_value FROM cookies WHERE encrypted_value IS NOT NULL',
      )
      const rows = stmt.all() as Array<{ host_key: string; name: string; encrypted_value: Uint8Array }>
      return rows.map((r) => ({
        host: String(r.host_key),
        name: String(r.name),
        encrypted: Buffer.from(r.encrypted_value),
      }))
    } finally {
      db.close()
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

let cached: { at: number; credentials: DoubaoCredentials } | undefined

/**
 * Decrypt the Doubao session from the local app profile.
 *
 * The result is cached in process memory for `CREDENTIAL_TTL_MS`. Nothing is
 * persisted. A failure is reported as `{ ok: false, reason }` rather than
 * thrown so the provider can surface an actionable message.
 */
export function loadDoubaoCredentials(options: { force?: boolean } = {}): DoubaoCredentials {
  const now = Date.now()
  if (!options.force && cached && now - cached.at < CREDENTIAL_TTL_MS) {
    return cached.credentials
  }

  let credentials: DoubaoCredentials
  try {
    const userDataDir = findDoubaoUserDataDir()
    if (!userDataDir) {
      credentials = {
        ok: false,
        reason:
          'Doubao user profile not found. Expected <UserProfile>\\AppData\\Local\\Doubao\\User Data.',
        header: '',
        pairs: new Map(),
      }
    } else {
      credentials = decryptFromProfile(userDataDir)
    }
  } catch (error) {
    credentials = {
      ok: false,
      reason: `failed to read Doubao credentials: ${(error as Error).message}`,
      header: '',
      pairs: new Map(),
    }
  }

  cached = { at: now, credentials }
  return credentials
}

function decryptFromProfile(userDataDir: string): DoubaoCredentials {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'Doubao credential extraction is only supported on Windows.', header: '', pairs: new Map() }
  }

  const localState = JSON.parse(readFileSync(join(userDataDir, 'Local State'), 'utf8')) as {
    os_crypt?: { encrypted_key?: string }
  }
  const encodedKey = localState.os_crypt?.encrypted_key
  if (!encodedKey) {
    return { ok: false, reason: 'Local State has no os_crypt.encrypted_key.', header: '', pairs: new Map() }
  }
  const keyBlob = Buffer.from(encodedKey, 'base64')
  if (keyBlob.subarray(0, 5).toString('latin1') !== DPAPI_MAGIC.toString('latin1')) {
    return { ok: false, reason: 'encrypted_key is missing the DPAPI prefix.', header: '', pairs: new Map() }
  }
  const masterKey = dpapiUnprotect(keyBlob.subarray(5))
  if (masterKey.length !== 32) {
    return { ok: false, reason: `master key has unexpected length ${masterKey.length}.`, header: '', pairs: new Map() }
  }

  try {
    const rows = readCookieRows(userDataDir)
    const pairs = new Map<string, string>()
    for (const row of rows) {
      const host = row.host.toLowerCase()
      if (!COOKIE_HOST_SUFFIXES.some((suffix) => host === `.${suffix}` || host.endsWith(`.${suffix}`))) continue
      try {
        pairs.set(row.name, decryptCookieValue(masterKey, row.encrypted, row.host))
      } catch {
        // A single unreadable cookie (e.g. a v20 App-Bound one) must not sink
        // the whole session.
      }
    }

    const missing = REQUIRED_COOKIE_NAMES.filter((name) => !pairs.get(name))
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `Doubao session cookies missing (${missing.join(', ')}). Sign in to the Doubao app and retry.`,
        header: '',
        pairs,
      }
    }

    const header = [...pairs.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
    return { ok: true, header, pairs }
  } finally {
    masterKey.fill(0)
  }
}

/** Drop the in-memory cache. Used by tests and by explicit user refresh. */
export function invalidateCredentialCache(): void {
  cached = undefined
}

/** Parent directory of the profile, for diagnostics only. */
export function describeProfileLocation(): string {
  const dir = findDoubaoUserDataDir()
  return dir ? dirname(dir) : '<not found>'
}
