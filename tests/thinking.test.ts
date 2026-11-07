/**
 * Splitting private reasoning from the answer.
 *
 * A 深度思考 turn opens a `block_type: 10040` container and then streams the
 * reasoning as ordinary `block_type: 10000` blocks whose `parent_id` points at
 * it. Getting this wrong is not a cosmetic bug: the previous revision put every
 * `text` field into the answer, so a thinking turn would have shown the model's
 * private reasoning as the first paragraphs of its reply.
 *
 * These cases are transcribed from a captured stream (2026-10-23), not invented.
 */
import { describe, expect, it } from 'vitest'
import { collectBlocks } from '../src/doubao-upstream.ts'
import { DEEP_THINK_OFF, DEEP_THINK_ON, needDeepThinkValue, supportsReasoning } from '../src/doubao-catalog.ts'
import { buildChatBody } from '../src/doubao-upstream.ts'

const THINKING_ID = '10519372686251266'
const ANSWER_ID = '10519372686251299'

/** A thinking container as the server sends it. */
const thinkingBlock = {
  block_type: 10040,
  block_id: THINKING_ID,
  is_finish: false,
  content: {
    thinking_block: {
      finish_title: '已完成思考',
      streaming_title: '正在思考',
      icon_url: 'https://example.invalid/Deep_Think.png',
    },
  },
}

/** One streamed text block, optionally parented to the thinking container. */
function textBlock(text: string, parentId = '', blockType = 10000) {
  return {
    block_type: blockType,
    block_id: ANSWER_ID,
    parent_id: parentId,
    content: { text_block: { text } },
  }
}

function run(...nodes: unknown[]) {
  const into = { answer: [] as string[], thinking: [] as string[] }
  const ids = new Set<string>()
  for (const node of nodes) collectBlocks(node, into, ids)
  return into
}

describe('collectBlocks', () => {
  it('keeps a plain reply as answer text', () => {
    expect(run([textBlock('你好')]).answer).toEqual(['你好'])
  })

  it('routes children of the thinking container to thinking', () => {
    const out = run([thinkingBlock], [textBlock('用户询问', THINKING_ID)], [textBlock('9.9 更大')])
    expect(out.thinking).toEqual(['用户询问'])
    expect(out.answer).toEqual(['9.9 更大'])
  })

  it('remembers the container id across separate frames', () => {
    const into = { answer: [] as string[], thinking: [] as string[] }
    const ids = new Set<string>()
    collectBlocks([thinkingBlock], into, ids)          // frame 1: the container
    collectBlocks([textBlock('推理', THINKING_ID)], into, ids) // frame 2: child
    expect(into.thinking).toEqual(['推理'])
    expect(into.answer).toEqual([])
  })

  it('treats a 10040 block’s own text as thinking, not answer', () => {
    const withText = { ...thinkingBlock, content: { text_block: { text: '总结' } } }
    expect(run([withText]).thinking).toEqual(['总结'])
    expect(run([withText]).answer).toEqual([])
  })

  it('ignores frames with no text at all (the empty thinking shell)', () => {
    const out = run([thinkingBlock])
    expect(out.thinking).toEqual([])
    expect(out.answer).toEqual([])
  })

  it('collects CHUNK_DELTA frames ({ text, id }) into answer or thinking', () => {
    const out = run(
      [thinkingBlock],
      { text: '思考增量', id: THINKING_ID },
      { text: '回答增量', id: ANSWER_ID },
    )
    expect(out.thinking).toEqual(['思考增量'])
    expect(out.answer).toEqual(['回答增量'])
  })
})

describe('the deep-think switch value', () => {
  it('is 0 when off and 3 when on — captured, not 10000+level', () => {
    expect(needDeepThinkValue(false)).toBe(DEEP_THINK_OFF)
    expect(needDeepThinkValue(true)).toBe(DEEP_THINK_ON)
    expect(DEEP_THINK_OFF).toBe(0)
    expect(DEEP_THINK_ON).toBe(3)
  })
})

/**
 * The switch that makes the picker mean something.
 *
 * Measured 2026-11-07: `reasoning_effort` alone never produced a thinking turn —
 * the reply came back `thinking: false` with effort already at 5, because the
 * request still carried `need_deep_think: 0`. Only `need_deep_think: 3` did.
 * These cases pin the two shapes apart so a refactor cannot silently send the
 * chat shape for a task turn (which needs 10001) or drop the switch entirely.
 */
describe('深度思考 switch on the wire', () => {
  it('sends 3 when the switch is on', () => {
    const body = buildChatBody('hi', { deepThink: true }) as {
      option?: { need_deep_think?: number }
      ext?: { use_deep_think?: string }
    }
    expect(body.option?.need_deep_think).toBe(DEEP_THINK_ON)
    expect(body.ext?.use_deep_think).toBe(String(DEEP_THINK_ON))
  })

  it('sends 0 when the switch is off', () => {
    const body = buildChatBody('hi', { deepThink: false }) as {
      option?: { need_deep_think?: number }
    }
    expect(body.option?.need_deep_think).toBe(DEEP_THINK_OFF)
  })

  it('keeps the 工作任务 shape when the switch is left unset', () => {
    // `5` is a 工作任务 model: unset must mean the captured 10001, not 0 and not 3.
    const body = buildChatBody('hi', { modelKey: '5' }) as {
      option?: { need_deep_think?: number }
    }
    expect(body.option?.need_deep_think).toBe(10001)
  })

  it('refuses to advertise thinking on a no-CoT model', () => {
    // 豆包 快速 answered `thinking: false` even with the switch on, so the picker
    // must not offer 低/中/高 for it.
    expect(supportsReasoning('0')).toBe(false)
    expect(supportsReasoning('5')).toBe(true)
  })
})
