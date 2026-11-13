import { describe, expect, it } from 'vitest'
import {
  estimateContentTokens,
  estimateMessageTokens,
  estimateTextTokens,
  estimateToolsTokens,
  resolveChatUsage,
} from '../src/doubao-tokens.ts'

describe('doubao-tokens estimation & OpenAI usage resolution', () => {
  it('returns 0 for empty text and stays at or above the 4-chars/token floor for any non-empty string', () => {
    expect(estimateTextTokens('')).toBe(0)

    const samples = [
      'a',
      'hello world',
      '    indented    spaces    here    ',
      'function sum(a: number, b: number): number { return a + b }',
      '中文与English混排🚀测试123',
      '{"type":"object","properties":{"path":{"type":"string"}}}',
    ]
    for (const sample of samples) {
      expect(estimateTextTokens(sample)).toBeGreaterThanOrEqual(Math.ceil(sample.length / 4))
    }
    // CJK ideographs count ~1 token/char rather than 4 chars/token.
    expect(estimateTextTokens('你好世界')).toBe(4)
  })

  it('prices image parts with bounded placeholder tokens instead of base64 payload bytes', () => {
    const hugeBase64 = 'A'.repeat(200_000)
    const tokens = estimateContentTokens([
      { type: 'text', text: '看看这张图' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${hugeBase64}` } },
    ])
    expect(tokens).toBeGreaterThanOrEqual(256)
    expect(tokens).toBeLessThan(400)
  })

  it('counts message tool_calls, tool_call_id, and tools schemas', () => {
    const msgTokens = estimateMessageTokens({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' },
        },
      ],
    })
    expect(msgTokens).toBeGreaterThan(10)

    const toolsTokens = estimateToolsTokens(
      [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } } }],
      'short emulated contract',
    )
    expect(toolsTokens).toBeGreaterThan(10)
  })

  it('resolves uncached, cached continuation, reasoning, and tool-call tokens consistently', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
      { role: 'user', content: '第二轮追问，结合刚才的内容继续分析' },
    ]
    const tools = [
      { type: 'function', function: { name: 'search', description: 'Search code', parameters: { type: 'object' } } },
    ]

    const turn1 = resolveChatUsage({
      messages: messages.slice(0, 2),
      tools,
      cachedPrefixMessages: 0,
      answerText: '第一轮回答',
      reasoningText: '先思考一下问题',
    })
    expect(turn1.cachedInputTokens).toBe(0)
    expect(turn1.uncachedInputTokens).toBe(turn1.promptTokens)
    expect(turn1.reasoningTokens).toBe(7)
    expect(turn1.answerTokens).toBe(5)
    expect(turn1.completionTokens).toBe(12)
    expect(turn1.totalTokens).toBe(turn1.promptTokens + 12)
    expect(turn1.openai.prompt_tokens_details).toBeUndefined()
    expect(turn1.openai.completion_tokens_details).toEqual({ reasoning_tokens: 7 })

    const turn2 = resolveChatUsage({
      messages,
      tools,
      cachedPrefixMessages: 2,
      answerText: '好的',
      toolCalls: [{ name: 'search', arguments: '{"q":"tokens"}' }],
    })
    expect(turn2.promptTokens).toBeGreaterThan(turn1.promptTokens)
    expect(turn2.cachedInputTokens).toBeGreaterThan(0)
    expect(turn2.uncachedInputTokens).toBeGreaterThanOrEqual(4)
    expect(turn2.uncachedInputTokens + turn2.cachedInputTokens).toBe(turn2.promptTokens)
    expect(turn2.toolCallTokens).toBeGreaterThan(4)
    expect(turn2.openai.prompt_tokens_details).toEqual({ cached_tokens: turn2.cachedInputTokens })
    expect(turn2.openai.completion_tokens_details).toBeUndefined()

    // Non-continuation boundary (>= messages.length) never marks cached tokens.
    const invalidPrefix = resolveChatUsage({
      messages,
      cachedPrefixMessages: messages.length,
      answerText: 'ok',
    })
    expect(invalidPrefix.cachedInputTokens).toBe(0)
  })
})
