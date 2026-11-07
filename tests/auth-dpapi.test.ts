/**
 * The credential path must not leak the session into a child process.
 *
 * `dpapiCall` shells out to Windows PowerShell, and the whole point of sealing
 * a session with DPAPI is that the plaintext does not travel in the clear. It
 * used to travel in the child's environment — which is readable by any process
 * of the same user (Task Manager, WMI, a crash dump) — while `...process.env`
 * additionally handed every API key this install holds to a helper whose only
 * job is one crypt32 call.
 *
 * These are source-level assertions on purpose: the real call needs Windows,
 * a logged-in Doubao profile and a DPAPI master key, so a behavioural test
 * cannot run in CI. The property being guarded is textual (what goes into
 * `env`/argv/stdin), so the source is the right place to check it.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/doubao-auth.ts', import.meta.url), 'utf8')

describe('DPAPI helper process', () => {
  it('never passes the payload through the environment', () => {
    expect(source).not.toContain('DSH_DOUBAO_DPAPI_BLOB')
    expect(source).not.toContain("DSH_DPAPI_MODE")
  })

  it('never inherits the whole host environment', () => {
    expect(source).not.toContain('...process.env')
  })

  it('sends the base64 payload on stdin', () => {
    expect(source).toContain("input: blob.toString('base64')")
    expect(source).toContain('[Console]::In.ReadToEnd()')
  })

  it('resolves PowerShell by absolute path instead of PATH', () => {
    expect(source).toContain('powershellPath()')
    expect(source).not.toMatch(/spawnSync\(\s*'powershell\.exe'/)
  })
})
describe('the client-cookie path stays removed', () => {
  /**
   * The decrypt path is gone for a reason that must not be quietly undone: the
   * Doubao client holds its cookie database with an EXCLUSIVE lock while it runs,
   * so the live read failed in the normal case, fell back to a 12-hour sealed
   * copy, and then served a session the server had already rotated — every
   * request rejected, with local state that still looked signed in.
   */
  it('has no client-jar decryption left', () => {
    expect(source).not.toContain('decryptFromProfile')
    expect(source).not.toContain('decodeCookiePlaintext')
    expect(source).not.toContain('decryptCookieValue')
    expect(source).not.toContain('node:sqlite')
    expect(source).not.toContain("'Local State'")
  })

  it('keeps no second sealed cache for a client-sourced session', () => {
    expect(source).not.toContain("'doubao-credentials.dpapi'")
    expect(source).toContain("'doubao-credentials-browser.dpapi'")
  })

  it('reads the one session it has from the browser sign-in', () => {
    expect(source).toContain('loadBrowserCredentials()')
    expect(source).toContain('还没有浏览器登录态')
  })

  it('still re-exports profile discovery for its other callers', () => {
    // `User Data` is still needed for the task-mode workspace, so the removal
    // must not take the locator with it.
    expect(source).toContain('findDoubaoUserDataDir')
  })
})
