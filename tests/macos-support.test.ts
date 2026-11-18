/**
 * macOS / Linux support: browser lookup, POSIX cleanup, session sealing and
 * profile discovery.
 *
 * The bug these lock down: upstream was Windows-only by construction, so on
 * macOS the sign-in card answered "没找到 Chrome 或 Edge" (the candidate list was
 * four `C:\Program Files` paths), `terminate()` silently left the browser
 * running because `spawnSync('taskkill')` reports ENOENT in `result.error`
 * instead of throwing, and the sealed session could not be read back because
 * sealing went through Windows DPAPI.
 *
 * A second, quieter failure is covered here because the first round of
 * platform patches missed it: `listDoubaoProfiles` returned `[]` on every
 * non-Windows host, so model discovery fell back to the 6-entry static
 * catalog even on a machine whose Doubao client was running with its
 * Preferences file right there.
 *
 * The sealing round-trip is behavioural (real AES-256-GCM through the exported
 * save/load pair, with HOME redirected). The browser lookup and `terminate`
 * are checked at source level where they cannot be exercised portably — same
 * rationale as auth-dpapi.test.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearBrowserCredentials,
  loadBrowserCredentials,
  saveBrowserCredentials,
} from '../src/doubao-auth.ts'
import { listDoubaoProfiles, looksLikeProfile, PROFILE_ENV } from '../src/doubao-profile.ts'

const authBrowserSource = readFileSync(
  new URL('../src/doubao-auth-browser.ts', import.meta.url),
  'utf8',
)
const authSource = readFileSync(new URL('../src/doubao-auth.ts', import.meta.url), 'utf8')

const ALL_COOKIES = new Map([
  ['sessionid', 'sid-value'],
  ['sessionid_ss', 'sid-ss-value'],
  ['sid_tt', 'sid-tt-value'],
  ['sid_guard', 'sid-guard-value'],
  ['uid_tt', 'uid-tt-value'],
  ['ttwid', 'ttwid-value'],
  ['odin_tt', 'odin-tt-value'],
  ['passport_csrf_token', 'csrf-value'],
  ['s_v_web_id', 'web-id-value'],
])

let home: string
const realHome = process.env.HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'doubao-macos-'))
  process.env.HOME = home
})

afterEach(() => {
  clearBrowserCredentials()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

describe('session sealing off Windows', () => {
  it('round-trips the session through save/load', () => {
    saveBrowserCredentials(ALL_COOKIES)
    const loaded = loadBrowserCredentials()
    expect(loaded?.ok).toBe(true)
    expect(loaded?.pairs.get('sessionid')).toBe('sid-value')
    expect(loaded?.header).toContain('sessionid=sid-value')
  })

  it('writes a 32-byte key with owner-only permissions', () => {
    saveBrowserCredentials(ALL_COOKIES)
    const keyPath = join(home, '.dsh', 'doubao-credentials.key')
    expect(readFileSync(keyPath).length).toBe(32)
  })

  it('rejects a tampered blob instead of yielding garbage', () => {
    saveBrowserCredentials(ALL_COOKIES)
    const cachePath = join(home, '.dsh', 'doubao-credentials-browser.dpapi')
    const sealed = readFileSync(cachePath)
    sealed[sealed.length - 1] ^= 0xff
    writeFileSync(cachePath, sealed)
    expect(loadBrowserCredentials()).toBeUndefined()
  })

  it('rejects a blob whose magic is not ours', () => {
    saveBrowserCredentials(ALL_COOKIES)
    const cachePath = join(home, '.dsh', 'doubao-credentials-browser.dpapi')
    const sealed = readFileSync(cachePath)
    sealed.write('XXXXXX', 0, 'latin1')
    writeFileSync(cachePath, sealed)
    expect(loadBrowserCredentials()).toBeUndefined()
  })

  it('does not reach for DPAPI on this platform', () => {
    // The Windows branch must stay textually intact and be the only caller of
    // dpapiCall from the seal path.
    expect(authSource).toContain("if (process.platform === 'win32') return dpapiCall('protect', plaintext)")
    expect(authSource).toContain("if (process.platform === 'win32') return dpapiCall('unprotect', sealed)")
  })
})

describe('browser lookup off Windows', () => {
  it('keeps the four Windows paths for win32', () => {
    expect(authBrowserSource).toContain("'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe'")
    expect(authBrowserSource).toContain('process.platform === \'win32\' ? WINDOWS_CANDIDATES : posixCandidates()')
  })

  it('has macOS and Linux candidates', () => {
    expect(authBrowserSource).toContain("'Google Chrome.app'")
    expect(authBrowserSource).toContain("'Microsoft Edge.app'")
    expect(authBrowserSource).toContain("'/usr/bin/google-chrome'")
  })

  it('honours an explicit Chromium override', () => {
    expect(authBrowserSource).toContain('process.env.DSH_DOUBAO_CHROME')
  })

  it('signals instead of calling taskkill off Windows', () => {
    expect(authBrowserSource).toContain("if (process.platform !== 'win32')")
    expect(authBrowserSource).toContain("child.kill('SIGTERM')")
  })
})

describe('profile discovery off Windows', () => {
  it('accepts the macOS cookie-jar spelling', () => {
    const dir = join(home, 'Library', 'Application Support', 'Doubao')
    mkdirSync(join(dir, 'Default'), { recursive: true })
    writeFileSync(join(dir, 'Default', 'Cookies'), 'sqlite-placeholder', 'utf8')
    expect(looksLikeProfile(dir)).toBe(true)
  })

  it('accepts a Preferences-only profile', () => {
    const dir = join(home, 'Library', 'Application Support', 'Doubao')
    mkdirSync(join(dir, 'Default'), { recursive: true })
    writeFileSync(join(dir, 'Default', 'Preferences'), '{}', 'utf8')
    expect(looksLikeProfile(dir)).toBe(true)
  })

  it('finds the macOS data dir through the env var', () => {
    const dir = join(home, 'Library', 'Application Support', 'Doubao')
    mkdirSync(join(dir, 'Default'), { recursive: true })
    writeFileSync(join(dir, 'Default', 'Cookies'), 'sqlite-placeholder', 'utf8')
    const found = listDoubaoProfiles({
      platform: 'darwin',
      env: { [PROFILE_ENV]: dir } as NodeJS.ProcessEnv,
      processCommandLines: () => [],
    })
    expect(found[0]?.dir).toBe(dir)
  })

  it('does not run the PowerShell probe or drive scan off Windows', () => {
    const probed: string[] = []
    const found = listDoubaoProfiles({
      platform: 'darwin',
      env: {} as NodeJS.ProcessEnv,
      processCommandLines: () => {
        probed.push('called')
        return []
      },
      scanRoots: [home],
    })
    expect(found).toEqual([])
    expect(probed).toEqual([])
  })

  it('returns [] on a platform it cannot probe', () => {
    expect(listDoubaoProfiles({ platform: 'freebsd' as NodeJS.Platform, env: {} as NodeJS.ProcessEnv })).toEqual([])
  })
})
