import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { DOUBAO_PROVIDER } from '../src/doubao-catalog.ts'
import { createDoubaoAdapter } from '../src/doubao-adapter.ts'
import { REQUIRED_COOKIE_NAMES, type DoubaoCredentials } from '../src/doubao-auth.ts'
import { createDoubaoShim, type DoubaoShim } from '../src/doubao-shim.ts'
import { DoubaoStatsTracker } from '../src/doubao-stats.ts'
import { TOOL_FENCE_LANGUAGE } from '../src/doubao-tools.ts'

const realFetch = globalThis.fetch

const credentials: DoubaoCredentials = {
  ok: true,
  header: REQUIRED_COOKIE_NAMES.map((name) => `${name}=test`).join('; '),
  pairs: new Map(REQUIRED_COOKIE_NAMES.map((name) => [name, 'test'])),
}

function frame(event: string, data: unknown): string {
  return `id: 1\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function sseResponse(chunks: string[], delayMsBetween = 0): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMsBetween > 0) await new Promise((r) => setTimeout(r, delayMsBetween))
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function parseOpenAiSse(raw: string): Array<Record<string, any>> {
  const items: Array<Record<string, any>> = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice('data:'.length).trim()
    if (data === '' || data === '[DONE]') continue
    items.push(JSON.parse(data) as Record<string, any>)
  }
  return items
}

let shims: DoubaoShim[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const shim of shims.splice(0)) {
    await shim.close()
  }
})

function stubUpstreamFetch(
  chatHandler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      if (url.startsWith('http://127.0.0.1:')) {
        return realFetch(input as RequestInfo | URL, init)
      }
      if (url.includes('/quota/summary/')) {
        return new Response(
          JSON.stringify({ data: { window_limit_section: { usage_exhausted: false } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes('/chat/completion')) {
        return chatHandler(url, init)
      }
      throw new Error(`unexpected fetch in test: ${url}`)
    }),
  )
}

describe('Doubao session stats and token usage end-to-end integration', () => {
  it('streams reasoning, text, and native DSH TokenUsage through createDoubaoAdapter (PiAiAdapter) -> DoubaoShim', async () => {
    const stats = new DoubaoStatsTracker()
    const shim = createDoubaoShim({
      resolveCredentials: () => credentials,
      stats,
    })
    shims.push(shim)
    await shim.baseUrl()

    stubUpstreamFetch(() =>
      sseResponse(
        [
          frame('SSE_ACK', { ack_client_meta: { conversation_id: 'conv-e2e-cot' } }),
          frame('STREAM_CHUNK', {
            patch_op: [
              {
                patch_object: 50,
                patch_type: 1,
                patch_value: {
                  ext: {
                    tea_tags_time_cost: JSON.stringify({
                      ack_cost_time: '120',
                      first_packet_cost_time: '380',
                    }),
                  },
                },
              },
            ],
          }),
          frame('STREAM_CHUNK', {
            block_type: 10040,
            block_id: 'think-e2e',
            parent_id: '',
            content: { text_block: { text: '先比较小数部分，9.9 大于 9.11。' } },
            is_finish: false,
          }),
          frame('STREAM_CHUNK', {
            patch_op: [
              {
                patch_object: 1,
                patch_type: 1,
                patch_value: {
                  content_block: [
                    {
                      block_type: 10000,
                      block_id: 'ans-e2e',
                      parent_id: '',
                      content: { text_block: { text: '9.9 更大。' } },
                    },
                  ],
                },
              },
              {
                patch_object: 50,
                patch_type: 1,
                patch_value: {
                  ext: {
                    context_window_usage: JSON.stringify({
                      system_prompt: 1000,
                      messages: 200,
                      skills: 0,
                      tools: 500,
                      total_window_size: 256000,
                    }),
                    finish_time_ms: String(Date.now()),
                    finish_reason_chat: 'succeed:completion',
                  },
                },
              },
            ],
          }),
          frame('SSE_REPLY_END', { end_type: 1 }),
        ],
        8,
      ),
    )

    const { adapter } = createDoubaoAdapter({ shim })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: DOUBAO_PROVIDER,
      model: '3',
      reasoningEffort: 'high',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: '9.11 和 9.9 哪个大？' }],
        },
      ],
    })) {
      chunks.push(chunk)
    }

    const reasoning = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'reasoning-delta' }> => c.type === 'reasoning-delta')
      .map((c) => c.text)
      .join('')
    const answer = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    const usageChunks = chunks.filter((c): c is Extract<StreamChunk, { type: 'usage' }> => c.type === 'usage')
    const finishChunks = chunks.filter((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')

    expect(reasoning).toContain('先比较小数部分')
    expect(answer).toBe('9.9 更大。')
    expect(usageChunks.length).toBeGreaterThanOrEqual(1)
    const reported = usageChunks.at(-1)!.usage
    expect(reported.inputTokens).toBeGreaterThan(0)
    expect(reported.outputTokens).toBeGreaterThan(0)
    expect(reported.totalTokens).toBeGreaterThanOrEqual(reported.inputTokens + reported.outputTokens)
    expect(finishChunks.at(-1)?.reason).toEqual({ kind: 'stop' })

    const snapshot = shim.stats()
    expect(snapshot.totals.requests).toBe(1)
    expect(snapshot.totals.succeeded).toBe(1)
    expect(snapshot.totals.failed).toBe(0)
    expect(snapshot.totals.avgTtftMs).not.toBeNull()
    expect(snapshot.totals.decodeTokens).toBeGreaterThan(0)
    expect(snapshot.totals.reasoningTokens).toBeGreaterThan(0)
    expect(snapshot.totals.avgTps).not.toBeNull()
    expect(snapshot.byModel.map((m) => m.model)).toContain('3')
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.lastTurn?.upstreamContextWindow).toEqual({
      systemPrompt: 1000,
      messages: 200,
      skills: 0,
      tools: 500,
      totalWindowSize: 256000,
      totalUsed: 1700,
    })
    expect(snapshot.lastTurn?.upstreamFirstPacketMs).toBe(380)
    expect(snapshot.lastTurn?.upstreamAckMs).toBe(120)
  })

  it('tracks multi-turn cached_tokens growth over HTTP, respects stream_options.include_usage=false, and resets stats', async () => {
    const shim = createDoubaoShim({
      resolveCredentials: () => credentials,
    })
    shims.push(shim)
    const base = await shim.baseUrl()

    let turn = 0
    stubUpstreamFetch(() => {
      turn += 1
      return sseResponse(
        [
          frame('SSE_ACK', { ack_client_meta: { conversation_id: `conv-mt-${turn <= 2 ? 1 : turn}` } }),
          frame('STREAM_CHUNK', {
            block_type: 10000,
            block_id: `ans-${turn}`,
            parent_id: '',
            content: { text_block: { text: turn === 1 ? '已记住 ALPHA-77。' : turn === 2 ? '代号是 ALPHA-77。' : 'ok' } },
          }),
          frame('SSE_REPLY_END', { end_type: 1 }),
        ],
        6,
      )
    })

    const post = async (body: unknown) => {
      const res = await realFetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${shim.token()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(200)
      return parseOpenAiSse(await res.text())
    }

    const turn1Msg = { role: 'user', content: '你好，请记住代号 ALPHA-77，后面我会问你。' }
    const turn1Chunks = await post({
      model: '0',
      stream: true,
      messages: [turn1Msg],
    })
    for (const chunk of turn1Chunks) {
      expect(chunk.object).toBe('chat.completion.chunk')
      expect(typeof chunk.id).toBe('string')
      expect(typeof chunk.created).toBe('number')
      expect(chunk.model).toBe('0')
    }
    const turn1Usage = turn1Chunks.at(-1)!.usage as Record<string, any>
    expect(turn1Usage.prompt_tokens).toBeGreaterThan(0)
    expect(turn1Usage.completion_tokens).toBeGreaterThan(0)
    expect(turn1Usage.total_tokens).toBe(turn1Usage.prompt_tokens + turn1Usage.completion_tokens)
    expect(turn1Usage.prompt_tokens_details).toBeUndefined()

    const turn2Chunks = await post({
      model: '0',
      stream: true,
      messages: [
        turn1Msg,
        { role: 'assistant', content: '已记住 ALPHA-77。' },
        { role: 'user', content: '我刚才说的代号是什么？' },
      ],
    })
    const turn2Usage = turn2Chunks.at(-1)!.usage as Record<string, any>
    expect(turn2Usage.prompt_tokens).toBeGreaterThan(turn1Usage.prompt_tokens)
    expect(turn2Usage.prompt_tokens_details?.cached_tokens).toBeGreaterThan(0)

    const turn3Chunks = await post({
      model: '0',
      stream: true,
      stream_options: { include_usage: false },
      messages: [{ role: 'user', content: '只回复 ok' }],
    })
    expect(turn3Chunks.every((c) => c.usage === undefined)).toBe(true)

    const afterThree = shim.stats()
    expect(afterThree.totals.requests).toBe(3)
    expect(afterThree.totals.succeeded).toBe(3)
    expect(afterThree.totals.continuations).toBe(1)
    expect(afterThree.totals.cachedInputTokens).toBeGreaterThan(0)

    shim.resetStats()
    const reset = shim.stats()
    expect(reset.totals.requests).toBe(0)
    expect(reset.byModel).toEqual([])
    expect(reset.sessions).toEqual([])
    expect(reset.lastTurn).toBeNull()
  })

  it('accounts for emulated tool calls and tools in both streaming and non-streaming responses and records failures', async () => {
    const shim = createDoubaoShim({
      resolveCredentials: () => credentials,
      toolEmulation: () => true,
    })
    shims.push(shim)
    const base = await shim.baseUrl()

    let callNum = 0
    stubUpstreamFetch(() => {
      callNum += 1
      if (callNum === 3) {
        return new Response('upstream failure', { status: 502 })
      }
      const toolReply =
        `先读取文件。\n\`\`\`${TOOL_FENCE_LANGUAGE}\n` +
        JSON.stringify({ name: 'read_file', arguments: { path: 'foo.ts' } }) +
        '\n```'
      return sseResponse([
        frame('SSE_ACK', { ack_client_meta: { conversation_id: `conv-tool-${callNum}` } }),
        frame('STREAM_CHUNK', {
          block_type: 10000,
          block_id: `ans-tool-${callNum}`,
          parent_id: '',
          content: { text_block: { text: toolReply } },
        }),
        frame('SSE_REPLY_END', { end_type: 1 }),
      ])
    })

    const tools = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a workspace file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    ]

    const streamRes = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${shim.token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: '0',
        stream: true,
        tools,
        messages: [{ role: 'user', content: '读取 foo.ts' }],
      }),
    })
    expect(streamRes.status).toBe(200)
    const streamChunks = parseOpenAiSse(await streamRes.text())
    const toolChunk = streamChunks.find((c) => Array.isArray(c.choices?.[0]?.delta?.tool_calls))
    expect(toolChunk).toBeDefined()
    expect(toolChunk!.choices[0].delta.tool_calls[0].function.name).toBe('read_file')
    const finishChunk = streamChunks.find((c) => c.choices?.[0]?.finish_reason === 'tool_calls')
    expect(finishChunk).toBeDefined()
    const streamUsage = streamChunks.at(-1)!.usage as Record<string, any>
    expect(streamUsage.prompt_tokens).toBeGreaterThan(20)
    expect(streamUsage.completion_tokens).toBeGreaterThan(0)
    expect(streamUsage.total_tokens).toBe(streamUsage.prompt_tokens + streamUsage.completion_tokens)

    const jsonRes = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${shim.token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: '0',
        stream: false,
        tools,
        messages: [{ role: 'user', content: '再次读取 foo.ts' }],
      }),
    })
    expect(jsonRes.status).toBe(200)
    const jsonBody = (await jsonRes.json()) as Record<string, any>
    expect(jsonBody.choices[0].finish_reason).toBe('tool_calls')
    expect(jsonBody.choices[0].message.tool_calls[0].function.name).toBe('read_file')
    expect(jsonBody.usage.prompt_tokens).toBeGreaterThan(20)
    expect(jsonBody.usage.completion_tokens).toBeGreaterThan(0)
    expect(jsonBody.usage.total_tokens).toBe(
      jsonBody.usage.prompt_tokens + jsonBody.usage.completion_tokens,
    )

    const errRes = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${shim.token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: '0',
        stream: false,
        messages: [{ role: 'user', content: '触发一次失败' }],
      }),
    })
    expect(errRes.status).toBeGreaterThanOrEqual(500)

    const finalStats = shim.stats()
    expect(finalStats.totals.requests).toBe(3)
    expect(finalStats.totals.succeeded).toBe(2)
    expect(finalStats.totals.failed).toBe(1)
  })
})
