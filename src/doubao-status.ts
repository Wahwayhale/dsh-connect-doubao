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
import { fetchQuota, findWindow, millisUntilReset, invalidateQuotaCache } from './doubao-quota.ts'
import { describeProfileLocation } from './doubao-auth.ts'
import { doubaoCatalogEntries, type DoubaoModelInfo } from './doubao-catalog.ts'
import { invalidateDiscovery } from './doubao-discovery.ts'
import type { DoubaoCatalogEntry } from './doubao-catalog.ts'

/** Route path, relative to the plugin mount point. */
export const DOUBAO_QUOTA_PATH = '/plugins/dsh-connect-doubao/quota'

/** Route serving the model checklist's catalog. */
export const DOUBAO_CATALOG_PATH = '/plugins/dsh-connect-doubao/catalog'

/** Hostnames an inbound browser request may come from. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * A browser-sent Origin must be loopback. A page on an attacker origin that
 * can reach the Harness server must not be able to read the user's quota.
 */
function loopbackOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
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

export interface DoubaoQuotaView {
  ok: boolean
  profile: string
  plan: string | null
  exhausted: boolean
  windows: {
    fiveHour: { usedPercent: number; remainingPercent: number; resetsAt: number; resetsInMs: number } | null
    weekly: { usedPercent: number; remainingPercent: number; resetsAt: number; resetsInMs: number } | null
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
      fiveHour: fiveHour === undefined
        ? null
        : {
            usedPercent: fiveHour.usedPercent,
            remainingPercent: fiveHour.remainingPercent,
            resetsAt: fiveHour.resetsAt,
            resetsInMs: millisUntilReset(fiveHour),
          },
      weekly: weekly === undefined
        ? null
        : {
            usedPercent: weekly.usedPercent,
            remainingPercent: weekly.remainingPercent,
            resetsAt: weekly.resetsAt,
            resetsInMs: millisUntilReset(weekly),
          },
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
      if (!loopbackOrigin(req)) {
        json(res, 403, { error: 'origin-not-trusted' })
        return
      }
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
      if (!loopbackOrigin(req)) {
        json(res, 403, { error: 'origin-not-trusted' })
        return
      }
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
  deps: { modelsProvider?: () => readonly DoubaoModelInfo[] } = {},
): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: DOUBAO_CATALOG_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!loopbackOrigin(req)) {
        json(res, 403, { error: 'origin-not-trusted' })
        return
      }
      // A POST drops the discovery memo, so the card's 刷新 re-reads the client
      // cache and a model Doubao just shipped can appear without restarting DSH.
      if (req.method === 'POST') invalidateDiscovery()
      const models = deps.modelsProvider === undefined ? undefined : deps.modelsProvider()
      const payload: DoubaoCatalogView = { ok: true, models: doubaoCatalogEntries(models), error: null }
      json(res, 200, payload)
    },
  })
}