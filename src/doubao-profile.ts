/**
 * Where the Doubao app keeps its Chromium profile.
 *
 * The app installs wherever the user wants (`E:\Doubao` is normal), but its
 * profile normally lands under `%LOCALAPPDATA%\Doubao\User Data`. Plenty of
 * people move it — the installer offers a "data directory" choice, and some
 * move it after the fact to keep C: small. A hardcoded `AppData` path then
 * fails with "profile not found" on an otherwise perfectly working install.
 *
 * Strategies, most explicit first:
 *
 *   0. the directory the user picked in the settings card — stored in this
 *      plugin's own settings file and applied through {@link setProfileOverride}
 *   1. `DSH_DOUBAO_PROFILE`  — escape hatch, for scripted setups.
 *   2. AppData candidates    — the default layout, and free (four `existsSync`)
 *   3. process command line  — `Doubao.exe --user-data-dir=…`, authoritative
 *                              but costs a `powershell.exe` (≈0.8 s), so it is
 *                              only consulted once the cheap paths miss
 *   4. bounded scan          — depth-4 walk of every fixed drive for a
 *                              `User Data\Default\Network\Cookies`, time-boxed
 *
 * Order is cheapest-first rather than strongest-first on purpose: the common
 * case must not pay 0.8 s on every cold start.
 *
 * The result is a LIST, not a single path, because a stale leftover profile can
 * shadow the live one — someone who copied rather than moved leaves an empty
 * jar in AppData. `loadDoubaoCredentials` walks the list and keeps the first
 * profile that actually decrypts into a usable session.
 *
 * @module dsh-connect-doubao/profile
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** Where a candidate path came from. Reported by `doctor` so failures are diagnosable. */
export type ProfileSource = 'manual' | 'env' | 'process' | 'appdata' | 'scan'

export interface DoubaoProfileLocation {
  /** Absolute path of the `User Data` directory (the one containing `Default`). */
  dir: string
  source: ProfileSource
}

export interface ProfileProbeDeps {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Defaults to `process.platform`. */
  platform?: string
  /** Overrides the `powershell.exe` probe. Returns raw command lines. */
  processCommandLines?: () => string[]
  /** Directories to append `Doubao/User Data` to. Defaults to LOCALAPPDATA/APPDATA/C:\Users\*. */
  appDataBases?: string[]
  /** Drive roots for the fallback scan. Defaults to every existing `X:\`. */
  scanRoots?: string[]
  /** Wall-clock budget for the scan, in ms. Defaults to 1500. */
  scanBudgetMs?: number
  /** Injectable clock, for tests. */
  now?: () => number
  /** Overrides {@link setProfileOverride}, for tests. */
  manual?: string
}

/** Env var a user can set to point at their profile (the folder holding `Default`). */
export const PROFILE_ENV = 'DSH_DOUBAO_PROFILE'

/**
 * The directory the user picked in the settings card, if any.
 *
 * Module-level because the card's choice has to reach every caller of
 * `loadDoubaoCredentials` (quota, shim, upstream) without threading a parameter
 * through four layers. `apply` seeds it once at startup from the settings file
 * and re-seeds it whenever the card saves a new path.
 */
let manualOverride: string | undefined

/**
 * Point the resolver at a user-chosen directory.
 *
 * Call with `undefined` to go back to automatic detection. Invalid paths are
 * ignored here rather than stored, so a folder that was later deleted or
 * renamed falls back to detection instead of breaking sign-in outright.
 */
export function setProfileOverride(raw: string | undefined): void {
  if (raw === undefined) {
    manualOverride = undefined
    return
  }
  const resolved = resolveUserProvided(raw)
  manualOverride = resolved
}

/** The active override after validation, or `undefined`. */
export function currentProfileOverride(): string | undefined {
  return manualOverride
}

/** A directory is a profile only if the cookie jar is really there. */
export function looksLikeProfile(dir: string): boolean {
  return existsSync(join(dir, 'Default', 'Network', 'Cookies'))
}

/**
 * Resolve one user-supplied path.
 *
 * Accepts either the `User Data` directory itself or its parent (`E:\Doubao`),
 * because both are reasonable readings of "where my data is".
 */
export function resolveUserProvided(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^"|"$/g, '')
  if (trimmed === '') return undefined
  if (looksLikeProfile(trimmed)) return trimmed
  const nested = join(trimmed, 'User Data')
  if (looksLikeProfile(nested)) return nested
  return undefined
}

/**
 * Pull `--user-data-dir=` out of one command line.
 *
 * The argument arrives in two shapes and both occur in real Doubao output:
 *
 *   --user-data-dir=C:\path\to\User Data        (cut at whitespace)
 *   "--user-data-dir=C:\path with space"        (quoted as a whole)
 *
 * An empty value is treated as absent: `--user-data-dir=""` means "use the
 * Chromium default", not "the current directory".
 */
export function extractUserDataDir(commandLine: string): string | undefined {
  const key = '--user-data-dir='
  const at = commandLine.indexOf(key)
  if (at < 0) return undefined
  const start = at + key.length
  let value: string
  if (commandLine[start] === '"') {
    // `--user-data-dir="C:\..."` — the value itself is quoted.
    const end = commandLine.indexOf('"', start + 1)
    if (end < 0) return undefined
    value = commandLine.slice(start + 1, end)
  } else if (commandLine[at - 1] === '"') {
    // `"--user-data-dir=C:\..."` — the whole argument is quoted.
    const end = commandLine.indexOf('"', start)
    if (end < 0) return undefined
    value = commandLine.slice(start, end)
  } else {
    const end = commandLine.indexOf(' ', start)
    value = end < 0 ? commandLine.slice(start) : commandLine.slice(start, end)
  }
  const cleaned = value.trim()
  return cleaned === '' ? undefined : cleaned
}

/**
 * Read the live client's `--user-data-dir`, if the client is running.
 *
 * `Get-CimInstance` rather than `Get-Process`: the latter only exposes
 * `CommandLine` on PowerShell 7, and Windows still ships 5.1.
 */
function probeProcessCommandLines(): string[] {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='Doubao.exe'\" | ForEach-Object { $_.CommandLine }"
  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    )
    if (result.status !== 0 || typeof result.stdout !== 'string') return []
    return result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
  } catch {
    return []
  }
}

/** Default AppData candidates: the documented layout, plus every user profile. */
function defaultAppDataBases(env: NodeJS.ProcessEnv): string[] {
  const bases = [env.LOCALAPPDATA, env.APPDATA].filter(
    (entry): entry is string => typeof entry === 'string' && entry !== '',
  )
  const candidates = bases.map((base) => join(base, 'Doubao', 'User Data'))
  // Roaming first, then every other user's Local: a second account on the same
  // machine is a real setup, and `C:\Users` is cheap to list.
  const usersRoot = 'C:\\Users'
  if (existsSync(usersRoot)) {
    try {
      for (const user of readdirSync(usersRoot)) {
        candidates.push(join(usersRoot, user, 'AppData', 'Local', 'Doubao', 'User Data'))
      }
    } catch {
      /* unreadable C:\Users — nothing to add */
    }
  }
  return candidates
}

/** Directories that never contain a Doubao profile and are expensive to walk. */
const SCAN_SKIP = new Set([
  'windows',
  'windows.old',
  '$recycle.bin',
  'system volume information',
  'node_modules',
  '.git',
  'programdata',
  'recovery',
  'perflogs',
  'msocache',
])

/** Every existing fixed-drive root, `C:\` style. */
function defaultScanRoots(): string[] {
  const roots: string[] = []
  for (let code = 65 /* A */; code <= 90 /* Z */; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    if (existsSync(root)) roots.push(root)
  }
  return roots
}

/**
 * Bounded breadth-first search for a `User Data\Default\Network\Cookies`.
 *
 * Depth 4 covers `D:\Doubao\User Data` (2) and `D:\Apps\Doubao\User Data` (3)
 * with slack, and a directory-name check keeps it from examining every file.
 * The clock check runs per directory so a sprawling D: cannot stall startup.
 */
function scanForProfiles(
  roots: string[],
  budgetMs: number,
  now: () => number,
): DoubaoProfileLocation[] {
  const deadline = now() + budgetMs
  const found: DoubaoProfileLocation[] = []
  const seen = new Set<string>()
  const queue: Array<{ dir: string; depth: number }> = roots.map((root) => ({ dir: root, depth: 0 }))
  while (queue.length > 0) {
    if (now() > deadline) break
    const item = queue.shift()
    if (item === undefined) break
    let entries
    try {
      entries = readdirSync(item.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name.toLowerCase()
      if (SCAN_SKIP.has(name)) continue
      const child = join(item.dir, entry.name)
      const key = child.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      if (looksLikeProfile(child)) {
        found.push({ dir: child, source: 'scan' })
        continue
      }
      if (item.depth + 1 < 4) queue.push({ dir: child, depth: item.depth + 1 })
    }
  }
  return found
}

/**
 * Every plausible profile, best first.
 *
 * Deduplicated case-insensitively (Windows paths are case-insensitive, and the
 * process probe and scan can easily report the same directory). A later source
 * never overrides an earlier one, so `env` always wins.
 */
export function listDoubaoProfiles(deps: ProfileProbeDeps = {}): DoubaoProfileLocation[] {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return []
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const out: DoubaoProfileLocation[] = []
  const seen = new Set<string>()
  const push = (dir: string | undefined, source: ProfileSource): void => {
    if (dir === undefined) return
    const key = dir.toLowerCase().replace(/[\\/]+$/, '')
    if (seen.has(key)) return
    seen.add(key)
    out.push({ dir, source })
  }

  // 0. what the user picked in the settings card. The stored value is already
  //    validated, but the injected one may come straight from a test or a
  //    stale pick, so both paths re-resolve: a pick that no longer holds any
  //    Doubao data falls through to automatic detection instead of wedging
  //    credential loading on a folder the user has since moved.
  const manual = deps.manual ?? manualOverride
  if (manual !== undefined) push(resolveUserProvided(manual), 'manual')

  // 1. explicit environment variable
  const override = env[PROFILE_ENV]
  if (typeof override === 'string') push(resolveUserProvided(override), 'env')

  // 2. the documented layout (free)
  for (const base of deps.appDataBases ?? defaultAppDataBases(env)) {
    if (looksLikeProfile(base)) push(base, 'appdata')
  }

  // 3. the running client tells us where it really lives
  const lines = deps.processCommandLines ? deps.processCommandLines() : probeProcessCommandLines()
  for (const line of lines) {
    const dir = extractUserDataDir(line)
    if (dir !== undefined && looksLikeProfile(dir)) push(dir, 'process')
  }

  // 4. last resort: walk the drives
  if (out.length === 0) {
    const roots = deps.scanRoots ?? defaultScanRoots()
    for (const hit of scanForProfiles(roots, deps.scanBudgetMs ?? 1500, now)) push(hit.dir, hit.source)
  }

  return out
}

/** Best guess for the profile directory, or `undefined`. */
export function findDoubaoUserDataDir(deps: ProfileProbeDeps = {}): string | undefined {
  return listDoubaoProfiles(deps)[0]?.dir
}

/** Where the profile was found and how — what `doctor` prints. */
export function describeProfileLocation(deps: ProfileProbeDeps = {}): string {
  const profile = listDoubaoProfiles(deps)[0]
  return profile === undefined ? '<not found>' : `${profile.dir} (via ${profile.source})`
}
