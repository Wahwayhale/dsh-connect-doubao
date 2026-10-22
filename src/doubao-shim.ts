/**
 * Loopback shim for the Doubao route.
 *
 * pi-ai's OpenAI-completions API object wants an OpenAI-shaped HTTP endpoint.
 * Doubao speaks a private three-line streaming dialect at a different origin,
 * with credentials resolved out of a Chromium profile rather than a bearer
 * token. This shim is the boundary: it terminates an OpenAI-shaped request on
 * an ephemeral 127.0.0.1 port and speaks Doubao upstream.
 *
 * SECURITY. Everything in the inbound half is upstream-independent hardening
 * and is kept deliberately identical to `dsh-connect-workbuddy`'s shim:
 *
 *   * binds 127.0.0.1 only, on an ephemeral port;
 *   * Host header must name loopback (drops DNS-rebinding pages);
 *   * a browser-sent Origin must be loopback;
 *   * a per-process shared secret, compared in constant time, which pi-ai
 *     sends as `Authorization: Bearer`. The secret NEVER leaves this process
 *     and is never forwarded upstream — Doubao authenticates on the cookie
 *     jar, which the shim resolves per request;
 *   * chat POSTs must be `application/json`;
 *   * request bodies are size-capped.
 *
 * Nothing that leaves this process carries the shared secret except the
 * loopback hop, and nothing that arrives is trusted without passing all of the
 * above.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）；
 *   入站加固层的做法（loopback 绑定、Host/Origin 校验、常量时间 bearer 比对、
 *   JSON content-type 强制、body 上限）由该项目确立，本文件原样复用其安全策略。
 *
 * @module dsh-connect-doubao/shim
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { loadDoubaoCredentials, type DoubaoCredentials } from './doubao-auth.ts'
import { chat, DoubaoUpstreamError, classifyDoubaoFailure, type DoubaoErrorKind } from './doubao-upstream.ts'
import { fetchQuota, findWindow, millisUntilReset } from './doubao-quota.ts'
import { DOUBAO_MODELS, findDoubaoModel } from './doubao-catalog.ts'

/** Hostnames the inbound half will accept. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Cap on an inbound chat body. Doubao replies are short; anything larger is abuse. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Streaming idle ceiling while one read is outstanding. */
export const DOUBAO_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Strip a port and IPv6 brackets from a Host/Origin hostname. */
function hostnameOfHost(host: string): string {
  let hostname = host.trim()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/**
 * The Host header must name loopback. A DNS-rebinding page re-resolves an
 * attacker domain to 127.0.0.1 but still sends its own domain in Host, so this
 * drops those before any routing happens.
 */
function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * A browser-sent Origin must be loopback. Non-browser clients send no Origin
 * at all and pass.
 */
function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** HTTP status each Doubao failure class surfaces as. */
const KIND_STATUS: Readonly<Record<DoubaoErrorKind, number>> = {
  rate_limited: 429,
  quota_exhausted: 429,
  session_dead: 401,
  network: 502,
  upstream: 502,
  // 409, not 502: nothing is broken on the wire, and 502 would invite the host's
  // retry classifier to burn the budget on a state only a toggle can change.
  task_runtime_unavailable: 409,
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** OpenAI-shaped error envelope, which is what pi-ai parses. */
function writeOpenAIError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { error: { message, type: code, code } })
}

export interface DoubaoShim {
  /**
   * Origin pi-ai should point its OpenAI client at.
   *
   * Awaits the listening socket. `server.listen()` is asynchronous, so a
   * caller that reads `server.address()` immediately gets `null` — which is
   * exactly what happens when the adapter builds its first model snapshot
   * during registration, moments after the shim is created. Callers must
   * await this rather than assume the port is already bound.
   */
  baseUrl(): Promise<string>
  /** Per-process shared secret, handed to pi-ai as the OpenAI apiKey. */
  token(): string
  /**
   * Origin, or `undefined` while the socket is still binding.
   *
   * pi-ai's `getModels` is synchronous, so the adapter cannot await the port.
   * This is the sync view it reads; `baseUrl()` is the awaitable one used by
   * callers that can wait (the doctor, and the adapter's own warm-up).
   */
  baseUrlSync(): string | undefined
  /** Release the port. */
  close(): Promise<void>
}

/** Minimal OpenAI chat request shape the shim accepts. */
interface InboundChatRequest {
  model?: string
  messages?: Array<{ role?: string; content?: unknown }>
  stream?: boolean
  /**
   * Thinking level as spelled by the adapter's `thinkingLevelMap`
   * (minimal | low | medium | high, or null for off).
   */
  reasoning_effort?: string | null
}

/**
 * Translate the adapter's thinking-level spelling into a Doubao level id.
 *
 * pi-ai speaks OpenAI's names — including `medium` and `minimal`, which Doubao
 * has no equivalent for. Doubao only publishes 低 / 中 / 高, so the nearest
 * Doubao level wins: `minimal` and `low` both mean 低, `medium` means 中.
 * An unrecognised or absent value leaves the default in place.
 */
function toDoubaoLevel(spelling: string | null | undefined): 'low' | 'mid' | 'high' | undefined {
  switch (spelling) {
    case 'minimal':
    case 'low':    return 'low'
    case 'medium': return 'mid'
    case 'high':   return 'high'
    default:       return undefined
  }
}

/**
 * Name the model a request ASKED for, in words a user can read.
 *
 * Doubao's `model_item_key` values are opaque (`0`, `3`, `5`, `seed-lite-7b`),
 * so the wire key means nothing outside the client. Returning the name — and
 * naming the field `requested_model` rather than `model` — keeps the statement
 * inside what we actually know: this is what we sent, not what served the
 * reply. An id the catalog does not know is echoed verbatim with `unknown`, so
 * a typo cannot be mistaken for a valid model.
 */
function describeRequestedModel(key: string | undefined): {
  name: string
  item_key: string
  unknown?: boolean
} {
  if (key === undefined) {
    const fallback = findDoubaoModel(undefined)
    return { name: fallback.name, item_key: fallback.id }
  }
  const known = DOUBAO_MODELS.some((model) => model.id === key)
  return known
    ? { name: findDoubaoModel(key).name, item_key: key }
    : { name: key, item_key: key, unknown: true }
}

/**
 * Resolve the per-request upstream knobs from an inbound request.
 *
 * Without this the shim would silently discard the model the caller picked:
 * the inbound `model` is a catalog id that IS Doubao's `model_item_key`, and
 * `reasoning_effort` is the adapter's level spelling.
 */
function requestOptions(parsed: InboundChatRequest): {
  modelKey?: string
  reasoningLevel?: 'low' | 'mid' | 'high'
} {
  const level = toDoubaoLevel(parsed.reasoning_effort)
  return {
    ...parsed.model === undefined ? {} : { modelKey: parsed.model },
    ...level === undefined ? {} : { reasoningLevel: level },
  }
}

/**
 * Flatten pi-ai's content shapes (string | block array) into plain text.
 *
 * Doubao's endpoint takes one `text_block`, so multimodal blocks are not
 * forwarded: this provider advertises text-only input and the adapter never
 * offers anything else.
 */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue }
    if (block && typeof block === 'object') {
      const record = block as { type?: string; text?: unknown; content?: unknown }
      if (typeof record.text === 'string') parts.push(record.text)
      else if (typeof record.content === 'string') parts.push(record.content)
    }
  }
  return parts.join('\n')
}

/**
 * Assemble the final prompt from the inbound transcript.
 *
 * Doubao's endpoint carries one user message; a multi-turn transcript is
 * flattened newest-last with role prefixes so the model still sees the
 * history. The system prompt is folded in as context rather than dropped.
 */
function buildPrompt(messages: Array<{ role?: string; content?: unknown }> | undefined): string {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const turns: string[] = []
  for (const message of messages) {
    const text = flattenContent(message.content)
    if (!text) continue
    const role = message.role ?? 'user'
    turns.push(role === 'user' ? text : `[${role}] ${text}`)
  }
  return turns.join('\n\n')
}

export interface DoubaoShimOptions {
  /** Resolve credentials per request, so a re-login is picked up without a restart. */
  resolveCredentials?: () => DoubaoCredentials
}

export function createDoubaoShim(options: DoubaoShimOptions = {}): DoubaoShim {
  const resolveCredentials = options.resolveCredentials ?? loadDoubaoCredentials

  // Per-process shared secret. In memory only; pi-ai sends it as
  // `Authorization: Bearer`, the shim validates it, and it is never
  // forwarded upstream — Doubao authenticates on its own cookie jar.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** Constant-time bearer check; absent or mismatched bearers are rejected. */
  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const a = Buffer.from(presented)
    const b = Buffer.from(SHARED_SECRET)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  /** Read a size-capped request body. Rejects over-limit and wrong content types. */
  function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let aborted = false
      req.on('data', (chunk: Buffer) => {
        if (aborted) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          aborted = true
          resolve(undefined)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)) })
      req.on('error', () => { if (!aborted) resolve(undefined) })
    })
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  // Loopback only, ephemeral port.
  server.listen(0, '127.0.0.1')

  const baseUrl = async (): Promise<string> => {
    await ready.catch(() => {})
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('doubao shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  /** Translate one Doubao failure into the OpenAI error envelope pi-ai expects. */
  function writeFailure(res: ServerResponse, error: unknown): void {
    const kind: DoubaoErrorKind = error instanceof DoubaoUpstreamError
      ? classifyDoubaoFailure(error)
      : 'network'
    const message = (error as Error)?.message ?? 'Doubao upstream failed'
    const status = KIND_STATUS[kind]
    // The phrasing matters to the host's retry classifier: only genuinely
    // transient kinds may carry a retryable code, otherwise a slider challenge
    // would burn the whole retry budget before failing.
    const code = kind === 'network' ? 'TIMEOUT' : kind === 'quota_exhausted' ? 'RATE_LIMIT' : 'SERVER'
    writeOpenAIError(res, status, code, message)
  }

  /** Stream a completion as OpenAI SSE chunks. */
  /**
   * Stream one completion back as OpenAI-shaped SSE chunks.
   *
   * `parsed` is needed for the model and thinking level: the prompt alone says
   * nothing about which of them the caller picked.
   */
  async function streamCompletion(
    res: ServerResponse,
    prompt: string,
    parsed: InboundChatRequest,
  ): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    const send = (payload: unknown): void => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
    }

    let roleSent = false
    try {
      const result = await chat(prompt, {
        ...requestOptions(parsed),
        callbacks: {
          onText: (delta) => {
            if (!roleSent) {
              send({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
              roleSent = true
            }
            send({ choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })
          },
        },
      })
      if (!roleSent) send({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n')
        res.end()
      }
      void result
    } catch (error) {
      // The response has already begun, so the failure can only be reported
      // inside the stream. An error chunk is what pi-ai surfaces to the user.
      send({ error: { message: (error as Error)?.message ?? 'Doubao upstream failed', type: 'SERVER' } })
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }

      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }

      // Read-only quota view for the plugin UI. Never returns credentials.
      if (req.method === 'GET' && url.startsWith('/quota')) {
        const quota = await fetchQuota()
        const fiveHour = findWindow(quota, 'five_hour')
        const weekly = findWindow(quota, 'weekly')
        writeJson(res, 200, {
          ok: true,
          plan: quota.plan ?? null,
          exhausted: quota.exhausted,
          windows: {
            fiveHour: fiveHour
              ? {
                  usedPercent: fiveHour.usedPercent,
                  remainingPercent: fiveHour.remainingPercent,
                  resetsAt: fiveHour.resetsAt,
                  resetsInMs: millisUntilReset(fiveHour),
                }
              : null,
            weekly: weekly
              ? {
                  usedPercent: weekly.usedPercent,
                  remainingPercent: weekly.remainingPercent,
                  resetsAt: weekly.resetsAt,
                  resetsInMs: millisUntilReset(weekly),
                }
              : null,
          },
          error: quota.error ?? null,
        })
        return
      }

      const isChat = url.startsWith('/v1/chat/completions') || url === '/v1/chat/completions'
      if (!isChat || req.method !== 'POST') {
        writeOpenAIError(res, 404, 'not_found', 'unsupported route')
        return
      }
      if (!isJsonContentType(req)) {
        writeOpenAIError(res, 415, 'unsupported_media_type', 'chat requests must be application/json')
        return
      }

      const credentials = resolveCredentials()
      if (!credentials.ok) {
        writeOpenAIError(res, 401, 'session_dead', credentials.reason ?? 'Doubao is not signed in')
        return
      }

      const raw = await readBody(req)
      if (raw === undefined) {
        writeOpenAIError(res, 413, 'payload_too_large', 'request body exceeds the size limit')
        return
      }

      let parsed: InboundChatRequest
      try {
        parsed = JSON.parse(raw.toString('utf8')) as InboundChatRequest
      } catch {
        writeOpenAIError(res, 400, 'invalid_request', 'request body is not valid JSON')
        return
      }

      // Refuse before spending quota when the account has no headroom.
      const quota = await fetchQuota()
      if (quota.exhausted) {
        writeOpenAIError(res, 429, 'quota_exhausted',
          '豆包额度已用尽。请等待额度窗口重置，或在豆包客户端中查看额度状态。')
        return
      }

      const prompt = buildPrompt(parsed.messages)
      if (!prompt) {
        writeOpenAIError(res, 400, 'invalid_request', 'no usable message content')
        return
      }

      if (parsed.stream === false) {
        const result = await chat(prompt, requestOptions(parsed))
        // What we actually sent upstream: the inbound id run through the
        // catalog, so an unknown id degrades to the default instead of being
        // echoed back as if it had been honoured.
        const sent = findDoubaoModel(parsed.model)
        writeJson(res, 200, {
          id: `doubao-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          // Doubao's reply carries no model identifier we can read back, so
          // this field is a REQUEST-side record and nothing more. The name is
          // repeated in `requested_model` because a bare key like "0" or
          // "seed-lite-7b" means nothing to a reader.
          model: sent.id,
          requested_model: describeRequestedModel(parsed.model),
          choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
        })
        return
      }

      await streamCompletion(res, prompt, parsed)
    } catch (error) {
      writeFailure(res, error)
    }
  }

  /** Synchronous view of the origin; undefined until the socket is bound. */
  const baseUrlSync = (): string | undefined => {
    const address = server.address()
    if (address === null || typeof address === 'string') return undefined
    return `http://127.0.0.1:${address.port}`
  }

  return {
    baseUrl,
    baseUrlSync,
    token: () => SHARED_SECRET,
    async close() {
      await ready.catch(() => {})
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}