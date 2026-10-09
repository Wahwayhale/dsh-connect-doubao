/**
 * Shared contract between the host routes and the browser card.
 *
 * The types here are a MIRROR of what `src/doubao-status.ts` actually sends.
 * They are duplicated rather than imported so the browser bundle never pulls in
 * a Node module (`node:http`, the cookie jar) — importing the real route file
 * from client code would drag DPAPI and the filesystem into the renderer.
 *
 * SECURITY: this is a NUMBER view. No cookie, no token, no account id, no email
 * or phone ever crosses this boundary, and the card renders nothing else.
 *
 * @module dsh-connect-doubao/client-contract
 */

/** Route the card reads, relative to the Harness web server origin. */
export const DOUBAO_QUOTA_PATH = '/plugins/dsh-connect-doubao/quota'

/** One consumption window as the card consumes it. */
export interface DoubaoQuotaWindowView {
  /** Percent of this window already consumed, 0-100. */
  usedPercent: number
  /** Percent still available, 0-100. */
  remainingPercent: number
  /** Epoch ms when this window resets. */
  resetsAt: number
  /** Epoch ms until reset, as computed host-side. */
  resetsInMs: number
}

/** The quota payload `GET|POST {DOUBAO_QUOTA_PATH}` returns. */
export interface DoubaoQuotaView {
  ok: boolean
  /** Where the Doubao profile was found. A path, never a credential. */
  profile: string
  /** Subscription name, e.g. 「标准套餐」. */
  plan: string | null
  /** True when Doubao reports all entitlements consumed. */
  exhausted: boolean
  windows: {
    fiveHour: DoubaoQuotaWindowView | null
    weekly: DoubaoQuotaWindowView | null
  }
  /** Epoch ms when this reading was taken. */
  fetchedAt: number
  /** Host-side failure text, or null. */
  error: string | null
}

/**
 * How the card should explain the current state.
 *
 * `signed_out` and `unreadable` are deliberately DIFFERENT: the first is a fix
 * the user performs in the Doubao app, the second is a local failure this plugin
 * cannot diagnose further — collapsing them into one "not signed in" message
 * sends the user to re-login when re-login cannot possibly help.
 */
export type DoubaoAccountState =
  /** Quota read cleanly. */
  | 'ok'
  /** Doubao holds no usable session cookie. Re-login in the app fixes this. */
  | 'signed_out'
  /** Credentials exist but could not be read (DPAPI / profile missing). */
  | 'unreadable'
  /** Upstream refused the session as dead. Re-login fixes this. */
  | 'session_dead'
  /** Risk-control slider. Only the Doubao app can clear it. */
  | 'risk_challenge'
  /** Quota fully consumed; the window must reset. */
  | 'exhausted'
  /** Network/timeout reaching Doubao. */
  | 'network'

/**
 * Classify the payload into one account state.
 *
 * Classification is done from the HOST's error text plus the view's own shape,
 * because the host is the only side that can see the upstream error class. The
 * text is matched loosely on purpose: the host owns the wording, this side owns
 * the presentation, and a wording change must degrade to `network` rather than
 * crash the card.
 */
export function classifyQuotaView(view: DoubaoQuotaView | undefined): DoubaoAccountState {
  if (view === undefined) return 'unreadable'
  if (view.ok) return view.exhausted ? 'exhausted' : 'ok'
  const text = (view.error ?? '').toLowerCase()
  // A missing profile or a failed decrypt is a LOCAL read failure, not a
  // sign-out: re-logging into the app changes nothing.
  if (/credential|password data|dpapi|decrypt|profile|encrypted_key|local state/i.test(text)) return 'unreadable'
  if (/session cookie|sign in|login|710012001|session_dead/i.test(text)) return 'signed_out'
  if (/710022004|risk|slider|captcha|rate.?limit/i.test(text)) return 'risk_challenge'
  return 'network'
}

/** Milliseconds → a compact 「3 小时 12 分」 style countdown. */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return '<1m'
}

/**
 * One catalog entry for the checklist.
 *
 * `id` IS the `model_item_key` the host puts on the wire, so ticking an entry
 * genuinely selects that model — unlike earlier revisions of this contract,
 * which claimed Doubao routed on content and exposed an `upstreamRouted` flag.
 * That claim was wrong and the flag is gone.
 *
 * `reasoningLevels[].verified` is carried through from the host so a future
 * level the server adds can be surfaced as provisional; all three levels this
 * plugin currently ships are verified against the live client.
 */
export interface DoubaoReasoningLevelEntry {
  id: string
  name: string
  /** Doubao's ordinal; sent as `reasoning_effort` and `need_deep_think - 10000`. */
  level: number
  /** True when the value was observed on a real request. */
  verified: boolean
}

export interface DoubaoModelEntry {
  /** The real `model_item_key`, verbatim. */
  id: string
  name: string
  /** Status badge from the desktop app ("0921 新版", "即将下线"), else null. */
  badge: string | null
  reasoningLevels: DoubaoReasoningLevelEntry[]
}

/** The catalog payload the checklist reads. */
export interface DoubaoCatalogView {
  ok: boolean
  models: DoubaoModelEntry[]
  error: string | null
}

/** Host-side route serving the catalog for the checklist. */
export const DOUBAO_CATALOG_PATH = '/plugins/dsh-connect-doubao/catalog'

/** Settings field holding the ticked entry ids. */
export const DOUBAO_ENABLED_MODELS_FIELD = 'enabledModelIds'

/**
 * Read the ticked ids out of a settings snapshot.
 *
 * A snapshot that has never been saved carries `undefined`, which means "never
 * configured" — NOT "nothing ticked". The caller seeds the draft from the
 * catalog in that case so a first-time user sees a usable, fully-ticked list
 * rather than an empty one they might mistake for a bug.
 */
export function enabledModelIdsOf(configured: unknown): string[] | undefined {
  const value = (configured as { enabledModelIds?: unknown } | undefined)?.enabledModelIds
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** Clamp a percentage into the 0-100 range the bars render. */
export function clampPercent(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}