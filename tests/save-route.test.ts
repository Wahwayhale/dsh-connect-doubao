/**
 * Tests for the settings save route.
 *
 * This route is the whole persistence story for the card (the host settings
 * path is closed to this plugin), so the security guards and the read-back
 * contract are pinned here rather than left to a manual probe.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DOUBAO_PROFILE_PATH,
  DOUBAO_SAVE_PATH,
  registerDoubaoProfileRoute,
  registerDoubaoSaveRoute,
} from '../src/doubao-status.ts'
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
    options: { writeHeader?: boolean } = {},
  ): Promise<Captured> => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    // A real browser always sends Host, and the guard now requires it to be
    // loopback. The marker is what a same-origin write carries.
    const base: Record<string, string> = { host: '127.0.0.1:63052', 'content-type': 'application/json' }
    if (method === 'POST' && options.writeHeader !== false) base['x-dsh-doubao-write'] = '1'
    const req = {
      method,
      headers: { ...base, ...headers },
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

  it('rejects a write that does not carry the marker header', async () => {
    let written = false
    const h = harness({ read: () => ({}), write: () => { written = true } })
    const result = await h.call('POST', { field: 'toolEmulation', value: true }, {}, { writeHeader: false })
    expect(result.status).toBe(403)
    expect(result.body.error).toBe('missing-write-header')
    expect(written).toBe(false)
  })

  it('rejects a request whose Host is not loopback', async () => {
    // DNS rebinding: the page's own hostname resolves to 127.0.0.1, but the
    // Host header still carries the attacker's name.
    let written = false
    const h = harness({ read: () => ({}), write: () => { written = true } })
    const result = await h.call('POST', { field: 'toolEmulation', value: true }, { host: 'evil.example' })
    expect(result.status).toBe(403)
    expect(result.body.error).toBe('host-not-loopback')
    expect(written).toBe(false)
  })

  it('rejects a request the browser labels cross-site', async () => {
    const h = harness({ read: () => ({}), write: () => {} })
    const result = await h.call('GET', undefined, { 'sec-fetch-site': 'cross-site' })
    expect(result.status).toBe(403)
  })

  it('still accepts a plain same-origin read', async () => {
    // A same-origin fetch sends no Origin at all; that must keep working.
    const h = harness({ read: () => ({ toolEmulation: true }), write: () => {} })
    const result = await h.call('GET')
    expect(result.status).toBe(200)
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

  it('accepts a profile directory that really contains Doubao data', async () => {
    // The route validates against the filesystem, so the fake has to be real:
    // a `Default/Network/Cookies` file is the one thing `looksLikeProfile` checks.
    const profile = join(dir, 'User Data')
    mkdirSync(join(profile, 'Default', 'Network'), { recursive: true })
    writeFileSync(join(profile, 'Default', 'Network', 'Cookies'), '')
    const h = harness({ write: () => {}, read: () => ({}) })
    const res = await h.call('POST', { field: 'profileDir', value: profile })
    expect(res.status).toBe(200)
  })

  it('accepts an empty profile directory as "go back to auto-detect"', async () => {
    const h = harness({ write: () => {}, read: () => ({}) })
    const res = await h.call('POST', { field: 'profileDir', value: '' })
    expect(res.status).toBe(200)
  })

  it('rejects a profile directory holding no Doubao data and does not write', async () => {
    let written = false
    const h = harness({ write: () => { written = true }, read: () => ({}) })
    const res = await h.call('POST', { field: 'profileDir', value: join(dir, 'empty') })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('no Doubao profile at')
    expect(written).toBe(false)
  })

  it('rejects a non-string profile directory', async () => {
    const h = harness({ write: () => {}, read: () => ({}) })
    const res = await h.call('POST', { field: 'profileDir', value: 42 })
    expect(res.status).toBe(400)
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

describe('registerDoubaoProfileRoute', () => {
  /** Same capture trick as above, but this route takes a candidate provider. */
  function harness(deps: Parameters<typeof registerDoubaoProfileRoute>[1]) {
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
    registerDoubaoProfileRoute(ctx as never, deps)
    const call = async (method: string): Promise<Captured> => {
      const req = {
        method,
        headers: { host: '127.0.0.1:63052' },
        async *[Symbol.asyncIterator]() { /* no body */ },
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

  it('registers on the documented path', () => {
    expect(harness({ candidates: () => [] }).pathOf()).toBe(DOUBAO_PROFILE_PATH)
  })

  it('reports the first candidate as the detected directory', async () => {
    const h = harness({
      candidates: () => [
        { dir: 'D:/Doubao/User Data', source: 'manual' },
        { dir: 'C:/Users/x/AppData/Local/Doubao/User Data', source: 'appdata' },
      ],
    })
    const res = await h.call('GET')
    expect(res.status).toBe(200)
    expect(res.body.detected).toBe('D:/Doubao/User Data')
    expect(res.body.candidates).toHaveLength(2)
    expect(res.body.env).toBe('DSH_DOUBAO_PROFILE')
  })

  it('reports null when nothing was found rather than an empty string', async () => {
    // The card branches on null (`profile?.detected != null`) to decide between
    // "auto-detected" and "not found", so an empty string would read as a hit.
    const res = await harness({ candidates: () => [] }).call('GET')
    expect(res.body.detected).toBeNull()
  })

  it('is read-only', async () => {
    const h = harness({ candidates: () => [] })
    expect((await h.call('POST')).status).toBe(405)
  })

  it('reports a probe failure as 500', async () => {
    const h = harness({ candidates: () => { throw new Error('probe broke') } })
    const res = await h.call('GET')
    expect(res.status).toBe(500)
    expect(String(res.body.error)).toContain('probe broke')
  })
})
