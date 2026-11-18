/**
 * Platform sealing must cover macOS, not just Windows.
 *
 * Source-level assertions for the same reason as `auth-dpapi.test.ts`: the
 * real seal/unseal needs a live login keychain or a DPAPI master key, so a
 * behavioural test cannot run in CI. What is guarded is textual — the macOS
 * browser paths exist, the tree-kill is Windows-only, and the keychain call
 * goes through an absolute `/usr/bin/security` (a PATH lookup would hand the
 * session payload to a planted binary's argv).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const browser = readFileSync(new URL('../src/doubao-auth-browser.ts', import.meta.url), 'utf8')
const auth = readFileSync(new URL('../src/doubao-auth.ts', import.meta.url), 'utf8')

describe('browser discovery and teardown on macOS', () => {
  it('offers the standard macOS Chromium paths', () => {
    expect(browser).toContain("'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'")
    expect(browser).toContain("'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'")
    expect(browser).toContain("'/Applications/Chromium.app/Contents/MacOS/Chromium'")
  })

  it('reserves taskkill for Windows and SIGTERM elsewhere', () => {
    expect(browser).toContain("process.platform === 'win32'")
    expect(browser).toContain("child.kill('SIGTERM')")
  })

  it('escalates to SIGKILL and waits, so the next login can start', () => {
    // A Chrome that ignores SIGTERM keeps the user-data-dir and port 9333, and
    // the only symptom the user sees is "调试端口没起来" on their next attempt.
    expect(browser).toContain("child.kill('SIGKILL')")
    expect(browser).toContain('waitForExit(')
    expect(browser).toContain('await terminate(child)')
  })

  it('creates the browser profile 0700', () => {
    expect(browser).toContain('mkdirSync(profile, { recursive: true, mode: 0o700 })')
  })
})

describe('macOS keychain sealing', () => {
  it('calls /usr/bin/security by absolute path, never through PATH', () => {
    expect(auth).toContain("spawnSync('/usr/bin/security'")
    expect(auth).not.toMatch(/spawnSync\(\s*'security'/)
  })

  it('covers the full item lifecycle', () => {
    expect(auth).toContain('add-generic-password')
    expect(auth).toContain('find-generic-password')
    expect(auth).toContain('delete-generic-password')
    expect(auth).toContain("process.platform === 'darwin'")
  })

  it('does not treat an empty stdout from `security add` as failure', () => {
    // Measured on a real macOS login: `add-generic-password` exits 0 and prints
    // NOTHING on success. An earlier version required stdout and therefore
    // threw on every save while the item had in fact been written.
    expect(auth).not.toContain("result.status !== 0 || stdout === ''")
    expect(auth).toContain('if (status !== 0) {')
    expect(auth).toContain("if (stdout === '') throw")
  })

  it('reports WHY the keychain failed instead of claiming "never signed in"', () => {
    // A locked keychain used to read as "please scan again", which cannot work.
    expect(auth).toContain('lastKeychainError')
    expect(auth).toContain('读取登录钥匙串失败')
  })

  it('keeps the DPAPI path intact for Windows', () => {
    expect(auth).toContain('powershellPath()')
    expect(auth).toContain("'doubao-credentials-browser.dpapi'")
    expect(auth).toContain('dpapiCall(')
  })
})
