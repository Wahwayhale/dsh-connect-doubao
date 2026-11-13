/**
 * Regression tests for macOS / Linux support.
 *
 * Windows keeps DPAPI + taskkill; the paths added for other platforms are
 * exercised here. The credential round-trip is behavioural (real AES-256-GCM
 * through the exported save/load functions, with HOME redirected to a temp dir);
 * the browser lookup uses an explicit override so it is deterministic on any CI
 * host; terminate() is checked at source level because it is intentionally not
 * exported (same rationale as auth-dpapi.test.ts).
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findBrowser } from '../src/doubao-auth-browser.ts'
import {
  REQUIRED_COOKIE_NAMES,
  saveBrowserCredentials,
  loadBrowserCredentials,
} from '../src/doubao-auth.ts'

const browserSource = readFileSync(new URL('../src/doubao-auth-browser.ts', import.meta.url), 'utf8')

describe('findBrowser() — explicit override (platform-independent)', () => {
  const prev = process.env.DSH_DOUBAO_CHROME
  afterEach(() => {
    if (prev === undefined) delete process.env.DSH_DOUBAO_CHROME
    else process.env.DSH_DOUBAO_CHROME = prev
  })

  it('returns DSH_DOUBAO_CHROME when it points at an existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-browser-'))
    try {
      const fake = join(dir, 'Chromium')
      writeFileSync(fake, '')
      process.env.DSH_DOUBAO_CHROME = fake
      expect(findBrowser()).toBe(fake)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores an override that does not exist', () => {
    const bogus = join(tmpdir(), 'definitely-not-a-real-chromium-binary-xyz')
    process.env.DSH_DOUBAO_CHROME = bogus
    // A real Chromium may be found on this host; a bare CI box returns undefined.
    // Either way it must NOT hand back the non-existent override path.
    expect(findBrowser()).not.toBe(bogus)
  })
})

describe('terminate() — POSIX cleanup (source-level)', () => {
  it('keeps the Windows taskkill branch', () => {
    expect(browserSource).toContain("process.platform === 'win32'")
    expect(browserSource).toContain("'taskkill'")
  })
  it('kills the spawned browser directly on non-Windows', () => {
    expect(browserSource).toContain("child.kill('SIGTERM')")
  })
})

describe.skipIf(process.platform === 'win32')('credential sealing — AES-256-GCM round trip', () => {
  let home: string
  const prevHome = process.env.HOME
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    // os.homedir() follows HOME on POSIX, so both the cache and the key file
    // land inside this disposable directory.
    process.env.HOME = home
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('seals with a 0600 key and recovers the 9 session cookies', () => {
    const pairs = new Map(REQUIRED_COOKIE_NAMES.map((name) => [name, `value-${name}`]))
    saveBrowserCredentials(pairs)

    const cache = join(home, '.dsh', 'doubao-credentials-browser.dpapi')
    const key = join(home, '.dsh', 'doubao-credentials.key')
    expect(readFileSync(cache).subarray(0, 6).toString('latin1')).toBe('DSHD1:')
    expect(statSync(cache).mode & 0o777).toBe(0o600)
    expect(readFileSync(key).length).toBe(32)
    expect(statSync(key).mode & 0o777).toBe(0o600)

    const loaded = loadBrowserCredentials()
    expect(loaded?.ok).toBe(true)
    for (const name of REQUIRED_COOKIE_NAMES) {
      expect(loaded?.pairs.get(name)).toBe(`value-${name}`)
    }
  })

  it('rejects a tampered blob instead of returning a half session', () => {
    const pairs = new Map(REQUIRED_COOKIE_NAMES.map((name) => [name, `value-${name}`]))
    saveBrowserCredentials(pairs)
    const cache = join(home, '.dsh', 'doubao-credentials-browser.dpapi')
    const blob = readFileSync(cache)
    blob[blob.length - 1] ^= 0xff // flip one ciphertext byte; GCM auth must fail
    writeFileSync(cache, blob)
    expect(loadBrowserCredentials()).toBeUndefined()
  })
})
