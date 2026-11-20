import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDoubaoShim } from '../src/doubao-shim.ts'
import { REQUIRED_COOKIE_NAMES, type DoubaoCredentials } from '../src/doubao-auth.ts'
import { invalidateDiscovery } from '../src/doubao-discovery.ts'
import { invalidateQuotaCache } from '../src/doubao-quota.ts'

// HTTP-level tests must not depend on a local Doubao login (same contract as
// fixes-regression.test.ts): chat resolves credentials itself per call.
vi.mock('../src/doubao-auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/doubao-auth.ts')>()
  const fake: DoubaoCredentials = {
    ok: true,
    header: actual.REQUIRED_COOKIE_NAMES.map((name) => `${name}=test`).join('; '),
    pairs: new Map(actual.REQUIRED_COOKIE_NAMES.map((name) => [name, 'test'])),
  }
  return { ...actual, loadDoubaoCredentials: () => fake }
})

const credentials: DoubaoCredentials = {
  ok: true,
  header: REQUIRED_COOKIE_NAMES.map((name) => `${name}=test`).join('; '),
  pairs: new Map(REQUIRED_COOKIE_NAMES.map((name) => [name, 'test'])),
}

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

function quotaOk(): Response {
  return new Response(JSON.stringify({ data: { window_limit_section: { usage_exhausted: false } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function stopAck(): Response {
  return new Response(JSON.stringify({ status_code: 0 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

interface StopCall {
  url: string
  body: Record<string, any>
  headers: Record<string, string>
}

let shims: Array<{ close: () => Promise<void> }> = []

beforeEach(() => {
  invalidateDiscovery()
  invalidateQuotaCache()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const shim of shims.splice(0)) {
    await shim.close()
  }
})

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** The exact break_stream_msg contract both independent implementations send. */
function expectStopShape(call: StopCall, ids: { reply_msg_id: string; conversation_id: string }): void {
  expect(call.url).toContain('https://www.doubao.com/im/message/break_stream_msg')
  expect(call.headers['content-type']).toContain('application/json')
  expect(call.body.cmd).toBe(2240)
  expect(call.body.channel).toBe(2)
  expect(call.body.version).toBe('1')
  expect(typeof call.body.sequence_id).toBe('string')
  expect(call.body.sequence_id.length).toBeGreaterThan(0)
  expect(call.body.uplink_body.break_stream_msg_uplink_body).toEqual({
    reply_msg_id: ids.reply_msg_id,
    message_id: '',
    conversation_id: ids.conversation_id,
    conversation_type: 3,
    break_reason: 7,
  })
}

describe('server-side stop generation (break_stream_msg)', () => {
  it('stops the in-flight turn exactly once when the client disconnects mid-stream', async () => {
    const stops: StopCall[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
        if (url.includes('/quota/summary/')) return quotaOk()
        if (url.includes('/im/message/break_stream_msg')) {
          stops.push({
            url,
            body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
            headers: (init?.headers ?? {}) as Record<string, string>,
          })
          return stopAck()
        }
        if (url.includes('/chat/completion')) {
          // A turn that never finishes server-side: ack + first delta, then it
          // hangs until the local signal aborts it — exactly the "client went
          // away but Doubao keeps thinking" situation.
          const encoder = new TextEncoder()
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    frame('SSE_ACK', {
                      ack_client_meta: { conversation_id: 'conv-live' },
                      query_list: [{ question_id: 'q-live' }],
                    }),
                  ),
                )
                controller.enqueue(
                  encoder.encode(
                    frame('STREAM_CHUNK', {
                      block_type: 10000,
                      block_id: 'txt-1',
                      content: { text_block: { text: '正在写' } },
                    }),
                  ),
                )
                init?.signal?.addEventListener(
                  'abort',
                  () => {
                    try {
                      controller.error(new Error('upstream aborted'))
                    } catch {
                      // already closed
                    }
                  },
                  { once: true },
                )
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }
        throw new Error(`unexpected fetch url: ${url}`)
      }),
    )

    const shim = createDoubaoShim({ resolveCredentials: () => credentials })
    shims.push(shim)
    const base = await shim.baseUrl()

    const controller = new AbortController()
    const res = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${shim.token()}`,
      },
      body: JSON.stringify({
        model: '3',
        stream: true,
        messages: [{ role: 'user', content: '写一篇长文' }],
      }),
      signal: controller.signal,
    })
    expect(res.status).toBe(200)

    // Read until the first content delta: the shim only forwards it after the
    // SSE_ACK was parsed, so the turn ids are known by now.
    const reader = res.body?.getReader()
    expect(reader).toBeTruthy()
    const decoder = new TextDecoder()
    let seen = ''
    while (reader && !seen.includes('"content"')) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value)
    }
    expect(seen).toContain('"content"')

    // The client goes away while the model is still generating.
    controller.abort()
    await until(() => stops.length > 0)

    expect(stops).toHaveLength(1)
    expectStopShape(stops[0]!, { reply_msg_id: 'q-live', conversation_id: 'conv-live' })

    // The once-guard holds: no duplicate stop from the error tail.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(stops).toHaveLength(1)
  })

  it('never fires the stop for a turn that completed normally', async () => {
    const stops: StopCall[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
        if (url.includes('/quota/summary/')) return quotaOk()
        if (url.includes('/im/message/break_stream_msg')) {
          stops.push({
            url,
            body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
            headers: (init?.headers ?? {}) as Record<string, string>,
          })
          return stopAck()
        }
        if (url.includes('/chat/completion')) {
          // Ids ARE published here — completing normally must still not stop.
          return sseResponse([
            frame('SSE_ACK', {
              ack_client_meta: { conversation_id: 'conv-done' },
              query_list: [{ question_id: 'q-done' }],
            }),
            frame('STREAM_CHUNK', {
              block_type: 10000,
              block_id: 'txt-1',
              content: { text_block: { text: '好的' } },
            }),
            frame('SSE_REPLY_END', {}),
          ])
        }
        throw new Error(`unexpected fetch url: ${url}`)
      }),
    )

    const shim = createDoubaoShim({ resolveCredentials: () => credentials })
    shims.push(shim)
    const base = await shim.baseUrl()

    const res = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${shim.token()}`,
      },
      body: JSON.stringify({
        model: '3',
        stream: true,
        messages: [{ role: 'user', content: '你好' }],
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('好的')

    // Give the (mis)fired abort path every chance, then prove it stayed quiet.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(stops).toHaveLength(0)
  })

  it('stops the rejected thread before the 710020202 fallback re-issues', async () => {
    const stops: StopCall[] = []
    const capturedBodies: Array<Record<string, any>> = []
    const realFetch = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
        if (url.includes('/quota/summary/')) return quotaOk()
        if (url.includes('/im/message/break_stream_msg')) {
          stops.push({
            url,
            body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
            headers: (init?.headers ?? {}) as Record<string, string>,
          })
          return stopAck()
        }
        if (url.includes('/chat/completion')) {
          capturedBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, any>)
          if (capturedBodies.length === 2) {
            // The remembered thread was accepted by the wire (ack carries the
            // turn ids) and then rejected as invalid — the case where Doubao
            // keeps thinking on the stale thread while we re-issue.
            return sseResponse([
              frame('SSE_ACK', {
                ack_client_meta: { conversation_id: 'conv-stale' },
                query_list: [{ question_id: 'q-stale' }],
              }),
              frame('STREAM_ERROR', { error_code: 710020202, error_msg: 'common invalid param' }),
            ])
          }
          const conversationId = capturedBodies.length === 1 ? 'conv-stale' : 'conv-fresh'
          const questionId = capturedBodies.length === 1 ? 'q-turn1' : 'q-fresh'
          return sseResponse([
            frame('SSE_ACK', {
              ack_client_meta: { conversation_id: conversationId },
              query_list: [{ question_id: questionId }],
            }),
            frame('STREAM_CHUNK', {
              block_type: 10000,
              block_id: 'txt-1',
              content: { text_block: { text: '好的' } },
            }),
            frame('SSE_REPLY_END', {}),
          ])
        }
        throw new Error(`unexpected fetch url: ${url}`)
      }),
    )

    const shim = createDoubaoShim({ resolveCredentials: () => credentials })
    shims.push(shim)
    const base = await shim.baseUrl()
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${shim.token()}`,
    }

    // Turn 1 (non-stream): remembers conv-stale.
    const res1 = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: '3', stream: false, messages: [{ role: 'user', content: '先聊两句' }] }),
    })
    expect(res1.status).toBe(200)

    // Turn 2 (stream): continues conv-stale, gets 710020202, falls back.
    const res2 = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: '3',
        stream: true,
        messages: [
          { role: 'user', content: '先聊两句' },
          { role: 'assistant', content: '好的' },
          { role: 'user', content: '继续' },
        ],
      }),
    })
    expect(res2.status).toBe(200)
    expect(await res2.text()).toContain('好的')
    await until(() => stops.length > 0)

    // Exactly the stale thread is stopped — the fresh re-issue is untouched.
    expect(stops).toHaveLength(1)
    expectStopShape(stops[0]!, { reply_msg_id: 'q-stale', conversation_id: 'conv-stale' })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(stops).toHaveLength(1)
    // The re-issue really happened (fresh conversation, same turn).
    expect(capturedBodies).toHaveLength(3)
    expect(capturedBodies[2]?.option?.need_create_conversation).toBe(true)
  })
})
