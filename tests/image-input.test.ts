import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, REQUEST_IMAGE_BUDGETS, type DoubaoPluginContext } from '../src/index.ts'
import { createDoubaoAdapter } from '../src/doubao-adapter.ts'
import { REQUIRED_COOKIE_NAMES, type DoubaoCredentials } from '../src/doubao-auth.ts'
import { DOUBAO_IMAGE_MODEL_ID, modelInputModalities } from '../src/doubao-catalog.ts'
import { discoverModels, invalidateDiscovery } from '../src/doubao-discovery.ts'
import { setProfileOverride } from '../src/doubao-profile.ts'
import { invalidateQuotaCache } from '../src/doubao-quota.ts'
import { collectInboundImages, createDoubaoShim, MAX_INBOUND_IMAGES, type DoubaoShim } from '../src/doubao-shim.ts'
import {
  ATTACHMENT_BLOCK_TYPE,
  buildAttachmentBlock,
  buildChatBody,
  classifyDoubaoFailure,
  clearDoubaoImageUploadCache,
  decodeImageDataUrl,
  DOUBAO_IMAGE_LIMIT_BYTES,
  DoubaoUpstreamError,
  imagexCrc32,
  signImagexRequest,
  toImageAttachment,
  uploadDoubaoImage,
  uploadDoubaoImageAttachments,
  validateImagexHost,
} from '../src/doubao-upstream.ts'

vi.mock('../src/doubao-store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/doubao-store.ts')>()
  return {
    ...actual,
    withStoredSettings: (config: Parameters<typeof actual.withStoredSettings>[0]) => config,
    readStoredSettings: () => ({}),
  }
})

vi.mock('../src/doubao-profile.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/doubao-profile.ts')>()
  return {
    ...actual,
    listDoubaoProfiles: (deps?: Parameters<typeof actual.listDoubaoProfiles>[0]) =>
      actual.listDoubaoProfiles({
        appDataBases: [],
        processCommandLines: () => [],
        scanRoots: [],
        ...deps,
      }),
    findDoubaoUserDataDir: (deps?: Parameters<typeof actual.findDoubaoUserDataDir>[0]) =>
      actual.findDoubaoUserDataDir({
        appDataBases: [],
        processCommandLines: () => [],
        scanRoots: [],
        ...deps,
      }),
  }
})

const realFetch = globalThis.fetch

function makeCredentials(uid = 'u1'): DoubaoCredentials {
  const pairs = new Map(REQUIRED_COOKIE_NAMES.map((name) => [name, 'test']))
  pairs.set('uid_tt', uid)
  pairs.set('msToken', 'ms-1')
  pairs.set('passport_csrf_token', 'csrf-1')
  return {
    ok: true,
    header: [...pairs.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    pairs,
  }
}

const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_1X1_B64}`

function frame(event: string, data: unknown): string {
  return `id: 1\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

function parseOpenAiSse(raw: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (data === '' || data === '[DONE]') continue
    out.push(JSON.parse(data) as Record<string, any>)
  }
  return out
}

function createImagexFetchMock(options: { onPrepare?: () => Response | undefined } = {}) {
  let uploadCalls = 0
  const seenUrls: string[] = []
  const seenHeaders: Array<Record<string, string>> = []
  const stub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    seenUrls.push(url)
    seenHeaders.push((init?.headers ?? {}) as Record<string, string>)
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input as RequestInfo | URL, init)
    if (url.includes('/quota/summary/')) {
      return new Response(
        JSON.stringify({ data: { window_limit_section: { usage_exhausted: false } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/alice/resource/prepare_upload')) {
      const override = options.onPrepare?.()
      if (override !== undefined) return override
      uploadCalls += 1
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            upload_host: 'imagex.bytedanceapi.com',
            service_id: 'svc-1',
            upload_auth_token: {
              access_key: 'ak-test',
              secret_key: 'sk-test',
              session_token: 'st-test',
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('Action=ApplyImageUpload')) {
      return new Response(
        JSON.stringify({
          Result: {
            UploadAddress: {
              SessionKey: 'sess-1',
              UploadHosts: ['tos-cn-i.snssdk.com'],
              StoreInfos: [{ StoreUri: `tos-cn-i/img_${uploadCalls}.png`, Auth: 'tos-auth' }],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/upload/v1/')) {
      return new Response(JSON.stringify({ code: 2000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('Action=CommitImageUpload')) {
      return new Response(
        JSON.stringify({ Result: { Results: [{ UriStatus: 2000 }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/alice/resource/register')) {
      const uri = `tos-cn-i/img_${uploadCalls}.png`
      return new Response(
        JSON.stringify({ code: 0, data: { [uri]: { resource_id: `res_${uploadCalls}` } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`unexpected fetch url: ${url}`)
  })
  return { stub, getUploadCalls: () => uploadCalls, seenUrls, seenHeaders }
}

let shims: DoubaoShim[] = []
let tempDirs: string[] = []

beforeEach(() => {
  clearDoubaoImageUploadCache()
  invalidateDiscovery()
  invalidateQuotaCache()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  clearDoubaoImageUploadCache()
  invalidateDiscovery()
  invalidateQuotaCache()
  setProfileOverride(undefined)
  delete process.env.DSH_DOUBAO_PERSON_TASK_MODE
  for (const shim of shims.splice(0)) await shim.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ImageX helpers and upload flow', () => {
  it('decodes supported image data URLs, normalizes image/jpg, and rejects oversized payloads', () => {
    const png = decodeImageDataUrl(PNG_DATA_URL)
    expect(png?.mime).toBe('image/png')
    expect(png?.ext).toBe('png')
    expect(png?.bytes.length).toBeGreaterThan(0)

    const jpg = decodeImageDataUrl(`data:image/jpg;base64,${Buffer.from('abc').toString('base64')}`)
    expect(jpg?.mime).toBe('image/jpeg')
    expect(jpg?.ext).toBe('jpg')

    expect(decodeImageDataUrl('https://example.com/a.png')).toBeUndefined()
    expect(() => decodeImageDataUrl('data:image/png;base64,')).toThrow(DoubaoUpstreamError)

    const tooBig = Buffer.alloc(DOUBAO_IMAGE_LIMIT_BYTES + 1, 1).toString('base64')
    expect(() => decodeImageDataUrl(`data:image/png;base64,${tooBig}`)).toThrow(DoubaoUpstreamError)
  })

  it('validates ImageX hosts and generates deterministic CRC32 and AWS4 signatures', () => {
    expect(validateImagexHost('imagex.bytedanceapi.com', true)).toBe('https://imagex.bytedanceapi.com')
    expect(validateImagexHost('imagex.volcengineapi.com', true)).toBe('https://imagex.volcengineapi.com')
    expect(validateImagexHost('tos-cn.snssdk.com', false)).toBe('https://tos-cn.snssdk.com')
    expect(() => validateImagexHost('evil.com', true)).toThrow(DoubaoUpstreamError)
    expect(() => validateImagexHost('imagex.bytedanceapi.com:8443', true)).toThrow(DoubaoUpstreamError)

    expect(imagexCrc32(Buffer.from('123456789'))).toBe('cbf43926')
    const signed = signImagexRequest(
      'POST',
      'Action=CommitImageUpload&ServiceId=svc-1&Version=2018-08-01',
      { access_key: 'ak', secret_key: 'sk', session_token: 'st' },
      Buffer.from('{"SessionKey":"s"}'),
      new Date('2026-11-24T00:00:00Z'),
    )
    expect(signed['x-amz-date']).toBe('20261124T000000Z')
    expect(signed['x-amz-security-token']).toBe('st')
    expect(signed['x-amz-content-sha256']).toHaveLength(64)
    expect(signed.Authorization).toContain('AWS4-HMAC-SHA256 Credential=ak/20261124/cn-north-1/imagex/aws4_request')
    expect(signed.Authorization).toContain('SignedHeaders=x-amz-content-sha256;x-amz-date;x-amz-security-token')
  })

  it('executes the 5-step ImageX upload, isolates cache by uid_tt, and evicts past 64 entries', async () => {
    const mock = createImagexFetchMock()
    vi.stubGlobal('fetch', mock.stub)

    const credA = makeCredentials('user-a')
    const credB = makeCredentials('user-b')

    const first = await uploadDoubaoImageAttachments(credA, [PNG_DATA_URL])
    const cached = await uploadDoubaoImageAttachments(credA, [PNG_DATA_URL])
    expect(first).toHaveLength(1)
    expect(cached[0]?.image.uri).toBe(first[0]?.image.uri)
    expect(mock.getUploadCalls()).toBe(1)

    const otherAccount = await uploadDoubaoImageAttachments(credB, [PNG_DATA_URL])
    expect(otherAccount[0]?.image.uri).not.toBe(first[0]?.image.uri)
    expect(mock.getUploadCalls()).toBe(2)

    const csrfHeader = mock.seenHeaders.find((h) => h['x-tt-passport-csrf-token'] !== undefined)
    expect(csrfHeader?.['x-tt-passport-csrf-token']).toBe('csrf-1')
    const uploadHeaders = mock.seenHeaders.find((h) => h['Content-CRC32'] !== undefined)
    expect(uploadHeaders?.['Content-CRC32']).toMatch(/^[0-9a-f]{8}$/)

    for (let i = 0; i < 65; i += 1) {
      const uniqueUrl = `data:image/png;base64,${Buffer.from(`img-${i}`).toString('base64')}`
      await uploadDoubaoImageAttachments(credA, [uniqueUrl])
    }
    expect(mock.getUploadCalls()).toBe(67)
  })

  it('classifies HTTP 401, HTTP 502, and 710022004 upload failures accurately', async () => {
    const creds = makeCredentials('user-err')
    const decoded = decodeImageDataUrl(PNG_DATA_URL)!

    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))
    await expect(uploadDoubaoImage(creds, decoded)).rejects.toSatisfy(
      (err: unknown) => err instanceof DoubaoUpstreamError && classifyDoubaoFailure(err) === 'session_dead',
    )

    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })))
    await expect(uploadDoubaoImage(creds, decoded)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DoubaoUpstreamError &&
        err.rateLimited === false &&
        classifyDoubaoFailure(err) === 'upstream',
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 710022004 }), { status: 200 })),
    )
    await expect(uploadDoubaoImage(creds, decoded)).rejects.toSatisfy(
      (err: unknown) => err instanceof DoubaoUpstreamError && classifyDoubaoFailure(err) === 'rate_limited',
    )
  })

  it('prepends block_type 10052 attachment block before text_block in buildChatBody', () => {
    const attachment = toImageAttachment({
      uri: 'tos-cn-i/abc.png',
      identifier: 'id123',
      name: 'image-1.png',
      mime: 'image/png',
    })
    const block = buildAttachmentBlock([attachment])
    expect(block.block_type).toBe(ATTACHMENT_BLOCK_TYPE)

    const body = buildChatBody('看图', { attachments: [attachment] })
    expect(body.messages[0]?.content_block).toHaveLength(2)
    expect(body.messages[0]?.content_block[0]?.block_type).toBe(10052)
    expect(body.messages[0]?.content_block[1]?.block_type).toBe(10000)
  })
})

describe('collectInboundImages and shim multi-turn image + router integration', () => {
  it('collects all supported base64 image shapes and caps at last 4 images', () => {
    const urls = [
      { type: 'image_url', image_url: { url: 'https://example.com/ignored.png' } },
      { type: 'image_url', image_url: { url: PNG_DATA_URL } },
      { type: 'input_image', image_url: `data:image/jpeg;base64,${PNG_1X1_B64}` },
      { type: 'input_image', image_url: { url: `data:image/webp;base64,${PNG_1X1_B64}` } },
      { type: 'image', data: PNG_1X1_B64, mimeType: 'image/gif' },
      { type: 'image', source: { type: 'base64', data: PNG_1X1_B64, media_type: 'image/png' } },
    ]
    const collected = collectInboundImages([{ role: 'user', content: urls }])
    expect(collected).toHaveLength(MAX_INBOUND_IMAGES)
    expect(collected[0]).toMatch(/^data:image\/jpeg;base64,/)
    expect(collected[3]).toMatch(/^data:image\/png;base64,/)
  })

  it('uploads outgoing images, preserves continuation, and maps @N tool calls with non-empty ids', async () => {
    const creds = makeCredentials('shim-user')
    const chatBodies: Array<Record<string, any>> = []
    let uploadCount = 0

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.startsWith('http://127.0.0.1:')) return realFetch(input as RequestInfo | URL, init)
        if (url.includes('/quota/summary/')) {
          return new Response(
            JSON.stringify({ data: { window_limit_section: { usage_exhausted: false } } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('/alice/resource/prepare_upload')) {
          uploadCount += 1
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                upload_host: 'imagex.bytedanceapi.com',
                service_id: 'svc-1',
                upload_auth_token: { access_key: 'ak', secret_key: 'sk', session_token: 'st' },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('Action=ApplyImageUpload')) {
          return new Response(
            JSON.stringify({
              Result: {
                UploadAddress: {
                  SessionKey: 'sess',
                  UploadHosts: ['tos-cn-i.snssdk.com'],
                  StoreInfos: [{ StoreUri: `tos-cn-i/u_${uploadCount}.png`, Auth: 'a' }],
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('/upload/v1/')) return new Response(JSON.stringify({ code: 2000 }), { status: 200 })
        if (url.includes('Action=CommitImageUpload')) {
          return new Response(JSON.stringify({ Result: { Results: [{ UriStatus: 2000 }] } }), { status: 200 })
        }
        if (url.includes('/alice/resource/register')) {
          return new Response(
            JSON.stringify({ code: 0, data: { [`tos-cn-i/u_${uploadCount}.png`]: { resource_id: 'r1' } } }),
            { status: 200 },
          )
        }
        if (url.includes('/chat/completion')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
          chatBodies.push(body)
          const isTurn1 = chatBodies.length === 1
          const text = isTurn1 ? '@1 {"q":"pelican"}' : '这是一张带有工具返图的回答。'
          return sseResponse([
            frame('SSE_ACK', { ack_client_meta: { conversation_id: 'conv-img-1' } }),
            frame('STREAM_CHUNK', {
              block_type: 10000,
              block_id: `b-${chatBodies.length}`,
              parent_id: '',
              content: { text_block: { text } },
            }),
            frame('SSE_REPLY_END', { end_type: 1 }),
          ])
        }
        throw new Error(`unexpected url: ${url}`)
      }),
    )

    const shim = createDoubaoShim({ resolveCredentials: () => creds, toolEmulation: () => true })
    shims.push(shim)
    const base = await shim.baseUrl()
    const headers = { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' }
    const tools = Array.from({ length: 20 }, (_, i) => ({
      type: 'function',
      function: {
        name: i === 0 ? 'web_search' : `tool_${i}`,
        description: `tool ${i}`,
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
    }))

    // Turn 1: stream=true with image-only user turn + 20 tools
    const turn1Messages = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_DATA_URL } }] },
    ]
    const res1 = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: '0', stream: true, tools, messages: turn1Messages }),
    })
    expect(res1.status).toBe(200)
    const sse1 = parseOpenAiSse(await res1.text())
    const contentChunks1 = sse1.filter((c) => c.choices?.[0]?.delta?.content !== undefined)
    expect(contentChunks1).toHaveLength(0)
    const toolChunk1 = sse1.find((c) => Array.isArray(c.choices?.[0]?.delta?.tool_calls))
    expect(toolChunk1?.choices?.[0]?.delta?.tool_calls?.[0]?.id).toMatch(/^call_/)
    expect(toolChunk1?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name).toBe('web_search')
    expect(sse1.some((c) => c.choices?.[0]?.finish_reason === 'tool_calls')).toBe(true)

    expect(chatBodies[0]?.messages?.[0]?.content_block?.[0]?.block_type).toBe(10052)
    expect(chatBodies[0]?.messages?.[0]?.content_block?.[1]?.content?.text_block?.text).toContain('请查看并描述这张图片。')
    expect(chatBodies[0]?.messages?.[0]?.content_block?.[1]?.content?.text_block?.text).toContain('#1 web_search')

    // Turn 2: continuation with tool result + synthetic user image (different bytes)
    const secondPng = `data:image/png;base64,${Buffer.from('second-img').toString('base64')}`
    const turn2Messages = [
      ...turn1Messages,
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q":"pelican"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'web_search', content: 'result ok' },
      { role: 'user', content: [{ type: 'image', data: Buffer.from('second-img').toString('base64'), mimeType: 'image/png' }] },
    ]
    const res2 = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: '0', stream: false, tools, messages: turn2Messages }),
    })
    expect(res2.status).toBe(200)
    expect(uploadCount).toBe(2)
    expect(chatBodies[1]?.option?.need_create_conversation).toBe(false)
    expect(chatBodies[1]?.client_meta?.conversation_id).toBe('conv-img-1')
    // Only the new outgoing image is uploaded in Turn 2 (1 attachment, not 2).
    expect(chatBodies[1]?.messages?.[0]?.content_block?.[0]?.content?.attachment_block?.attachments).toHaveLength(1)
    expect(secondPng).toContain('data:image/png;base64,')
  })

  it('returns HTTP 401 and 429 RISK_CHALLENGE when inbound image upload fails with auth or risk errors', async () => {
    const creds = makeCredentials('err-shim')
    const shim = createDoubaoShim({ resolveCredentials: () => creds })
    shims.push(shim)
    const base = await shim.baseUrl()
    const headers = { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' }
    const payload = JSON.stringify({
      model: '0',
      stream: false,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_DATA_URL } }, { type: 'text', text: 'hi' }] }],
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.startsWith('http://127.0.0.1:')) return realFetch(input as RequestInfo | URL, init)
        if (url.includes('/quota/summary/')) {
          return new Response(JSON.stringify({ data: { window_limit_section: { usage_exhausted: false } } }), { status: 200 })
        }
        return new Response('unauthorized', { status: 401 })
      }),
    )
    const res401 = await realFetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: payload })
    expect(res401.status).toBe(401)

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.startsWith('http://127.0.0.1:')) return realFetch(input as RequestInfo | URL, init)
        if (url.includes('/quota/summary/')) {
          return new Response(JSON.stringify({ data: { window_limit_section: { usage_exhausted: false } } }), { status: 200 })
        }
        return new Response(JSON.stringify({ code: 710022004 }), { status: 200 })
      }),
    )
    const res429 = await realFetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: payload })
    expect(res429.status).toBe(429)
    const errBody = (await res429.json()) as { error?: { code?: string } }
    expect(errBody.error?.code).toBe('RISK_CHALLENGE')
  })
})

describe('modalities, adapter attachment resolvers, and person-* chat mode', () => {
  it('advertises image input only for non-task, non-image-gen models and aligns budgets', () => {
    expect(modelInputModalities({ id: '0' })).toEqual(['text', 'image'])
    expect(modelInputModalities({ id: 'person-deepseek-v4-1-flash-261017' })).toEqual(['text', 'image'])
    expect(modelInputModalities({ id: '5', taskMode: true })).toEqual(['text'])
    expect(modelInputModalities({ id: DOUBAO_IMAGE_MODEL_ID })).toEqual(['text'])

    expect(REQUEST_IMAGE_BUDGETS.maxRequestImages).toBe(4)
    expect(REQUEST_IMAGE_BUDGETS.maxRequestImageBytes).toBe(12 * 1024 * 1024)
    expect(REQUEST_IMAGE_BUDGETS.imageOffloadCountQuantum).toBe(1)
  })

  it('forwards resolveAttachments and resolveImageAccess through createDoubaoAdapter and apply()', async () => {
    const fakeAttachments = { get: vi.fn() }
    const resolveAttachments = () => fakeAttachments
    const resolveImageAccess = vi.fn(() => undefined)
    const fakeShim = {
      baseUrlSync: () => 'http://127.0.0.1:45678',
      baseUrl: async () => 'http://127.0.0.1:45678',
      token: () => 'secret',
      stats: () => ({} as any),
      resetStats: () => {},
      close: async () => {},
    }
    const { adapter } = createDoubaoAdapter({
      shim: fakeShim,
      resolveAttachments,
      resolveImageAccess,
    })
    const models = await adapter.listModels('doubao')
    expect(models.find((m) => m.id === '0')?.inputModalities).toEqual(['text', 'image'])
    expect(models.find((m) => m.id === '5')?.inputModalities).toEqual(['text'])
    expect(models.find((m) => m.id === DOUBAO_IMAGE_MODEL_ID)?.inputModalities).toEqual(['text'])
    const adapterConfig = (adapter as unknown as {
      config?: { resolveAttachments?: () => unknown; resolveImageAccess?: unknown }
    }).config
    expect(adapterConfig?.resolveAttachments?.()).toBe(fakeAttachments)
    expect(adapterConfig?.resolveImageAccess).toBe(resolveImageAccess)

    let discoveredModalities: Array<{ id: string; inputModalities: ('text' | 'image')[] }> = []
    let discoveryDone: Promise<void> | undefined
    let registeredAdapter: unknown
    let dispose: (() => void) | undefined
    const ctx: DoubaoPluginContext = {
      llm: {
        registerAdapter: (_ids, registered) => {
          registeredAdapter = registered
          return Object.assign(() => {}, { replace: () => {} })
        },
        registerConfigurableProviders: () => () => {},
        registerModelDiscovery: (_ns, fn) => {
          discoveryDone = fn({}).then((items) => {
            discoveredModalities = items
          })
          return () => {}
        },
      },
      inject: () => {},
      on: () => {},
      effect: (fn) => {
        dispose = fn() || undefined
      },
      logger: { error: () => {} },
      get: (service) => (service === 'attachments' ? fakeAttachments : undefined),
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    apply(ctx)
    await discoveryDone
    dispose?.()
    const registeredConfig = (registeredAdapter as { config?: { resolveAttachments?: () => unknown } } | undefined)?.config
    expect(registeredConfig?.resolveAttachments?.()).toBe(fakeAttachments)
    expect(discoveredModalities.find((m) => m.id === '0')?.inputModalities).toEqual(['text', 'image'])
    expect(discoveredModalities.find((m) => m.id === '5')?.inputModalities).toEqual(['text'])
    expect(discoveredModalities.find((m) => m.id === DOUBAO_IMAGE_MODEL_ID)?.inputModalities).toEqual(['text'])
  })

  it('treats discovered person-* models as chat mode by default with env opt-out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doubao-person-'))
    tempDirs.push(dir)
    const userData = join(dir, 'User Data')
    mkdirSync(join(userData, 'Default', 'Network'), { recursive: true })
    writeFileSync(join(userData, 'Default', 'Network', 'Cookies'), 'sqlite', 'utf8')
    writeFileSync(
      join(userData, 'Default', 'Preferences'),
      JSON.stringify({
        saman: {
          local_storage_for_web: {
            'frontend-request-cache': JSON.stringify({
              BriefListRequestCache_main: {
                data: {
                  modeSelectData: {
                    menuConfV2: {
                      model_list: {
                        item_list: [
                          { model_item_key: '0', name: '豆包 快速', default_mode: '1' },
                          { model_item_key: 'person-deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', default_mode: '3' },
                        ],
                      },
                    },
                  },
                },
              },
            }),
          },
        },
      }),
      'utf8',
    )
    setProfileOverride(userData)

    const chatModels = discoverModels()
    const personChat = chatModels?.find((m) => m.id === 'person-deepseek-v4-1-flash-261017')
    expect(personChat?.taskMode).toBeUndefined()

    process.env.DSH_DOUBAO_PERSON_TASK_MODE = '1'
    const taskModels = discoverModels()
    const personTask = taskModels?.find((m) => m.id === 'person-deepseek-v4-1-flash-261017')
    expect(personTask?.taskMode).toBe(true)
  })
})
