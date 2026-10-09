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
import { doubaoCatalogEntries } from './doubao-catalog.ts'
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
export function registerDoubaoCatalogRoute(ctx: { webServer: WebServerLike }): () => void {
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
      const payload: DoubaoCatalogView = { ok: true, models: doubaoCatalogEntries(), error: null }
      json(res, 200, payload)
    },
  })
}