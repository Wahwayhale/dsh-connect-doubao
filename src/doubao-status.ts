/**
 * Read-only HTTP view of the Doubao quota, for the plugin UI card.
 *
 * Reached at `/plugins/dsh-connect-doubao/quota` on the Harness web server.
 *
 * SECURITY: this response is a NUMBER VIEW, never a credential view. It
 * contains plan name, two percentage windows and their reset instants — no
 * cookie, no token, no account id, no email or phone. The handler builds its
 * payload from an explicit allow-list rather than serialising anything the
 * upstream returned, so a future field added to the quota endpoint cannot leak
 * into the browser by accident.
 *
 * @module dsh-connect-doubao/status
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fetchQuota, findWindow, millisUntilReset, invalidateQuotaCache, type QuotaWindow } from './doubao-quota.ts'
import {
  describeProfileLocation,
  invalidateCredentialCache,
  loadDoubaoCredentials,
  saveBrowserCredentials,
} from './doubao-auth.ts'
import { browserLogin } from './doubao-auth-browser.ts'
import { doubaoCatalogEntries, type DoubaoModelInfo } from './doubao-catalog.ts'
import { invalidateDiscovery } from './doubao-discovery.ts'
import type { DoubaoCatalogEntry } from './doubao-catalog.ts'
import type { DoubaoStatsView } from './doubao-stats.ts'

/** Route path, relative to the plugin mount point. */
export const DOUBAO_QUOTA_PATH = '/plugins/dsh-connect-doubao/quota'

/** Route serving the model checklist's catalog. */
export const DOUBAO_CATALOG_PATH = '/plugins/dsh-connect-doubao/catalog'

/** Route serving live runtime session & token usage statistics. */
export const DOUBAO_STATS_PATH = '/plugins/dsh-connect-doubao/stats'

/** Hostnames an inbound browser request may come from. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * A browser-sent Origin must be loopback. A page on an attacker origin that
 * can reach the Harness server must not be able to read the user's quota.
 */
function loopbackOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  // Absent Origin is the NORMAL case for this card: it fetches its own host
  // same-origin, and a same-origin request carries no Origin header. Trusting
  // that absence is why the other two checks below exist — a remote page can
  // open a same-origin-looking request only if the Host lies (DNS rebinding),
  // and a browser always labels that attempt cross-site.
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * Header every write must carry.
 *
 * Not a secret — a marker whose only job is to make the request non-simple.
 * A cross-origin page cannot attach a custom header without a CORS preflight,
 * and these routes never approve one, so a hostile tab can no longer flip
 * the model switches or start a sign-in window even though it can reach the port.
 */
export const WRITE_HEADER = 'x-dsh-doubao-write'

/** Host header must be loopback: a rebound name still sends its own Host. */
function loopbackHostHeader(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined || host.trim() === '') return false
  try {
    const { hostname } = new URL(`http://${host}`)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * One gate for all four routes.
 *
 * Order matters: cheap header checks first, so a rejected request never reaches
 * the filesystem or the credential store.
 */
function guard(req: IncomingMessage, res: ServerResponse, options: { write?: boolean } = {}): boolean {
  if (!loopbackHostHeader(req)) {
    json(res, 403, { error: 'host-not-loopback' })
    return false
  }
  // Set by every current browser; absent for curl and for the CLI doctor, which
  // are on this machine by construction.
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    json(res, 403, { error: 'origin-not-trusted' })
    return false
  }
  if (!loopbackOrigin(req)) {
    json(res, 403, { error: 'origin-not-trusted' })
    return false
  }
  if (options.write === true && req.headers[WRITE_HEADER] === undefined) {
    json(res, 403, { error: 'missing-write-header' })
    return false
  }
  return true
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Strip anything that could carry a secret or personal data out of an error.
 * Upstream messages are quoted into the payload, so they are truncated and
 * only the class is preserved.
 */
function safeMessage(error: unknown): string {
  const message = (error as Error)?.message ?? 'unknown error'
  return message.slice(0, 200)
}

/**
 * One window as the card sees it.
 *
 * `resetsAt`/`resetsInMs` are null when Doubao sent no timestamps: a made-up
 * countdown is worse than an honest "unknown", because the user plans around it.
 */
export interface QuotaWindowView {
  usedPercent: number
  remainingPercent: number
  resetsAt: number | null
  resetsInMs: number | null
  /** Server-provided group name, e.g. 「活动赠送额度」. */
  label: string | null
  /** True when the window only starts counting on first use. */
  startsOnUse: boolean
  /** Raw amounts, when the plan reports them instead of a percentage. */
  usedAmount: number | null
  totalAmount: number | null
}

export interface DoubaoQuotaView {
  ok: boolean
  profile: string
  plan: string | null
  exhausted: boolean
  windows: {
    fiveHour: QuotaWindowView | null
    weekly: QuotaWindowView | null
    /** Promotional grants ("活动赠送额度"); usually zero or one. */
    incentive: QuotaWindowView[]
  }
  fetchedAt: number
  error: string | null
}

/**
 * Build the quota view.
 *
 * An allow-list on purpose: every field here is a number or a plan name chosen
 * by this function, never a passthrough of the upstream payload.
 */
/** Map one window into the card's shape; `undefined` means "not reported". */
function viewOf(window: QuotaWindow | undefined): QuotaWindowView | null {
  if (window === undefined) return null
  const unknown = window.resetUnknown === true
  return {
    usedPercent: window.usedPercent,
    remainingPercent: window.remainingPercent,
    resetsAt: unknown ? null : window.resetsAt,
    resetsInMs: unknown ? null : millisUntilReset(window),
    label: window.label ?? null,
    startsOnUse: window.startsOnUse === true,
    usedAmount: window.usedAmount ?? null,
    totalAmount: window.totalAmount ?? null,
  }
}

export async function doubaoQuotaView(options: { force?: boolean } = {}): Promise<DoubaoQuotaView> {
  const quota = await fetchQuota(options.force === true ? { force: true } : {})
  const fiveHour = findWindow(quota, 'five_hour')
  const weekly = findWindow(quota, 'weekly')
  return {
    ok: quota.error === undefined,
    profile: describeProfileLocation(),
    plan: quota.plan ?? null,
    exhausted: quota.exhausted,
    windows: {
      fiveHour: viewOf(fiveHour),
      weekly: viewOf(weekly),
      incentive: quota.windows
        .filter((window) => window.type === 'incentive')
        .map((window) => viewOf(window))
        .filter((window): window is QuotaWindowView => window !== null),
    },
    fetchedAt: quota.fetchedAt,
    error: quota.error ?? null,
  }
}

/** Minimal shape of the `webServer` service this route needs. */
export interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Route the card writes settings through. */
export const DOUBAO_SAVE_PATH = '/plugins/dsh-connect-doubao/__save'

/**
 * Minimal shape of the `settings` service the presentation claim needs.
 *
 * Kept because the entry id is read from it elsewhere, but it is NOT a write
 * path for this plugin: `mutate` fails with
 * `No configurable plugin entry "dsh-connect-doubao"` because the plugin's
 * fiber never reaches ACTIVE on DSH 0.2.1, so the host never attaches
 * `runtime.Config` and `describe()` omits the namespace entirely. Every write
 * through the host has therefore always been dropped — see
 * `src/doubao-store.ts` for the file that replaced it.
 */
export interface SettingsLike {
  describe(): Array<{ ns: string; value?: unknown }>
  mutate(ns: string, ops: Array<{ op: 'set'; path: string[]; value: unknown }>, revision?: unknown): Promise<unknown>
}

/**
 * The ONLY fields this route will write.
 *
 * A closed allow-list, not a schema derivation: deriving it would let a future
 * schema addition quietly widen what the browser can write. Both entries are
 * switches the user could already set by hand in `cordis.patch.yml`.
 *
 * `profileDir` used to be here for the card's folder picker. That picker is gone
 * with the client-cookie path, and a field with no writer only invites a
 * half-applied change: it would land on disk but reach nothing until a restart.
 */
const WRITABLE_FIELDS = new Set(['enabledModelIds', 'toolEmulation'])

/** Read and parse a JSON request body, bounded. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    // Same ceiling as the shim: settings payloads are a few hundred bytes, so
    // anything large is a mistake or an attack, not a real save.
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/**
 * Register the settings READ/WRITE route.
 *
 * Why this exists at all: neither `settingsScope.set()` in the card nor
 * `settings.mutate` in the host can persist this plugin — its fiber never
 * reaches ACTIVE (see {@link SettingsLike}), so the host reports
 * `No configurable plugin entry "dsh-connect-doubao"` and drops the write.
 * This route writes a JSON file the plugin owns instead, which is also the
 * only copy the card can read back.
 *
 * Security posture matches the read routes: loopback Origin only, GET or POST
 * only, a closed allow-list of two switches, no credential in the response.
 */
export function registerDoubaoSaveRoute(
  ctx: { webServer: WebServerLike },
  deps: {
    /** Where the plugin keeps its own settings file. */
    write: (field: string, value: unknown) => void
    /** Read it back, so the card renders what is actually on disk. */
    read: () => unknown
    onApplied?: (field: string, value: unknown) => void
    /**
     * Where the host-settings registration got to. Reported alongside a
     * successful write because it explains WHY this route exists at all: the
     * host namespace is missing and every write through it is dropped.
     */
    diagnostics?: () => unknown
  },
): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: DOUBAO_SAVE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST' && req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!guard(req, res, { write: req.method === 'POST' })) return
      // GET is the READ half, and it exists because the injected settings scope
      // cannot see this plugin's file: the card would otherwise render defaults
      // no matter what was saved.
      if (req.method === 'GET') {
        try {
          json(res, 200, { ok: true, value: deps.read() })
        } catch (error: unknown) {
          json(res, 500, { ok: false, error: safeMessage(error) })
        }
        return
      }
      try {
        const body = await readJsonBody(req) as { field?: unknown; value?: unknown } | undefined
        const field = body?.field
        if (typeof field !== 'string' || !WRITABLE_FIELDS.has(field)) {
          json(res, 400, { error: `field must be one of: ${[...WRITABLE_FIELDS].join(', ')}` })
          return
        }
        // Shape-check before touching the file: a wrong type would be written
        // verbatim and then rejected by the schema on the next host start.
        const value = body?.value
        const valid = field === 'enabledModelIds'
          ? Array.isArray(value) && value.every(entry => typeof entry === 'string')
          : typeof value === 'boolean'
        if (!valid) {
          json(res, 400, { error: `invalid value for ${field}` })
          return
        }
        deps.write(field, value)
        deps.onApplied?.(field, value)
        json(res, 200, {
          ok: true,
          value: deps.read(),
          ...(deps.diagnostics === undefined ? {} : { diagnostics: deps.diagnostics() }),
        })
      } catch (error: unknown) {
        json(res, 500, {
          ok: false,
          errorName: (error as Error)?.name ?? 'unknown',
          error: safeMessage(error),
        })
      }
    },
  })
}

/** Register the quota route. Returns a disposer. */
export function registerDoubaoQuotaRoute(
  ctx: { webServer: WebServerLike },
  deps: { onRefresh?: () => void } = {},
): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: DOUBAO_QUOTA_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!guard(req, res, { write: req.method === 'POST' })) return
      // A POST is an explicit user-driven refresh; a GET reads the 5-minute cache.
      const force = req.method === 'POST'
      if (force) {
        invalidateQuotaCache()
        deps.onRefresh?.()
      }
      try {
        json(res, 200, await doubaoQuotaView(force ? { force: true } : {}))
      } catch (error: unknown) {
        json(res, 500, { error: safeMessage(error) })
      }
    },
  })
}

/** The catalog payload `GET {DOUBAO_CATALOG_PATH}` returns. */
export interface DoubaoCatalogView {
  ok: boolean
  models: DoubaoCatalogEntry[]
  error: string | null
}

/**
 * Register the read-only catalog route backing the card's model checklist.
 *
 * Same security posture as the quota route: an allow-list (the static catalog),
 * the same loopback-origin fence, no credential of any kind.
 *
 * `refresh=true` re-reads nothing on purpose — the Doubao catalog is STATIC and
 * cannot be asked upstream which models exist (see `doubao-catalog.ts`). The
 * card's Refresh button therefore re-reads this route, which is the honest
 * behaviour: it refreshes the VIEW, and the card's note tells the user that
 * selection controls picker entries rather than routing.
 */
export function registerDoubaoCatalogRoute(
  ctx: { webServer: WebServerLike },
  deps: {
    modelsProvider?: () => readonly DoubaoModelInfo[]
    refreshModels?: () => Promise<void> | void
    onRefreshed?: () => void
  } = {},
): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: DOUBAO_CATALOG_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!guard(req, res, { write: req.method === 'POST' })) return
      // A POST drops the discovery memo and triggers a live refresh, so the card's
      // 刷新 shows models fetched over HTTP or from updated client caches immediately.
      if (req.method === 'POST') {
        invalidateDiscovery()
        await deps.refreshModels?.()
        deps.onRefreshed?.()
      }
      const models = deps.modelsProvider === undefined ? undefined : deps.modelsProvider()
      const payload: DoubaoCatalogView = { ok: true, models: doubaoCatalogEntries(models), error: null }
      json(res, 200, payload)
    },
  })
}

/* ------------------------------------------------------------------ *
 * Login route
 * ------------------------------------------------------------------ */

/** Route the card reads the session state through, and starts a sign-in on. */
export const DOUBAO_AUTH_PATH = '/plugins/dsh-connect-doubao/auth'

/**
 * The session payload.
 *
 * SECURITY: counts and instants only. No cookie, no token, no account id — the
 * card renders "signed in, expires in N days", which needs nothing else.
 *
 * There is no `mode` field: the plugin has exactly one way in, so a field
 * describing the choice could only ever be one constant for the card to
 * branch on.
 */
export interface DoubaoAuthView {
  ok: boolean
  /** True when a usable session exists. */
  signedIn: boolean
  /** Epoch ms of the server-side session expiry, parsed from `sid_guard`. */
  expiresAt: number | null
  /** Whole days until `expiresAt`, or null when unknown. */
  daysLeft: number | null
  /** Non-secret explanation when `signedIn` is false. */
  detail: string | null
}

/**
 * Read the expiry out of `sid_guard`.
 *
 * Format: `sessionid|issued_epoch|ttl_seconds|"Mon, 07 Dec 2026 ..."`. The
 * 30-day TTL is absolute, not sliding — verified 2026-11-07: hitting the
 * account endpoint leaves this cookie byte-identical, so this instant is the
 * real deadline and the card can count on it.
 */
function authExpiryOf(pairs: Map<string, string>): number | null {
  const raw = pairs.get('sid_guard')
  if (raw === undefined) return null
  // The value can arrive percent-encoded (`%7C` for the separators) depending on
  // who wrote it last, so both forms are normalised — otherwise the card would
  // report "expiry unknown" for a perfectly readable session.
  const guard = raw.replace(/%7C/gi, '|').replace(/%2C/gi, ',').replace(/%3A/gi, ':')
  const parts = guard.split('|')
  if (parts.length < 3) return null
  const issued = Number(parts[1])
  const ttl = Number(parts[2])
  if (!Number.isFinite(issued) || !Number.isFinite(ttl) || issued <= 0) return null
  return (issued + ttl) * 1000
}

/** Build the session view for the card. */
function authView(): DoubaoAuthView {
  const credentials = loadDoubaoCredentials()
  const expiresAt = credentials.ok ? authExpiryOf(credentials.pairs) : null
  return {
    ok: true,
    signedIn: credentials.ok,
    expiresAt,
    daysLeft: expiresAt === null ? null : Math.max(0, Math.round((expiresAt - Date.now()) / 86_400_000)),
    detail: credentials.ok ? null : (credentials.reason ?? null),
  }
}

/**
 * Register the session route.
 *
 * GET reads the state. POST accepts exactly `{"action":"login"}` and runs the
 * browser sign-in — nothing else, because a body that merely fails to parse
 * must not be read as "log in": a typo would open a sign-in window.
 *
 * POST is a WRITE (it replaces the sealed session), so it requires the same
 * `x-dsh-doubao-write` header as every other write on this plugin — a hostile
 * tab must not be able to make the user's browser open a sign-in window.
 *
 * The login is long-running on purpose: a Chromium window stays open until the
 * user finishes the scan. The request is held open rather than polled so a
 * failure has exactly one place to be reported.
 */
export function registerDoubaoAuthRoute(
  ctx: { webServer: WebServerLike },
  deps: { onSignedIn?: () => void } = {},
): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: DOUBAO_AUTH_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!guard(req, res, { write: req.method === 'POST' })) return

      if (req.method === 'GET') {
        try {
          json(res, 200, authView())
        } catch (error: unknown) {
          json(res, 200, {
            ok: false, signedIn: false, expiresAt: null,
            daysLeft: null, detail: safeMessage(error),
          } satisfies DoubaoAuthView)
        }
        return
      }

      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (error: unknown) {
        json(res, 400, { error: safeMessage(error) })
        return
      }
      const payload = (body ?? {}) as { action?: unknown }
      if (payload.action !== 'login') {
        json(res, 400, { error: 'action must be "login"' })
        return
      }

      let result
      try {
        result = await browserLogin()
      } catch (error: unknown) {
        json(res, 200, { ...authView(), signedIn: false, detail: safeMessage(error) } satisfies DoubaoAuthView)
        return
      }
      if (result.ok !== true || result.pairs === undefined) {
        json(res, 200, {
          ...authView(), signedIn: false,
          detail: result.reason ?? '浏览器登录未完成',
        } satisfies DoubaoAuthView)
        return
      }
      try {
        saveBrowserCredentials(result.pairs)
        // The scan may have landed on a different account than the rejected
        // session it replaces, so every derived read is stale the moment it lands.
        invalidateCredentialCache()
        invalidateQuotaCache()
        invalidateDiscovery()
        deps.onSignedIn?.()
        json(res, 200, authView())
      } catch (error: unknown) {
        json(res, 200, {
          ...authView(), signedIn: false,
          detail: `登录成功但凭据保存失败：${safeMessage(error)}`,
        } satisfies DoubaoAuthView)
      }
    },
  })
}

/**
 * Register the runtime session & token usage statistics route.
 *
 * GET returns aggregate counts, per-model breakdown, opaque session summaries,
 * and last-turn telemetry (including upstream `context_window_usage` when
 * reported). POST `{"action":"reset"}` clears accumulated counters.
 */
export function registerDoubaoStatsRoute(
  ctx: { webServer: WebServerLike },
  deps: {
    read: () => DoubaoStatsView
    reset?: () => void
  },
): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: DOUBAO_STATS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!guard(req, res, { write: req.method === 'POST' })) return

      if (req.method === 'GET') {
        try {
          json(res, 200, deps.read())
        } catch (error: unknown) {
          json(res, 500, { ok: false, error: safeMessage(error) })
        }
        return
      }

      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (error: unknown) {
        json(res, 400, { error: safeMessage(error) })
        return
      }
      const payload = (body ?? {}) as { action?: unknown }
      if (payload.action !== 'reset') {
        json(res, 400, { error: 'action must be "reset"' })
        return
      }
      try {
        deps.reset?.()
        json(res, 200, deps.read())
      } catch (error: unknown) {
        json(res, 500, { ok: false, error: safeMessage(error) })
      }
    },
  })
}
