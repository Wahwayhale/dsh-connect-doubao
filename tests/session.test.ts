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
  continuationDelta,
  isContinuation,
  sessionKeyOf,
  type SessionState,
} from '../src/doubao-session.ts'

const first = { role: 'user', content: '第一句话' }

function state(messageCount = 1, conversationId = 'conv-1'): SessionState {
  return { conversationId, messageCount, at: Date.now() }
}

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
