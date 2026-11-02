/**
 * Tests for the settings save route.
 *
 * This route is the whole persistence story for the card (the host settings
 * path is closed to this plugin), so the security guards and the read-back
 * contract are pinned here rather than left to a manual probe.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOUBAO_SAVE_PATH, registerDoubaoSaveRoute } from '../src/doubao-status.ts'
import { readStoredSettings, writeStoredSetting } from '../src/doubao-store.ts'

interface Captured {
  status: number
  body: Record<string, unknown>
}

/** Build a fake webServer that captures the handler for direct invocation. */
function harness(deps: Parameters<typeof registerDoubaoSaveRoute>[1]) {
  let handler: ((req: IncomingMessage, res: ServerResponse) => void | Promise<void>) | undefined
  let path: string | undefined
  const ctx = {
    webServer: {
      register(route: { path: string; handler: typeof handler }): () => void {
        path = route.path
        handler = route.handler
        return () => { handler = undefined }
      },
    },
  }
  registerDoubaoSaveRoute(ctx as never, deps)
  const call = async (
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Captured> => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    } as unknown as IncomingMessage
    const captured: Captured = { status: 0, body: {} }
    const res = {
      writeHead(status: number) { captured.status = status; return res },
      end(payload: string) { captured.body = JSON.parse(payload) as Record<string, unknown> },
    } as unknown as ServerResponse
    await handler?.(req, res)
    return captured
  }
  return { call, pathOf: () => path }
}

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doubao-route-'))
  file = join(dir, 'settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('registerDoubaoSaveRoute', () => {
  it('registers on the documented path', () => {
    const h = harness({ write: () => {}, read: () => ({}) })
    expect(h.pathOf()).toBe(DOUBAO_SAVE_PATH)
  })

  it('returns the stored settings on GET', async () => {
    writeStoredSetting('toolEmulation', true, file)
    const h = harness({ write: () => {}, read: () => readStoredSettings(file) })
    const res = await h.call('GET')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, value: { toolEmulation: true } })
  })

  it('writes on POST and echoes the new file state', async () => {
    const h = harness({
      write: (field, value) => { writeStoredSetting(field, value, file) },
      read: () => readStoredSettings(file),
    })
    const res = await h.call('POST', { field: 'toolEmulation', value: true })
    expect(res.status).toBe(200)
    expect(res.body.value).toEqual({ toolEmulation: true })
    expect(readStoredSettings(file)).toEqual({ toolEmulation: true })
  })

  it('calls onApplied so the live provider config follows the file', async () => {
    const seen: Array<[string, unknown]> = []
    const h = harness({
      write: (field, value) => { writeStoredSetting(field, value, file) },
      read: () => readStoredSettings(file),
      onApplied: (field, value) => { seen.push([field, value]) },
    })
    await h.call('POST', { field: 'enabledModelIds', value: ['0', '3'] })
    expect(seen).toEqual([['enabledModelIds', ['0', '3']]])
  })

  it('includes diagnostics when the caller supplies them', async () => {
    const h = harness({
      write: (field, value) => { writeStoredSetting(field, value, file) },
      read: () => readStoredSettings(file),
      diagnostics: () => ({ configureRan: true }),
    })
    const res = await h.call('POST', { field: 'toolEmulation', value: false })
    expect(res.body.diagnostics).toEqual({ configureRan: true })
  })

  it('rejects methods other than GET and POST', async () => {
    const h = harness({ write: () => {}, read: () => ({}) })
    expect((await h.call('DELETE')).status).toBe(405)
    expect((await h.call('PUT')).status).toBe(405)
  })

  it('rejects a non-loopback Origin', async () => {
    const h = harness({ write: () => {}, read: () => ({}) })
    const res = await h.call('POST', { field: 'toolEmulation', value: true }, { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
  })

  it('accepts a loopback Origin', async () => {
    const h = harness({ write: () => {}, read: () => ({}) })
    const res = await h.call('POST', { field: 'toolEmulation', value: true }, { origin: 'http://127.0.0.1:1234' })
    expect(res.status).toBe(200)
  })

  it('rejects a field outside the allow-list and does not write', async () => {
    let written = false
    const h = harness({ write: () => { written = true }, read: () => ({}) })
    const res = await h.call('POST', { field: 'authFile', value: 'C:/secret' })
    expect(res.status).toBe(400)
    expect(written).toBe(false)
  })

  it('rejects a wrong value shape before touching the file', async () => {
    let written = false
    const h = harness({ write: () => { written = true }, read: () => ({}) })
    const enabled = await h.call('POST', { field: 'enabledModelIds', value: '0' })
    const tools = await h.call('POST', { field: 'toolEmulation', value: 'true' })
    expect(enabled.status).toBe(400)
    expect(tools.status).toBe(400)
    expect(written).toBe(false)
  })

  it('reports a write failure as 500 with the error name', async () => {
    const h = harness({
      write: () => { throw new TypeError('disk on fire') },
      read: () => ({}),
    })
    const res = await h.call('POST', { field: 'toolEmulation', value: true })
    expect(res.status).toBe(500)
    expect(res.body.errorName).toBe('TypeError')
    expect(String(res.body.error)).toContain('disk on fire')
  })
})
