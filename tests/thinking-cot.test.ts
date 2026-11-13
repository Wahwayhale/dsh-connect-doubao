import { afterEach, describe, expect, it, vi } from 'vitest'
import { REQUIRED_COOKIE_NAMES, type DoubaoCredentials } from '../src/doubao-auth.ts'
import { createDoubaoShim, requestOptions } from '../src/doubao-shim.ts'
import {
  buildChatBody,
  collectBlocks,
  createBlockCollectState,
  streamChat,
} from '../src/doubao-upstream.ts'

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

let shims: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  vi.unstubAllGlobals()
  delete process.env.DSH_DOUBAO_DEEP_THINK
  for (const shim of shims.splice(0)) {
    await shim.close()
  }
})

describe('summary CoT, thinking_block titles, and id-less CHUNK_DELTA extraction', () => {
  it('extracts & deduplicates thinking_block stage titles and incremental text_block.summary without placeholders', async () => {
    const deltas: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          frame('SSE_ACK', { ack_client_meta: { conversation_id: 'conv-cot' } }),
          // Initial placeholder shell — skipped
          frame('STREAM_CHUNK', {
            block_type: 10040,
            block_id: 't-shell',
            parent_id: '',
            content: {
              thinking_block: {
                streaming_title: '正在思考',
                unfold_streaming_title: '正在思考',
                cot_ui_style: 'summary',
              },
            },
            is_finish: false,
          }),
          // Child summary placeholder — skipped
          frame('STREAM_CHUNK', {
            block_type: 10000,
            block_id: 't-sum-1',
            parent_id: 't-shell',
            content: { text_block: { text: '', summary: '正在思考' } },
            is_finish: false,
          }),
          // Real stage 1 title + repeated duplicate frame
          frame('STREAM_CHUNK', {
            block_type: 10040,
            block_id: 't-shell',
            parent_id: '',
            content: {
              thinking_block: {
                streaming_title: '比较两数大小',
                cot_ui_style: 'summary',
              },
            },
            is_finish: false,
          }),
          frame('STREAM_CHUNK', {
            block_type: 10040,
            block_id: 't-shell',
            parent_id: '',
            content: {
              thinking_block: {
                streaming_title: '比较两数大小',
                cot_ui_style: 'summary',
              },
            },
            is_finish: false,
          }),
          // Child summary repeating the exact same stage title — deduped
          frame('STREAM_CHUNK', {
            block_type: 10000,
            block_id: 't-sum-1',
            parent_id: 't-shell',
            content: { text_block: { text: '', summary: '比较两数大小' } },
            is_finish: false,
          }),
          // Cumulative summary text growing step by step + repeated is_finish snapshot
          frame('STREAM_CHUNK', {
            block_type: 10000,
            block_id: 't-sum-2',
            parent_id: 't-shell',
            content: { text_block: { text: '', summary: '先比较整数部分' } },
            is_finish: false,
          }),
          frame('STREAM_CHUNK', {
            block_type: 10000,
            block_id: 't-sum-2',
            parent_id: 't-shell',
            content: { text_block: { text: '', summary: '先比较整数部分，再看小数十分位。' } },
            is_finish: true,
          }),
          frame('STREAM_CHUNK', {
            block_type: 10000,
            block_id: 't-sum-2',
            parent_id: 't-shell',
            content: { text_block: { text: '', summary: '先比较整数部分，再看小数十分位。' } },
            is_finish: true,
          }),
          // Answer block opens + id-less CHUNK_DELTA streams answer
          frame('STREAM_CHUNK', {
            block_type: 10000,
            block_id: 'ans-1',
            parent_id: '',
            content: { text_block: { text: '0.9 ' } },
            is_finish: false,
          }),
          // Interleaved 10040 final finish_title update mid-answer must NOT hijack answer CHUNK_DELTA
          frame('STREAM_CHUNK', {
            block_type: 10040,
            block_id: 't-shell',
            parent_id: '',
            content: {
              thinking_block: {
                streaming_title: '比较两数大小',
                finish_title: '小数大小比较逻辑说明',
                cot_ui_style: 'summary',
              },
            },
            is_finish: true,
          }),
          frame('CHUNK_DELTA', { text: '大于 ' }),
          frame('CHUNK_DELTA', { text: '0.11。' }),
          frame('SSE_REPLY_END', {}),
        ]),
      ),
    )

    const result = await streamChat('0.9和0.11谁大', {
      credentials,
      callbacks: { onThinking: (delta) => deltas.push(delta) },
    })

    expect(result.thinking).toBe(true)
    expect(result.text).toBe('0.9 大于 0.11。')
    expect(result.reasoningText).toBe(deltas.join(''))
    expect(result.reasoningText).not.toContain('正在思考')
    expect(result.reasoningText).toContain('比较两数大小')
    expect(result.reasoningText).toContain('先比较整数部分，再看小数十分位。')
    expect(result.reasoningText).toContain('小数大小比较逻辑说明')
    // No duplicated stage title or duplicated summary prefix
    expect(result.reasoningText?.match(/比较两数大小/g)?.length).toBe(1)
    expect(result.reasoningText?.match(/先比较整数部分/g)?.length).toBe(1)
  })

  it('routes id-less CHUNK_DELTA frames to thinking while thinking block is active, then to answer once answer block opens', () => {
    const state = createBlockCollectState()
    const into = { answer: [] as string[], thinking: [] as string[] }

    collectBlocks(
      {
        block_type: 10040,
        block_id: 'think-1',
        parent_id: '',
        content: { thinking_block: { streaming_title: '正在思考' } },
        is_finish: false,
      },
      into,
      state,
    )
    collectBlocks({ text: '第一步推演，' }, into, state)
    collectBlocks({ text: '得出中间结论。' }, into, state)

    collectBlocks(
      {
        block_type: 10000,
        block_id: 'ans-1',
        parent_id: '',
        content: { text_block: { text: '' } },
        is_finish: false,
      },
      into,
      state,
    )
    collectBlocks({ text: '最终答案。' }, into, state)

    expect(into.thinking).toEqual(['第一步推演，', '得出中间结论。'])
    expect(into.answer).toEqual(['最终答案。'])
  })

  it('ignores image-gen 10040 placeholder titles and keeps empty 10040 shell thinking=false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          frame('SSE_ACK', { ack_client_meta: { conversation_id: 'conv-img' } }),
          frame('STREAM_CHUNK', {
            block_type: 10040,
            block_id: 'img-shell',
            parent_id: '',
            content: {
              thinking_block: {
                streaming_title: '正在生成图片',
                finish_title: '已完成图片生成',
                empty_disable_click: true,
              },
            },
            is_finish: true,
          }),
          frame('STREAM_CHUNK', {
            block_type: 10000,
            block_id: 'ans-1',
            parent_id: '',
            content: { text_block: { text: 'ok' } },
          }),
          frame('SSE_REPLY_END', {}),
        ]),
      ),
    )

    const result = await streamChat('hello', { credentials })
    expect(result.thinking).toBe(false)
    expect(result.reasoningText).toBeUndefined()
    expect(result.text).toBe('ok')
  })

  it('keeps consecutive identical full CoT tokens verbatim while deduplicating STREAM_MSG_NOTIFY replay', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          frame('SSE_ACK', { ack_client_meta: { conversation_id: 'conv-full' } }),
          frame('STREAM_CHUNK', {
            block_type: 10040,
            block_id: 'think-root',
            parent_id: '',
            content: { text_block: { text: 'ha' } },
            is_finish: false,
          }),
          frame('STREAM_CHUNK', {
            block_type: 10040,
            block_id: 'think-root',
            parent_id: '',
            content: { text_block: { text: 'ha' } },
            is_finish: true,
          }),
          frame('STREAM_CHUNK', {
            block_type: 10040,
            block_id: 'think-root',
            parent_id: '',
            content: { thinking_block: { finish_title: '已深度思考（用时 2 秒）' } },
            is_finish: true,
          }),
          frame('STREAM_MSG_NOTIFY', {
            content: {
              ext: { use_deep_think: '3' },
              content_block: [
                {
                  block_type: 10040,
                  block_id: 'think-root',
                  parent_id: '',
                  content: { text_block: { text: 'haha' } },
                },
                {
                  block_type: 10000,
                  block_id: 'ans-root',
                  parent_id: '',
                  content: { text_block: { text: 'done' } },
                },
              ],
            },
          }),
          frame('SSE_REPLY_END', {}),
        ]),
      ),
    )

    const result = await streamChat('laugh', { credentials })
    expect(result.thinking).toBe(true)
    expect(result.reasoningText).toBe('haha')
    expect(result.text).toBe('done')
  })
})

describe('shim reasoning_content & requestOptions behaviors', () => {
  it('supports explicit reasoning_effort "off" on chat models and conversation_mode "2" on task models', () => {
    expect(requestOptions({ model: '3', reasoning_effort: 'off' })).toEqual({
      deepThink: false,
      modelKey: '3',
    })

    const taskBody = buildChatBody('hi', { modelKey: 'seed-lite-7b', taskMode: true })
    expect(taskBody.option.conversation_mode).toBe(2)
    expect(taskBody.option.aggregate_params.conversation_mode).toBe('2')
    expect(taskBody.option.need_deep_think).toBe(10001)
  })

  it('includes reasoning_content in both stream: false and stream: true shim responses', async () => {
    const realFetch = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
        return sseResponse([
          frame('SSE_ACK', { ack_client_meta: { conversation_id: 'conv-shim' } }),
          frame('STREAM_CHUNK', {
            block_type: 10040,
            block_id: 'think-1',
            parent_id: '',
            content: { thinking_block: { streaming_title: '分析题干', cot_ui_style: 'summary' } },
          }),
          frame('STREAM_CHUNK', {
            block_type: 10000,
            block_id: 'think-sum',
            parent_id: 'think-1',
            content: { text_block: { text: '', summary: '逐步推导' } },
          }),
          frame('STREAM_CHUNK', {
            block_type: 10000,
            block_id: 'ans-1',
            parent_id: '',
            content: { text_block: { text: '答案是 42' } },
          }),
          frame('SSE_REPLY_END', {}),
        ])
      }),
    )

    const shim = createDoubaoShim({ resolveCredentials: () => credentials })
    shims.push(shim)
    const base = await shim.baseUrl()
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${shim.token()}`,
    }

    const nonStream = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: '3',
        stream: false,
        messages: [{ role: 'user', content: 'question' }],
      }),
    })
    expect(nonStream.status).toBe(200)
    const json = (await nonStream.json()) as {
      choices: Array<{ message: { content: string; reasoning_content?: string } }>
    }
    expect(json.choices[0]?.message.content).toBe('答案是 42')
    expect(json.choices[0]?.message.reasoning_content).toContain('分析题干')
    expect(json.choices[0]?.message.reasoning_content).toContain('逐步推导')

    const streamed = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: '3',
        stream: true,
        messages: [{ role: 'user', content: 'question' }],
      }),
    })
    expect(streamed.status).toBe(200)
    const rawSse = await streamed.text()
    expect(rawSse).toContain('"reasoning_content"')
    expect(rawSse).toContain('分析题干')
    expect(rawSse).toContain('"content":"答案是 42"')
  })
})
