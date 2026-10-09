/**
 * Doubao quota.
 *
 * Doubao does NOT expose rate-limit headers on the chat endpoint — there is no
 * `x-ratelimit-*` and no `x-event-states-limit`. The authoritative source is a
 * separate summary endpoint that the desktop app calls on launch.
 *
 * It reports `window_limit_groups[].window_limits[]`, where each entry is one
 * rolling consumption window:
 *
 *   window_type 1 -> 5-hour limit   (verified: end_time - start_time = 18e6 ms)
 *   window_type 2 -> weekly quota    (verified: end_time - start_time = 604.8e6 ms)
 *
 * The window length was confirmed arithmetically from the server's own
 * timestamps rather than inferred from the UI, so the mapping is pinned.
 */
import { loadDoubaoCredentials } from './doubao-auth.ts'
import { buildHeaders, buildQueryUrl, QUOTA_ENDPOINT } from './doubao-upstream.ts'

/** Quota results are cached briefly so a chatty session does not hammer the API. */
export const QUOTA_TTL_MS = 5 * 60 * 1000

export type QuotaWindowType = 'five_hour' | 'weekly'

export interface QuotaWindow {
  type: QuotaWindowType
  /** Raw window_type from the server. */
  windowType: number
  /** Percent of this window already consumed, 0-100. */
  usedPercent: number
  /** Percent still available, 0-100. */
  remainingPercent: number
  /** Epoch ms when this window resets. Drives the countdown. */
  resetsAt: number
  /** Epoch ms when the window opened. */
  startedAt: number
  /** Window length in ms, derived from the server's own timestamps. */
  windowMs: number
  /**
   * True when `resetsAt` was reconstructed from the nominal window length
   * because the server reported zeroed timestamps. A UI should treat this
   * instant as approximate.
   */
  estimatedReset?: boolean
}

export interface DoubaoQuota {
  /** True when Doubao reports all entitlements exhausted. */
  exhausted: boolean
  windows: QuotaWindow[]
  /** Subscription identity, when the account has one. */
  plan?: string
  planActive?: boolean
  /** Epoch ms when this reading was taken. */
  fetchedAt: number
  /** Populated when the quota could not be read. */
  error?: string
}

interface RawWindowLimit {
  window_type?: number
  item_type?: number
  used_percent?: number
  less_than_one_percent?: boolean
  start_time?: number
  end_time?: number
}

function mapWindowType(value: number): QuotaWindowType | undefined {
  if (value === 1) return 'five_hour'
  if (value === 2) return 'weekly'
  return undefined
}

/**
 * Nominal length of each rolling window, in ms.
 *
 * Verified arithmetically from the server's own timestamps in M2 (5-hour:
 * end-start = 18e6; weekly: 604.8e6). Used ONLY to reconstruct a reset instant
 * when the server reports a window with zeroed timestamps — see
 * {@link normalizeWindow}.
 */
const WINDOW_MS: Readonly<Record<QuotaWindowType, number>> = {
  five_hour: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
}

/**
 * Convert one server window into the shape the UI consumes.
 *
 * A window can come back with `start_time` and `end_time` both zero — observed
 * on a freshly-reset 5-hour window. Passing that through verbatim would render
 * a reset countdown of `0`, i.e. "resets right now", which is worse than
 * useless: the user would read the window as expired while it is actually
 * brand new and fully available. The window LENGTH is still known (it is fixed
 * per window type), so a zeroed window is reconstructed as "opened now, resets
 * one period from now", which is what the server means.
 */
export function normalizeWindow(raw: RawWindowLimit, now = Date.now()): QuotaWindow | undefined {
  const type = raw.window_type === undefined ? undefined : mapWindowType(raw.window_type)
  if (!type) return undefined
  const start = raw.start_time ?? 0
  const end = raw.end_time ?? 0
  const used = raw.used_percent ?? 0
  const degraded = start <= 0 || end <= 0
  const effectiveStart = degraded ? now : start
  const effectiveEnd = degraded ? now + WINDOW_MS[type] : end
  return {
    type,
    windowType: raw.window_type as number,
    usedPercent: used,
    remainingPercent: Math.max(0, 100 - used),
    resetsAt: effectiveEnd,
    startedAt: effectiveStart,
    windowMs: effectiveEnd > effectiveStart ? effectiveEnd - effectiveStart : 0,
    /** True when the reset instant was reconstructed rather than reported. */
    estimatedReset: degraded,
  }
}

/**
 * Read the account's current quota.
 *
 * Never throws: an unreachable endpoint yields a `DoubaoQuota` carrying an
 * `error`, because a quota panel failure must not take down a chat request.
 */
export async function fetchQuota(options: { force?: boolean } = {}): Promise<DoubaoQuota> {
  const now = Date.now()
  if (!options.force && cached && now - cached.fetchedAt < QUOTA_TTL_MS) {
    return cached
  }

  const credentials = loadDoubaoCredentials()
  if (!credentials.ok) {
    return {
      exhausted: false,
      windows: [],
      fetchedAt: now,
      error: credentials.reason ?? 'Doubao credentials unavailable.',
    }
  }

  try {
    const response = await fetch(buildQueryUrl(QUOTA_ENDPOINT, credentials.pairs.get('msToken')), {
      method: 'POST',
      headers: buildHeaders(credentials, { 'content-type': 'application/json' }),
      body: JSON.stringify({ product_line: 'membership' }),
    })
    if (!response.ok) {
      return { exhausted: false, windows: [], fetchedAt: now, error: `HTTP ${response.status}` }
    }
    const payload = (await response.json()) as {
      data?: {
        window_limit_section?: {
          usage_exhausted?: boolean
          window_limit_groups?: Array<{ window_limits?: RawWindowLimit[] }>
        }
        enterprise_window_limit_section?: { usage_exhausted?: boolean }
        current_subscription?: { display?: { short_name?: string; product_name?: string } }
        member_info?: { hasActiveSubscription?: boolean }
      }
    }

    const groups = payload.data?.window_limit_section?.window_limit_groups ?? []
    const windows: QuotaWindow[] = []
    for (const group of groups) {
      for (const limit of group.window_limits ?? []) {
        const normalized = normalizeWindow(limit)
        if (normalized) windows.push(normalized)
      }
    }

    const quota: DoubaoQuota = {
      exhausted:
        payload.data?.window_limit_section?.usage_exhausted === true ||
        payload.data?.enterprise_window_limit_section?.usage_exhausted === true,
      windows,
      fetchedAt: now,
    }
    const plan = payload.data?.current_subscription?.display?.short_name
    if (plan) quota.plan = plan
    if (payload.data?.member_info?.hasActiveSubscription !== undefined) {
      quota.planActive = payload.data.member_info.hasActiveSubscription
    }

    cached = quota
    return quota
  } catch (error) {
    return { exhausted: false, windows: [], fetchedAt: now, error: (error as Error).message }
  }
}

let cached: DoubaoQuota | undefined

/** Drop the cached reading so the next call hits the server. */
export function invalidateQuotaCache(): void {
  cached = undefined
}

/** Convenience lookup for a specific window. */
export function findWindow(quota: DoubaoQuota, type: QuotaWindowType): QuotaWindow | undefined {
  return quota.windows.find((window) => window.type === type)
}

/**
 * Milliseconds until a window resets, clamped at zero.
 * Drives the countdown the user asked for.
 */
export function millisUntilReset(window: QuotaWindow, now = Date.now()): number {
  return Math.max(0, window.resetsAt - now)
}

/** Human-readable duration, e.g. `4h 12m`. */
export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const parts: string[] = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (minutes) parts.push(`${minutes}m`)
  if (!days && !hours && seconds) parts.push(`${seconds}s`)
  return parts.join(' ') || '0s'
}