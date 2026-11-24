/**
 * Conversation continuity rules.
 *
 * The Harness is stateless: it resends the entire transcript every turn. Doubao
 * wants the opposite — one new message plus the thread id. So "is this the same
 * conversation?" has to be inferred, and the cost of getting it wrong is
 * asymmetric: a missed continuation is merely the old (stateless) behaviour,
 * while a WRONG continuation would append the user's next turn into somebody
 * else's thread. The rules below are therefore deliberately conservative.
 */
import { describe, expect, it } from 'vitest'
import {
  ConversationStore,
  SESSION_MAX_ENTRIES,
  SESSION_TTL_MS,
  continuationDelta,
  isContinuation,
  sessionKeyOf,
  type SessionState,
} from '../src/doubao-session.ts'
import { DoubaoUpstreamError, classifyDoubaoFailure, isInvalidParamFailure } from '../src/doubao-upstream.ts'
import { buildPrompt, fitPromptToByteBudget, overflowIfOversized } from '../src/doubao-shim.ts'

const first = { role: 'user', content: '第一句话' }

function state(messageCount = 1, conversationId = 'conv-1'): SessionState {
  return { conversationId, messageCount, at: Date.now() }
}

describe('710020202 — a continuation the server rejects', () => {
  it('is recognised as an invalid-param failure', () => {
    expect(isInvalidParamFailure(new DoubaoUpstreamError('common invalid param', 710020202))).toBe(true)
    expect(isInvalidParamFailure(new DoubaoUpstreamError('other', 710010702))).toBe(false)
    expect(isInvalidParamFailure(new Error('not upstream'))).toBe(false)
  })

  it('relabels an oversized prompt as a context overflow, not a param error', () => {
    // Same server code, two causes: only the body size tells them apart.
    // 256 KiB is the measured wall — 262,144 ASCII chars pass, 262,145 fail.
    const over = 'A'.repeat(262_145)
    const under = 'A'.repeat(262_144)
    const relabel = overflowIfOversized(new DoubaoUpstreamError('common invalid param', 710020202), over)
    expect(classifyDoubaoFailure(relabel as DoubaoUpstreamError)).toBe('context_overflow')
    expect(relabel).toBeInstanceOf(DoubaoUpstreamError)
    // At or below the ceiling the id explanation stands: the error is passed through.
    expect(overflowIfOversized(new DoubaoUpstreamError('common invalid param', 710020202), under))
      .toBeInstanceOf(DoubaoUpstreamError)
    // A different failure is never relabelled.
    expect(isInvalidParamFailure(overflowIfOversized(new DoubaoUpstreamError('x', 710010702), over))).toBe(false)
  })

  it('fits a transcript under the byte ceiling by dropping the oldest turns', () => {
    // 559 KB of transcript + a 139 KB tool contract is the shape that kept
    // failing: well under the token threshold, far over the 256 KiB wall.
    const turns = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第${i}轮：` + '这是一段较长的历史内容。'.repeat(70),
    }))
    const contract = 'x'.repeat(139_000)
    const fit = fitPromptToByteBudget(turns, contract)
    const bytes = Buffer.byteLength(buildPrompt(fit.messages), 'utf8') + Buffer.byteLength(contract, 'utf8')
    expect(bytes).toBeLessThanOrEqual(220_000)
    expect(fit.dropped).toBeGreaterThan(0)
    // The turn being answered is never dropped.
    expect(fit.messages[fit.messages.length - 1]!.content).toContain('第199轮')
  })

  it('leaves a transcript that already fits untouched', () => {
    const turns = [{ role: 'user', content: '你好' }]
    const fit = fitPromptToByteBudget(turns, '')
    expect(fit.dropped).toBe(0)
    expect(fit.truncated).toBe(false)
    expect(fit.messages).toHaveLength(1)
  })

  it('keeps a thread far longer than the old 30 minutes', () => {
    // A dropped id costs a full transcript re-upload on the next turn, so
    // expiry only has to bound staleness — the shim re-issues a rejected id.
    expect(SESSION_TTL_MS).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000)
    expect(SESSION_MAX_ENTRIES).toBeGreaterThanOrEqual(256)
  })

  it('evicts least-recently-used, not first-inserted', () => {
    const store = new ConversationStore(SESSION_TTL_MS, 2)
    store.remember('a', 'conv-a', 1)
    store.remember('b', 'conv-b', 1)
    // Touch 'a' so it is the most recent; 'b' is now the oldest.
    store.remember('a', 'conv-a', 2)
    store.remember('c', 'conv-c', 1)
    expect(store.get('a')?.conversationId).toBe('conv-a')
    expect(store.get('b')).toBeUndefined()
    expect(store.get('c')?.conversationId).toBe('conv-c')
  })
})

describe('sessionKeyOf', () => {
  it('is stable for the same opening message', () => {
    expect(sessionKeyOf([first])).toBe(sessionKeyOf([{ ...first }]))
  })

  it('changes when the opening message changes', () => {
    expect(sessionKeyOf([first])).not.toBe(sessionKeyOf([{ role: 'user', content: '另一个开头' }]))
  })

  it('ignores the system prompt, which is identical across unrelated chats', () => {
    const withSystem = [{ role: 'system', content: '你是助手' }, first]
    expect(sessionKeyOf(withSystem)).toBe(sessionKeyOf([first]))
    // …and two different system prompts must NOT be able to split one chat.
    const otherSystem = [{ role: 'system', content: '另一段系统提示' }, first]
    expect(sessionKeyOf(otherSystem)).toBe(sessionKeyOf(withSystem))
  })

  it('is undefined for an empty transcript', () => {
    expect(sessionKeyOf([])).toBeUndefined()
    expect(sessionKeyOf(undefined)).toBeUndefined()
  })

  it('skips synthetic permission/runtime user notices when computing session key', () => {
    const notice = {
      role: 'user',
      content: 'The user changed the approval policy from "ask" to "never".',
    }
    const sys = { role: 'system', content: 'You are an AI agent.' }
    const keyA = sessionKeyOf([sys, notice, { role: 'user', content: '任务 A' }])
    const keyB = sessionKeyOf([sys, notice, { role: 'user', content: '任务 B' }])
    expect(keyA).toBeDefined()
    expect(keyA).not.toBe(keyB)
    expect(sessionKeyOf([sys, notice])).toBeDefined()
  })
})

describe('isContinuation', () => {
  it('continues when the transcript grew', () => {
    const messages = [first, { role: 'assistant', content: '回答' }, { role: 'user', content: '追问' }]
    expect(isContinuation(messages, state(2))).toBe(true)
  })

  it('does NOT continue a re-run of the same turn (retry / regenerate)', () => {
    const messages = [first, { role: 'assistant', content: '回答' }]
    // Same length as the last turn: appending it would duplicate the turn
    // server-side, so this must start fresh.
    expect(isContinuation(messages, state(2))).toBe(false)
  })

  it('does NOT continue a shorter transcript', () => {
    expect(isContinuation([first], state(3))).toBe(false)
  })

  it('does not continue without a remembered conversation', () => {
    expect(isContinuation([first, { role: 'user', content: '追问' }], undefined)).toBe(false)
  })
})

describe('continuationDelta', () => {
  it('sends only the messages the server has not seen', () => {
    const messages = [first, { role: 'assistant', content: '回答' }, { role: 'user', content: '追问' }]
    expect(continuationDelta(messages, state(2))).toEqual([{ role: 'user', content: '追问' }])
  })

  it('clamps when the transcript shrank between turns', () => {
    expect(continuationDelta([first], state(9))).toEqual([])
  })
})

describe('ConversationStore', () => {
  it('remembers a thread and hands it back', () => {
    const store = new ConversationStore()
    store.remember('k', 'conv-9', 3)
    expect(store.get('k')?.conversationId).toBe('conv-9')
    expect(store.get('k')?.messageCount).toBe(3)
  })

  it('expires an idle conversation', () => {
    const store = new ConversationStore(1000)
    store.remember('k', 'conv-9', 3, 0)
    expect(store.get('k', 500)).toBeDefined()
    expect(store.get('k', 2000)).toBeUndefined()
  })

  it('ignores an empty conversation id', () => {
    const store = new ConversationStore()
    store.remember('k', '', 1)
    expect(store.get('k')).toBeUndefined()
  })

  it('forgets on demand (used when the server says the session is dead)', () => {
    const store = new ConversationStore()
    store.remember('k', 'conv-9', 1)
    store.forget('k')
    expect(store.get('k')).toBeUndefined()
  })

  it('evicts the oldest entry past its cap', () => {
    const store = new ConversationStore(60_000, 2)
    store.remember('a', 'conv-a', 1)
    store.remember('b', 'conv-b', 1)
    store.remember('c', 'conv-c', 1)
    expect(store.size).toBe(2)
    expect(store.get('a')).toBeUndefined()
    expect(store.get('c')?.conversationId).toBe('conv-c')
  })
})
