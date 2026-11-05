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