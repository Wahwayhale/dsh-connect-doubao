/**
 * In-memory session and token statistics collector for the Doubao shim.
 *
 * Records cumulative and per-session counts, latency metrics (TTFT, decode
 * time, TPS), per-model totals, and upstream `context_window_usage` /
 * `tea_tags_time_cost` snapshots when Doubao reports them.
 *
 * SECURITY: only numeric counters, model identifiers, and opaque SHA-256
 * session keys cross out of this module. No user prompt text, reply prose, or
 * credential is ever retained here.
 *
 * @module dsh-connect-doubao/stats
 */
import type { UsageBreakdown } from './doubao-tokens.ts'
import type { DoubaoContextWindowUsage } from './doubao-upstream.ts'

export const DOUBAO_STATS_MAX_SESSIONS = 64

export interface DoubaoModelStatsView {
  model: string
  requests: number
  succeeded: number
  failed: number
  promptTokens: number
  cachedInputTokens: number
  completionTokens: number
  reasoningTokens: number
  totalTokens: number
}

export interface DoubaoSessionStatsEntryView {
  sessionKey: string
  lastModel: string
  turns: number
  continuations: number
  promptTokens: number
  uncachedInputTokens: number
  cachedInputTokens: number
  completionTokens: number
  reasoningTokens: number
  totalTokens: number
  lastTtftMs: number | null
  lastTps: number | null
  lastActiveAt: number
}

export interface DoubaoLastTurnStatsView {
  at: number
  model: string
  stream: boolean
  continuation: boolean
  promptTokens: number
  uncachedInputTokens: number
  cachedInputTokens: number
  completionTokens: number
  reasoningTokens: number
  totalTokens: number
  ttftMs: number | null
  durationMs: number
  decodeMs: number
  tps: number | null
  upstreamContextWindow: DoubaoContextWindowUsage | null
  upstreamFirstPacketMs: number | null
  upstreamAckMs: number | null
}

export interface DoubaoStatsView {
  ok: boolean
  startedAt: number
  updatedAt: number
  activeConversations: number
  totals: {
    requests: number
    succeeded: number
    failed: number
    continuations: number
    promptTokens: number
    uncachedInputTokens: number
    cachedInputTokens: number
    completionTokens: number
    reasoningTokens: number
    totalTokens: number
    cacheHitRate: number | null
    avgTtftMs: number | null
    avgTps: number | null
    totalDurationMs: number
    decodeMs: number
    decodeTokens: number
  }
  byModel: DoubaoModelStatsView[]
  sessions: DoubaoSessionStatsEntryView[]
  lastTurn: DoubaoLastTurnStatsView | null
}

export interface RecordSuccessInput {
  model: string
  sessionKey?: string
  stream: boolean
  continuation: boolean
  usage: UsageBreakdown
  ttftMs: number | null
  durationMs: number
  decodeMs: number
  upstreamContextWindow?: DoubaoContextWindowUsage
  upstreamFirstPacketMs?: number
  upstreamAckMs?: number
  now?: number
}

export interface RecordFailureInput {
  model: string
  durationMs: number
  now?: number
}

function computeTps(tokens: number, decodeMs: number): number | null {
  if (tokens <= 0 || decodeMs <= 0) return null
  return Number((tokens / (decodeMs / 1000)).toFixed(1))
}

function sanitizeDuration(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
}

/** Tracks runtime token usage and session statistics across Doubao turns. */
export class DoubaoStatsTracker {
  private startedAt: number
  private updatedAt: number
  private requests = 0
  private succeeded = 0
  private failed = 0
  private continuations = 0
  private promptTokens = 0
  private uncachedInputTokens = 0
  private cachedInputTokens = 0
  private completionTokens = 0
  private reasoningTokens = 0
  private totalTokens = 0
  private ttftSumMs = 0
  private ttftSamples = 0
  private decodeMs = 0
  private decodeTokens = 0
  private totalDurationMs = 0
  private lastTurn: DoubaoLastTurnStatsView | null = null
  private readonly byModel = new Map<string, DoubaoModelStatsView>()
  private readonly sessions = new Map<string, DoubaoSessionStatsEntryView>()

  constructor(
    private readonly maxSessions: number = DOUBAO_STATS_MAX_SESSIONS,
    now: number = Date.now(),
  ) {
    this.startedAt = now
    this.updatedAt = now
  }

  private getOrInitModel(model: string): DoubaoModelStatsView {
    let entry = this.byModel.get(model)
    if (entry === undefined) {
      entry = {
        model,
        requests: 0,
        succeeded: 0,
        failed: 0,
        promptTokens: 0,
        cachedInputTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      }
      this.byModel.set(model, entry)
    }
    return entry
  }

  recordSuccess(input: RecordSuccessInput): void {
    const now = input.now ?? Date.now()
    const durationMs = sanitizeDuration(input.durationMs)
    const decodeMs = sanitizeDuration(input.decodeMs)
    const ttftMs = input.ttftMs !== null && Number.isFinite(input.ttftMs) && input.ttftMs >= 0
      ? Math.round(input.ttftMs)
      : null

    this.updatedAt = now
    this.requests += 1
    this.succeeded += 1
    if (input.continuation) this.continuations += 1

    this.promptTokens += input.usage.promptTokens
    this.uncachedInputTokens += input.usage.uncachedInputTokens
    this.cachedInputTokens += input.usage.cachedInputTokens
    this.completionTokens += input.usage.completionTokens
    this.reasoningTokens += input.usage.reasoningTokens
    this.totalTokens += input.usage.totalTokens
    this.totalDurationMs += durationMs

    if (ttftMs !== null) {
      this.ttftSumMs += ttftMs
      this.ttftSamples += 1
    }
    if (decodeMs > 0 && input.usage.completionTokens > 0) {
      this.decodeMs += decodeMs
      this.decodeTokens += input.usage.completionTokens
    }

    const modelEntry = this.getOrInitModel(input.model)
    modelEntry.requests += 1
    modelEntry.succeeded += 1
    modelEntry.promptTokens += input.usage.promptTokens
    modelEntry.cachedInputTokens += input.usage.cachedInputTokens
    modelEntry.completionTokens += input.usage.completionTokens
    modelEntry.reasoningTokens += input.usage.reasoningTokens
    modelEntry.totalTokens += input.usage.totalTokens

    const tps = computeTps(input.usage.completionTokens, decodeMs)
    if (input.sessionKey !== undefined && input.sessionKey !== '') {
      const existing = this.sessions.get(input.sessionKey)
      // Re-insert so the map stays ordered least-recently-active first.
      if (existing !== undefined) this.sessions.delete(input.sessionKey)
      const next: DoubaoSessionStatsEntryView = existing === undefined
        ? {
            sessionKey: input.sessionKey,
            lastModel: input.model,
            turns: 1,
            continuations: input.continuation ? 1 : 0,
            promptTokens: input.usage.promptTokens,
            uncachedInputTokens: input.usage.uncachedInputTokens,
            cachedInputTokens: input.usage.cachedInputTokens,
            completionTokens: input.usage.completionTokens,
            reasoningTokens: input.usage.reasoningTokens,
            totalTokens: input.usage.totalTokens,
            lastTtftMs: ttftMs,
            lastTps: tps,
            lastActiveAt: now,
          }
        : {
            ...existing,
            lastModel: input.model,
            turns: existing.turns + 1,
            continuations: existing.continuations + (input.continuation ? 1 : 0),
            promptTokens: existing.promptTokens + input.usage.promptTokens,
            uncachedInputTokens: existing.uncachedInputTokens + input.usage.uncachedInputTokens,
            cachedInputTokens: existing.cachedInputTokens + input.usage.cachedInputTokens,
            completionTokens: existing.completionTokens + input.usage.completionTokens,
            reasoningTokens: existing.reasoningTokens + input.usage.reasoningTokens,
            totalTokens: existing.totalTokens + input.usage.totalTokens,
            lastTtftMs: ttftMs,
            lastTps: tps,
            lastActiveAt: now,
          }
      this.sessions.set(input.sessionKey, next)
      while (this.sessions.size > this.maxSessions) {
        const oldest = this.sessions.keys().next().value
        if (oldest === undefined) break
        this.sessions.delete(oldest)
      }
    }

    this.lastTurn = {
      at: now,
      model: input.model,
      stream: input.stream,
      continuation: input.continuation,
      promptTokens: input.usage.promptTokens,
      uncachedInputTokens: input.usage.uncachedInputTokens,
      cachedInputTokens: input.usage.cachedInputTokens,
      completionTokens: input.usage.completionTokens,
      reasoningTokens: input.usage.reasoningTokens,
      totalTokens: input.usage.totalTokens,
      ttftMs,
      durationMs,
      decodeMs,
      tps,
      upstreamContextWindow: input.upstreamContextWindow ?? null,
      upstreamFirstPacketMs: input.upstreamFirstPacketMs ?? null,
      upstreamAckMs: input.upstreamAckMs ?? null,
    }
  }

  recordFailure(input: RecordFailureInput): void {
    const now = input.now ?? Date.now()
    const durationMs = sanitizeDuration(input.durationMs)
    this.updatedAt = now
    this.requests += 1
    this.failed += 1
    this.totalDurationMs += durationMs
    const modelEntry = this.getOrInitModel(input.model)
    modelEntry.requests += 1
    modelEntry.failed += 1
  }

  reset(now: number = Date.now()): void {
    this.startedAt = now
    this.updatedAt = now
    this.requests = 0
    this.succeeded = 0
    this.failed = 0
    this.continuations = 0
    this.promptTokens = 0
    this.uncachedInputTokens = 0
    this.cachedInputTokens = 0
    this.completionTokens = 0
    this.reasoningTokens = 0
    this.totalTokens = 0
    this.ttftSumMs = 0
    this.ttftSamples = 0
    this.decodeMs = 0
    this.decodeTokens = 0
    this.totalDurationMs = 0
    this.lastTurn = null
    this.byModel.clear()
    this.sessions.clear()
  }

  snapshot(activeConversations = 0): DoubaoStatsView {
    const cacheHitRate = this.promptTokens > 0
      ? Number(Math.min(1, this.cachedInputTokens / this.promptTokens).toFixed(4))
      : null
    return {
      ok: true,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      activeConversations,
      totals: {
        requests: this.requests,
        succeeded: this.succeeded,
        failed: this.failed,
        continuations: this.continuations,
        promptTokens: this.promptTokens,
        uncachedInputTokens: this.uncachedInputTokens,
        cachedInputTokens: this.cachedInputTokens,
        completionTokens: this.completionTokens,
        reasoningTokens: this.reasoningTokens,
        totalTokens: this.totalTokens,
        cacheHitRate,
        avgTtftMs: this.ttftSamples > 0 ? Math.round(this.ttftSumMs / this.ttftSamples) : null,
        avgTps: computeTps(this.decodeTokens, this.decodeMs),
        totalDurationMs: this.totalDurationMs,
        decodeMs: this.decodeMs,
        decodeTokens: this.decodeTokens,
      },
      byModel: [...this.byModel.values()],
      sessions: [...this.sessions.values()].reverse(),
      lastTurn: this.lastTurn,
    }
  }
}
