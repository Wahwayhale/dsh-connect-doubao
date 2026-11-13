import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REQUIRED_COOKIE_NAMES, type DoubaoCredentials } from '../src/doubao-auth.ts'
import { DoubaoStatsTracker } from '../src/doubao-stats.ts'
import { DOUBAO_STATS_PATH, registerDoubaoStatsRoute } from '../src/doubao-status.ts'
import { resolveChatUsage } from '../src/doubao-tokens.ts'
import { streamChat } from '../src/doubao-upstream.ts'

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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DoubaoStatsTracker', () => {
  it('accumulates totals, per-model, per-session LRU, and upstream telemetry, and resets cleanly', () => {
    const tracker = new DoubaoStatsTracker(2, 1000)

    const usage1 = resolveChatUsage({
      messages: [{ role: 'user', content: '你好世界' }],
      answerText: '你好，我可以帮你。',
      reasoningText: '打个招呼',
    })
    tracker.recordSuccess({
      model: '5',
      sessionKey: 'sess-a',
      stream: true,
      continuation: false,
      usage: usage1,
      ttftMs: 400,
      durationMs: 2400,
      decodeMs: 2000,
      upstreamContextWindow: {
        systemPrompt: 6640,
        messages: 13910,
        skills: 0,
        tools: 35639,
        totalWindowSize: 256000,
        totalUsed: 56189,
      },
      upstreamFirstPacketMs: 2922,
      upstreamAckMs: 266,
      now: 2000,
    })

    const usage2 = resolveChatUsage({
      messages: [
        { role: 'user', content: '你好世界' },
        { role: 'assistant', content: '你好，我可以帮你。' },
        { role: 'user', content: '继续' },
      ],
      cachedPrefixMessages: 1,
      answerText: '好的。',
    })
    tracker.recordSuccess({
      model: '5',
      sessionKey: 'sess-a',
      stream: true,
      continuation: true,
      usage: usage2,
      ttftMs: 200,
      durationMs: 1200,
      decodeMs: 1000,
      now: 3000,
    })

    // LRU cap of 2 evicts oldest when 2 more sessions arrive.
    tracker.recordSuccess({
      model: '3',
      sessionKey: 'sess-b',
      stream: false,
      continuation: false,
      usage: usage1,
      ttftMs: null,
      durationMs: 500,
      decodeMs: 0,
      now: 4000,
    })
    tracker.recordSuccess({
      model: '3',
      sessionKey: 'sess-c',
      stream: false,
      continuation: false,
      usage: usage1,
      ttftMs: null,
      durationMs: 500,
      decodeMs: 0,
      now: 5000,
    })
    tracker.recordFailure({ model: '3', durationMs: 300, now: 6000 })

    const view = tracker.snapshot(2)
    expect(view.ok).toBe(true)
    expect(view.activeConversations).toBe(2)
    expect(view.totals.requests).toBe(5)
    expect(view.totals.succeeded).toBe(4)
    expect(view.totals.failed).toBe(1)
    expect(view.totals.continuations).toBe(1)
    expect(view.totals.avgTtftMs).toBe(300)
    expect(view.totals.decodeMs).toBe(3000)
    expect(view.totals.avgTps).toBeCloseTo(
      Number(((usage1.completionTokens + usage2.completionTokens) / 3).toFixed(1)),
      1,
    )
    expect(view.sessions.map((s) => s.sessionKey)).toEqual(['sess-c', 'sess-b'])
    expect(view.byModel).toHaveLength(2)
    expect(view.lastTurn?.model).toBe('3')

    tracker.reset(7000)
    const empty = tracker.snapshot(0)
    expect(empty.startedAt).toBe(7000)
    expect(empty.totals.requests).toBe(0)
    expect(empty.byModel).toHaveLength(0)
    expect(empty.sessions).toHaveLength(0)
    expect(empty.lastTurn).toBeNull()
  })
})

describe('upstream telemetry parsing in consumeStream', () => {
  it('extracts context_window_usage, tea_tags_time_cost, finish_time_ms, and finish_reason_chat from STREAM_CHUNK patch_op ext', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          frame('SSE_ACK', { ack_client_meta: { conversation_id: 'conv-tel' } }),
          frame('STREAM_CHUNK', {
            patch_op: [
              {
                patch_object: 50,
                patch_type: 1,
                patch_value: {
                  ext: {
                    tea_tags_time_cost: JSON.stringify({ ack_cost_time: '266', first_packet_cost_time: '2922' }),
                    // Malformed JSON on an intermediate frame must not fail the turn.
                    context_window_usage: '{bad-json',
                  },
                },
              },
            ],
          }),
          frame('STREAM_CHUNK', {
            patch_op: [
              {
                patch_object: 1,
                patch_type: 1,
                patch_value: {
                  content_block: [{ block_type: 10000, block_id: 'ans-1', content: { text_block: { text: '9.9 更大。' } } }],
                },
              },
              {
                patch_object: 50,
                patch_type: 1,
                patch_value: {
                  ext: {
                    context_window_usage: JSON.stringify({
                      system_prompt: 6640,
                      messages: 13910,
                      skills: 0,
                      tools: 35639,
                      total_window_size: 256000,
                    }),
                    finish_time_ms: '1794026261299',
                    finish_reason_chat: 'succeed:completion',
                  },
                },
              },
            ],
          }),
          frame('SSE_REPLY_END', { end_type: 1 }),
        ]),
      ),
    )

    const result = await streamChat('9.11 和 9.9 哪个大', { credentials })
    expect(result.text).toBe('9.9 更大。')
    expect(result.telemetry).toEqual({
      ackCostMs: 266,
      firstPacketCostMs: 2922,
      contextWindowUsage: {
        systemPrompt: 6640,
        messages: 13910,
        skills: 0,
        tools: 35639,
        totalWindowSize: 256000,
        totalUsed: 56189,
      },
      finishTimeMs: 1794026261299,
      finishReasonChat: 'succeed:completion',
    })
  })
})

describe('registerDoubaoStatsRoute', () => {
  it('serves GET stats and handles guarded POST reset', async () => {
    const tracker = new DoubaoStatsTracker(8, 100)
    tracker.recordSuccess({
      model: '3',
      sessionKey: 's1',
      stream: true,
      continuation: false,
      usage: resolveChatUsage({ messages: [{ role: 'user', content: 'hi' }], answerText: 'hello' }),
      ttftMs: 120,
      durationMs: 320,
      decodeMs: 200,
      now: 200,
    })

    let registeredPath: string | undefined
    let handler: ((req: IncomingMessage, res: ServerResponse) => void | Promise<void>) | undefined
    registerDoubaoStatsRoute(
      {
        webServer: {
          register(route) {
            registeredPath = route.path
            handler = route.handler
            return () => { handler = undefined }
          },
        },
      },
      {
        read: () => tracker.snapshot(1),
        reset: () => tracker.reset(999),
      },
    )

    expect(registeredPath).toBe(DOUBAO_STATS_PATH)

    const invoke = async (
      method: string,
      body?: unknown,
      extraHeaders: Record<string, string> = {},
      withWrite = true,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const headers: Record<string, string> = {
        host: '127.0.0.1:63052',
        ...(method === 'POST' && withWrite ? { 'x-dsh-doubao-write': '1' } : {}),
        ...extraHeaders,
      }
      const req = {
        method,
        headers,
        async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
      } as unknown as IncomingMessage
      const out = { status: 0, body: {} as Record<string, unknown> }
      const res = {
        writeHead(status: number) { out.status = status; return res },
        end(payload: string) { out.body = JSON.parse(payload) as Record<string, unknown> },
      } as unknown as ServerResponse
      await handler?.(req, res)
      return out
    }

    const got = await invoke('GET')
    expect(got.status).toBe(200)
    expect((got.body.totals as { requests: number }).requests).toBe(1)

    expect((await invoke('DELETE')).status).toBe(405)
    expect((await invoke('POST', { action: 'reset' }, {}, false)).status).toBe(403)
    expect((await invoke('GET', undefined, { host: 'evil.example:80' })).status).toBe(403)
    expect((await invoke('POST', { action: 'other' })).status).toBe(400)

    const reset = await invoke('POST', { action: 'reset' })
    expect(reset.status).toBe(200)
    expect((reset.body.totals as { requests: number }).requests).toBe(0)
  })
})
