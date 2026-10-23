/**
 * Conversation continuity.
 *
 * WHY. Until now every turn re-flattened the whole transcript into one prompt and
 * sent it as a brand-new conversation. That is stateless and honest, but it
 * degrades long chats: role prefixes blur into prose, and the server's own
 * context handling (memory, attachments, per-conversation state) never applies.
 *
 * Doubao expects the opposite: the client sends ONE new message plus the
 * `conversation_id` it got back on the previous turn. This module decides when a
 * request is a continuation of the previous one and what delta to send.
 *
 * HOW A SESSION IS RECOGNISED. The Harness is stateless — it hands over the full
 * transcript every time — so continuity has to be inferred. The rule: two
 * requests belong to one conversation when the FIRST message is identical and
 * the transcript has GROWN. That is exactly the shape of "the same chat, one
 * more turn". A fresh conversation reuses the same opening only if the user
 * literally starts a new chat with the same first message, in which case the
 * server-side conversation is a harmless extra (and is dropped on TTL).
 *
 * This is a heuristic, so it is deliberately conservative: any doubt (different
 * opening, same length, shorter transcript) starts a NEW conversation, which is
 * the behaviour this plugin had before and is never worse than a wrong reuse.
 *
 * @module dsh-connect-doubao/session
 */
import { createHash } from 'node:crypto'

/** Minimal inbound message shape. */
export interface InboundMessage {
  role?: string
  content?: unknown
}

/** What we remember about one Doubao conversation. */
export interface SessionState {
  /** `conversation_id` the server assigned on the last turn. */
  conversationId: string
  /** How many inbound messages that turn had. */
  messageCount: number
  /** Epoch ms of the last use, for TTL. */
  at: number
}

/** A conversation nobody has touched for this long is dropped. */
export const SESSION_TTL_MS = 30 * 60 * 1000
/** Hard cap, so a long-lived host cannot grow this map without bound. */
export const SESSION_MAX_ENTRIES = 64

/**
 * Stable key for a transcript's opening HUMAN turn.
 *
 * Keyed on the first `user` message rather than `messages[0]`: the Harness
 * usually opens with a system prompt that is IDENTICAL across unrelated chats,
 * so keying on it would collapse every conversation into one entry — and the
 * next turn would be appended to a stranger's thread.
 *
 * Hashed rather than stored: the key outlives a single request, and user text
 * has no business being held there.
 */
export function sessionKeyOf(messages: readonly InboundMessage[] | undefined): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  const opening = messages.find((message) => message?.role === 'user') ?? messages[0]
  const text = typeof opening?.content === 'string'
    ? opening.content
    : JSON.stringify(opening?.content ?? '')
  if (!text) return undefined
  return createHash('sha256').update(`${opening?.role ?? 'user'}\u0000${text}`).digest('hex').slice(0, 32)
}

/**
 * Whether this request continues the remembered conversation.
 *
 * Requires a stored conversation id AND a strictly longer transcript. Equal
 * length is a RE-RUN of the same turn (a retry, or a regeneration), which must
 * not be appended to the server-side conversation as if it were new.
 */
export function isContinuation(
  messages: readonly InboundMessage[] | undefined,
  state: SessionState | undefined,
): state is SessionState {
  if (state === undefined) return false
  if (!Array.isArray(messages)) return false
  return messages.length > state.messageCount
}

/**
 * The messages a continuation must actually send.
 *
 * Everything before `messageCount` is already on the server. Slicing from the
 * INTENDED index to the end also covers the case where the Harness resent an
 * extra prior message.
 */
export function continuationDelta(
  messages: readonly InboundMessage[],
  state: SessionState,
): InboundMessage[] {
  const from = Math.min(Math.max(state.messageCount, 0), messages.length)
  return messages.slice(from)
}

/** Bounded, TTL'd store of conversation ids. */
export class ConversationStore {
  private readonly entries = new Map<string, SessionState>()

  constructor(
    private readonly ttlMs: number = SESSION_TTL_MS,
    private readonly maxEntries: number = SESSION_MAX_ENTRIES,
  ) {}

  get(key: string | undefined, now = Date.now()): SessionState | undefined {
    if (key === undefined) return undefined
    const state = this.entries.get(key)
    if (state === undefined) return undefined
    if (now - state.at > this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return state
  }

  remember(key: string | undefined, conversationId: string, messageCount: number, now = Date.now()): void {
    if (key === undefined || conversationId === '') return
    this.entries.set(key, { conversationId, messageCount, at: now })
    if (this.entries.size <= this.maxEntries) return
    // Oldest-first eviction: Map preserves insertion order, and `remember`
    // re-inserts on every turn, so the front is the least recently written.
    for (const oldest of this.entries.keys()) {
      this.entries.delete(oldest)
      if (this.entries.size <= this.maxEntries) break
    }
  }

  forget(key: string | undefined): void {
    if (key !== undefined) this.entries.delete(key)
  }

  get size(): number {
    return this.entries.size
  }
}
