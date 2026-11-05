/**
 * How a stream ENDS, and what a failure is allowed to claim about itself.
 *
 * Two regressions are pinned here, both of which failed silently:
 *
 *  - A stream that closed without `SSE_REPLY_END` was treated as a complete
 *    answer. The half-received text was returned and the shim wrote
 *    `finish_reason: "stop"` + `[DONE]`, so a truncated reply looked exactly
 *    like a finished one.
 *  - Every unrecognised failure was classified `network`, i.e. "check your
 *    connection", and the shim gave it the retryable code `TIMEOUT`. An HTTP
 *    400 or an internal bug therefore burned the host's whole retry budget
 *    before failing with the wrong advice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REQUIRED_COOKIE_NAMES, type DoubaoCredentials } from '../src/doubao-auth.ts'
import {
  classifyDoubaoFailure,
  DoubaoUpstreamError,
  isRetryableFailure,
  streamChat,
} from '../src/doubao-upstream.ts'

const credentials: DoubaoCredentials = {
  ok: true,
  header: 'sessionid=test',
  pairs: new Map(REQUIRED_COOKIE_NAMES.map((name) => [name, 'test-value'])),
}

/** One ByteDance frame: `id:` / `event:` / `data:` then a blank line. */
function frame(event: string, data: unknown): string {
  return `id: 1\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function textBlock(text: string, options: { blockId?: string; parentId?: string; blockType?: number } = {}): unknown {
  return {
    block_type: options.blockType ?? 10000,
    block_id: options.blockId ?? 'answer-1',
    parent_id: options.parentId ?? '',
    content: { text_block: { text } },
  }
}

/** A 200 SSE response whose body is exactly these chunks. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const ACK = frame('SSE_ACK', { ack_client_meta: { conversation_id: 'conv-1' } })
const END = frame('SSE_REPLY_END', {})

function stubFetch(make: () => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(make))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('terminal verdict', () => {
  it('resolves a reply that ends with SSE_REPLY_END', async () => {
    stubFetch(() => sseResponse([ACK, frame('STREAM_CHUNK', textBlock('你好')), END]))
    const result = await streamChat('hi', { credentials })
    expect(result.text).toBe('你好')
    expect(result.conversationId).toBe('conv-1')
  })

  it('rejects a reply whose stream closed early instead of returning half of it', async () => {
    stubFetch(() => sseResponse([ACK, frame('STREAM_CHUNK', textBlock('一加一'))]))
    const error = await streamChat('hi', { credentials }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DoubaoUpstreamError)
    const failure = error as DoubaoUpstreamError
    expect(failure.truncated).toBe(true)
    expect(failure.message).toMatch(/incomplete/)
    expect(failure.message).toMatch(/3 characters/)
    // A retry would open a NEW thread and silently abandon this one, so the
    // partial answer is reported instead of being re-requested.
    expect(isRetryableFailure(failure)).toBe(false)
  })

  it('decodes a terminating frame split across two chunks', async () => {
    // The wire has no frame length: a frame may arrive in pieces, and only the
    // blank line closes it. Reading the verdict from a stale buffer is how a
    // finished reply gets reported as truncated (or the reverse).
    const split = frame('SSE_REPLY_END', {})
    const half = Math.floor(split.length / 2)
    stubFetch(() => sseResponse([ACK, frame('STREAM_CHUNK', textBlock('完整')), split.slice(0, half), split.slice(half)]))
    const result = await streamChat('hi', { credentials })
    expect(result.text).toBe('完整')
  })

  it('forwards deep-think deltas to the caller', async () => {
    // onThinking was missing from the wrapper that streamChat builds, so every
    // reasoning delta died between consumeStream and the shim.
    const thinking = [
      frame('SSE_ACK', { ack_client_meta: { conversation_id: 'conv-2' } }),
      frame('STREAM_CHUNK', textBlock('', { blockType: 10040, blockId: 'think-1' })),
      frame('STREAM_CHUNK', textBlock('推理中', { blockId: 'think-2', parentId: 'think-1' })),
      frame('STREAM_CHUNK', textBlock('答案')),
      END,
    ]
    stubFetch(() => sseResponse(thinking))
    const deltas: string[] = []
    const result = await streamChat('hi', {
      credentials,
      callbacks: { onThinking: (delta) => deltas.push(delta) },
    })
    expect(deltas.join('')).toBe('推理中')
    expect(result.text).toBe('答案')
    expect(result.reasoningText).toBe('推理中')
  })
})

describe('failure classification', () => {
  it('treats a 401 as a dead session, not a network problem', () => {
    const error = new DoubaoUpstreamError('nope', undefined, false, { httpStatus: 401 })
    expect(classifyDoubaoFailure(error)).toBe('session_dead')
    expect(isRetryableFailure(error)).toBe(false)
  })

  it('treats a 429 as exhausted quota', () => {
    const error = new DoubaoUpstreamError('slow down', undefined, false, { httpStatus: 429 })
    expect(classifyDoubaoFailure(error)).toBe('quota_exhausted')
    expect(isRetryableFailure(error)).toBe(false)
  })

  it('retries a 5xx but not a 4xx', () => {
    const server = new DoubaoUpstreamError('boom', undefined, false, { httpStatus: 503 })
    expect(classifyDoubaoFailure(server)).toBe('upstream')
    expect(isRetryableFailure(server)).toBe(true)

    const client = new DoubaoUpstreamError('bad request', undefined, false, { httpStatus: 400 })
    expect(classifyDoubaoFailure(client)).toBe('upstream')
    expect(isRetryableFailure(client)).toBe(false)
  })

  it('labels a transport failure as network and retryable', () => {
    const error = new DoubaoUpstreamError('socket hang up', undefined, false, { transport: true })
    expect(classifyDoubaoFailure(error)).toBe('network')
    expect(isRetryableFailure(error)).toBe(true)
  })

  it('does not call an unrecognised upstream error a network failure', () => {
    const error = new DoubaoUpstreamError('empty completion')
    expect(classifyDoubaoFailure(error)).toBe('upstream')
    expect(isRetryableFailure(error)).toBe(false)
  })

  it('never retries something that is not an upstream failure at all', () => {
    expect(isRetryableFailure(new TypeError('x is not a function'))).toBe(false)
  })

  it('reports missing credentials as a dead session', async () => {
    stubFetch(() => sseResponse([END]))
    const error = await streamChat('hi', {
      credentials: { ok: false, reason: 'not signed in', header: '', pairs: new Map() },
    }).catch((caught: unknown) => caught)
    expect(classifyDoubaoFailure(error as DoubaoUpstreamError)).toBe('session_dead')
  })

  it('wraps a refused connection as a retryable transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))))
    const error = await streamChat('hi', { credentials }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DoubaoUpstreamError)
    expect(classifyDoubaoFailure(error as DoubaoUpstreamError)).toBe('network')
    expect(isRetryableFailure(error)).toBe(true)
  })
})