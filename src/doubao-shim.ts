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
import {
  ConversationStore,
  continuationDelta,
  isContinuation,
  sessionKeyOf,
} from './doubao-session.ts'
import {
  clearCredentialCache,
  invalidateCredentialCache,
  loadDoubaoCredentials,
  type DoubaoCredentials,
} from './doubao-auth.ts'
import { chat, DoubaoUpstreamError, classifyDoubaoFailure, isRetryableFailure, type ChatRequestOptions, type DoubaoErrorKind, type DoubaoImage } from './doubao-upstream.ts'
import { fetchQuota, findWindow, millisUntilReset } from './doubao-quota.ts'
import {
  DOUBAO_IMAGE_MODEL_ID,
  DOUBAO_MODELS,
  findDoubaoModel,
  SKILL_CARRIER_MODEL_ID,
  type DoubaoSkillName,
} from './doubao-catalog.ts'
import {
  buildToolContract,
  parseToolCalls,
  toolResultAsText,
  type EmulatedToolCall,
  type InboundTool,
} from './doubao-tools.ts'

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
  messages?: Array<{
    role?: string
    content?: unknown
    /** Present on `role: "tool"` messages. */
    tool_call_id?: string
    name?: string
  }>
  stream?: boolean
  /**
   * Thinking level as spelled by the adapter's `thinkingLevelMap`
   * (minimal | low | medium | high, or null for off).
   */
  reasoning_effort?: string | null
  /**
   * Declared tools. Doubao ignores these on the wire; they are only used when
   * tool emulation is switched on, where they become the prompt contract.
   */
  tools?: InboundTool[]
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
  skill?: DoubaoSkillName
} {
  const level = toDoubaoLevel(parsed.reasoning_effort)
  // 「豆包 生图」 is a DSH-side alias, not a Doubao model_item_key: Doubao has no
  // model by that name. Selecting it runs an ordinary chat turn under the
  // imageGen skill, which is what makes the reply carry a creation block. The
  // carrier model is the app's own default.
  if (parsed.model === DOUBAO_IMAGE_MODEL_ID) {
    return {
      modelKey: SKILL_CARRIER_MODEL_ID,
      skill: 'imageGen',
      ...level === undefined ? {} : { reasoningLevel: level },
    }
  }
  return {
    ...parsed.model === undefined ? {} : { modelKey: parsed.model },
    ...level === undefined ? {} : { reasoningLevel: level },
  }
}

/**
 * Render generated images as Markdown so they survive a text-only transport.
 *
 * The OpenAI surface pi-ai speaks has no image part on the assistant side, so
 * the URL in text is what reaches the user — and it is also what makes the
 * Harness able to download the file afterwards.
 */
export function imageMarkdown(images: readonly DoubaoImage[]): string {
  if (images.length === 0) return ''
  return images
    .map((image, i) => `![豆包生图 ${i + 1}](${image.url})`)
    .join('\n\n')
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
 *
 * A `role: "tool"` message becomes a `[tool result] …` line, which is the exact
 * shape the tool contract promises — the model is asked to recognise that prefix,
 * so the two sides must not drift apart.
 */
function buildPrompt(messages: Array<{ role?: string; content?: unknown; name?: string }> | undefined): string {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const turns: string[] = []
  for (const message of messages) {
    const text = flattenContent(message.content)
    if (!text) continue
    const role = message.role ?? 'user'
    if (role === 'tool') {
      turns.push(toolResultAsText(message.name, text))
      continue
    }
    turns.push(role === 'user' ? text : `[${role}] ${text}`)
  }
  return turns.join('\n\n')
}

export interface DoubaoShimOptions {
  /** Resolve credentials per request, so a re-login is picked up without a restart. */
  resolveCredentials?: () => DoubaoCredentials
  /**
   * Whether to simulate tool calling in the prompt.
   *
   * Read per request (not once at construction) because the user can flip the
   * setting without restarting the host.
   */
  toolEmulation?: () => boolean
}

/**
 * The `error.type` / `error.code` string for one class of failure.
 *
 * pi-ai's retry policy reads these names, so they are a contract, not cosmetics:
 * a non-retryable failure that says TIMEOUT invites a retry storm that cannot
 * succeed.
 */
function errorCodeFor(kind: DoubaoErrorKind, retryable: boolean): string {
  if (kind === 'rate_limited' || kind === 'quota_exhausted') return 'RATE_LIMIT'
  if (kind === 'network') return retryable ? 'TIMEOUT' : 'SERVER'
  return 'SERVER'
}

/**
 * Forget a session the server has rejected.
 *
 * Both the in-memory copy and the sealed one on disk: a rejected session kept
 * on disk would be handed back on the next cold start and keep failing for up
 * to twelve hours, with a message that says "network" or nothing at all. The
 * user's fix — signing in again in the Doubao app — only takes effect once the
 * stale copy stops winning.
 */
function revokeSession(): void {
  invalidateCredentialCache()
  clearCredentialCache()
}

/**
 * Per-request cancellation and liveness.
 *
 * Two failures share one root cause: nothing ever told the upstream turn to
 * stop. A client that hung up (Stop button, window closed, Harness shutting
 * down) left Doubao generating for minutes — spending quota on an answer nobody
 * would read — and a stream that went silent held the request open with no way
 * out. Both end in `signal` being aborted, which reaches the socket through
 * `fetch`, not just our side of it.
 *
 * `release` is wired to the response's own terminal events so every exit path
 * (finished, failed, client gone) tears the watchdog down without each branch
 * having to remember.
 */
export function createRequestLifecycle(
  res: ServerResponse,
  options: { idleMs?: number } = {},
): { signal: AbortSignal; onActivity: () => void; clientGone: () => boolean; release: () => void } {
  const idleMs = options.idleMs ?? DOUBAO_STREAM_IDLE_TIMEOUT_MS
  const abort = new AbortController()
  let gone = false
  const onClose = (): void => {
    // `close` also fires after a normal end; only a close before the response
    // finished means the caller left.
    if (res.writableEnded) return
    gone = true
    abort.abort()
  }
  res.on('close', onClose)
  let timer: ReturnType<typeof setTimeout> | undefined
  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  /** Reset the watchdog: an upstream delta is proof of life. */
  const onActivity = (): void => {
    disarm()
    timer = setTimeout(() => {
      abort.abort(new Error(
        `豆包 ${Math.round(idleMs / 1000)} 秒内没有返回任何数据，已中止本次请求。`,
      ))
    }, idleMs)
    timer.unref?.()
  }
  const release = (): void => {
    disarm()
    res.off('close', onClose)
  }
  res.once('finish', release)
  res.once('close', release)
  onActivity()
  return { signal: abort.signal, onActivity, clientGone: () => gone, release }
}

export function createDoubaoShim(options: DoubaoShimOptions = {}): DoubaoShim {
  const resolveCredentials = options.resolveCredentials ?? loadDoubaoCredentials

  /**
   * Doubao conversation ids by transcript opening.
   *
   * The Harness resends the whole transcript every turn, so continuity has to be
   * inferred; see `doubao-session.ts` for the rule and why it is conservative.
   * Kept per shim (i.e. per host process) — a restart simply starts new threads.
   */
  const sessions = new ConversationStore()

  /** Opt-in prompt-level tool calling; off unless the setting says otherwise. */
  const emulationOn = options.toolEmulation ?? (() => false)

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
    // A socket that already went away must not be written to: the client asked
    // for nothing and the write only produces EPIPE noise.
    if (res.writableEnded || res.destroyed) return
    const kind: DoubaoErrorKind = error instanceof DoubaoUpstreamError
      ? classifyDoubaoFailure(error)
      : 'network'
    const message = (error as Error)?.message ?? 'Doubao upstream failed'
    const status = KIND_STATUS[kind]
    // The retry flag is decided by the failure, not by its class: a transport
    // error before any byte is worth retrying, while an HTTP 400 or a truncated
    // stream is not. Only genuinely transient failures may carry a retryable
    // code, otherwise a slider challenge would burn the whole retry budget
    // before failing, and an internal bug would look like a timeout.
    const retryable = isRetryableFailure(error)
    if (!res.headersSent) res.setHeader('x-should-retry', retryable ? 'true' : 'false')
    writeOpenAIError(res, status, errorCodeFor(kind, retryable), message)
  }

  /** Stream a completion as OpenAI SSE chunks. */
  /**
   * Stream one completion back as OpenAI-shaped SSE chunks.
   *
   * `parsed` is needed for the model and thinking level: the prompt alone says
   * nothing about which of them the caller picked.
   *
   * `emulate` switches the reply handling: instead of forwarding text deltas as
   * they arrive, the whole turn is collected and the tool fence is parsed out.
   * Streaming a fence cannot work — the call is only knowable once its JSON is
   * complete — and an emulated turn is slow enough (~11.5s measured) that
   * losing incrementality costs nothing a user would notice.
   */
  async function streamCompletion(
    res: ServerResponse,
    prompt: string,
    parsed: InboundChatRequest,
    upstreamOptions: ChatRequestOptions,
    remember: (conversationId: string | undefined) => void,
    forget: () => void,
    emulate: boolean,
    lifecycle: {
      /** Aborted when the client went away or the stream went silent. */
      signal: AbortSignal
      /** Called on every upstream delta, to reset the idle watchdog. */
      onActivity: () => void
      /** True when the request's client disconnected before we finished. */
      clientGone: () => boolean
    },
  ): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    const send = (payload: unknown): void => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
    }

    let roleSent = false
    try {
      const result = await chat(prompt, {
        ...upstreamOptions,
        signal: lifecycle.signal,
        callbacks: {
          // Private reasoning is forwarded as `reasoning_content`, the field
          // OpenAI-compatible clients read for it. It is NOT mixed into
          // `content`: a client that does not understand it simply ignores it,
          // which is the right degradation.
          onThinking: (delta) => {
            lifecycle.onActivity()
            if (!roleSent) {
              send({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
              roleSent = true
            }
            send({ choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }] })
          },
          onText: (delta) => {
            lifecycle.onActivity()
            // In emulated mode the fence is still forming, so nothing can be
            // forwarded live; the whole turn is parsed after it completes.
            if (emulate) return
            if (!roleSent) {
              send({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
              roleSent = true
            }
            send({ choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })
          },
        },
      })
      // Only a completed turn teaches us the thread id; a failed one leaves the
      // previous mapping alone so the next attempt can still continue it.
      remember(result.conversationId)
      if (!roleSent) send({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })

      let finishReason = 'stop'
      if (emulate) {
        const { calls, text } = parseToolCalls(result.text)
        const visible = text.trim() === '' ? ' ' : text
        send({ choices: [{ index: 0, delta: { content: visible }, finish_reason: null }] })
        calls.forEach((call: EmulatedToolCall, index: number) => {
          send({
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                }],
              },
              finish_reason: null,
            }],
          })
        })
        if (calls.length > 0) finishReason = 'tool_calls'
      }
      // Generated images have no place on the OpenAI assistant side, so they are
      // appended to the text as Markdown — which is both what the user sees and
      // what lets the Harness fetch the file afterwards.
      const markdown = imageMarkdown(result.images)
      if (markdown !== '') {
        send({ choices: [{ index: 0, delta: { content: `\n\n${markdown}` }, finish_reason: null }] })
      }
      send({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n')
        res.end()
      }
      void result
    } catch (error) {
      const kind: DoubaoErrorKind = error instanceof DoubaoUpstreamError
        ? classifyDoubaoFailure(error)
        : 'network'
      // A thread the server no longer knows must not be retried forever: drop it
      // so the NEXT turn opens a fresh conversation instead of failing the same
      // way for the next 30 minutes.
      if (kind === 'session_dead') {
        forget()
        revokeSession()
      }
      // The client hung up (Stop button, window closed, Harness shutting down).
      // Nothing to report and nobody listening — writing here only produces
      // EPIPE noise, and the upstream call has already been aborted.
      if (lifecycle.clientGone()) return
      // The response has already begun, so the failure can only be reported
      // inside the stream. An error chunk is what pi-ai surfaces to the user.
      send({
        error: {
          message: (error as Error)?.message ?? 'Doubao upstream failed',
          type: errorCodeFor(kind, isRetryableFailure(error)),
        },
      })
      if (!res.writableEnded && !res.destroyed) {
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

      // ---- conversation continuity ------------------------------------
      //
      // The Harness sends the WHOLE transcript each turn, so the delta is what
      // this turn adds. A continuation sends only that delta plus the id the
      // server issued last time; anything uncertain starts a new conversation,
      // which is the previous behaviour and never worse.
      const sessionKey = sessionKeyOf(parsed.messages)
      const known = sessions.get(sessionKey)
      const continuing = isContinuation(parsed.messages, known)
      /**
       * What to send.
       *
       * `+1` accounts for the ASSISTANT reply this turn will add to the thread:
       * the server stores both sides, while the inbound transcript we remember
       * ends at the user message. Without it the next turn would resend last
       * turn's answer as if it were new input.
       */
      const delta = continuing ? continuationDelta(parsed.messages ?? [], known) : []
      // A transcript that grew by only an assistant message leaves nothing to
      // send; fall back to the full prompt rather than 400-ing the request.
      const useDelta = delta.length > 0
      const isContinuationTurn = continuing && useDelta
      const outgoing = useDelta ? delta : (parsed.messages ?? [])
      const promptBody = buildPrompt(outgoing)
      if (!promptBody) {
        writeOpenAIError(res, 400, 'invalid_request', 'no usable message content')
        return
      }
      /**
       * Tool emulation: the declared tools become part of the PROMPT, because
       * Doubao ignores the real `tools` field outright (measured — it answered
       * with its own server-side search skill instead).
       */
      const emulate = emulationOn() && (parsed.tools?.length ?? 0) > 0
      const prompt = emulate
        ? `${promptBody}${buildToolContract(parsed.tools ?? [])}`
        : promptBody
      // Diagnosis for "why did it answer something unrelated": the prompt is the
      // only thing we control, so being able to see exactly what went upstream is
      // the difference between debugging and guessing.
      if (process.env.DSH_DOUBAO_DEBUG_PROMPT === '1') {
        process.stderr.write(
          `[prompt] chars=${prompt.length} tools=${parsed.tools?.length ?? 0} emulate=${emulate}\n` +
          `${prompt.slice(0, 1200)}\n---\n`,
        )
      }
      // ---- cancellation & liveness -------------------------------------
      //
      // Both chat paths share this: an abort reaches the upstream socket, and
      // a stream that stops sending is given up on instead of held forever.
      const { signal, onActivity, clientGone } = createRequestLifecycle(res)

      const upstreamOptions = {
        ...requestOptions(parsed),
        // Cancellation has to reach the socket, not just our side: without it
        // the upstream turn keeps running to completion after everyone left.
        signal,
        ...isContinuationTurn ? { conversationId: known.conversationId, continueConversation: true } : {},
      }
      /** Record the thread id the server handed back, for the next turn. */
      const remember = (conversationId: string | undefined): void => {
        if (conversationId !== undefined) {
          sessions.remember(sessionKey, conversationId, (parsed.messages?.length ?? 0) + 1)
        }
      }
      // Diagnosis without a debugger: which path this turn took, how much text
      // went upstream, and whether a thread id was reused. Never logs content.
      if (process.env.DSH_DOUBAO_DEBUG_PLAN === '1') {
        process.stderr.write(
          `[plan] continuation=${isContinuationTurn} ` +
          `messages=${parsed.messages?.length ?? 0} ` +
          `sending=${outgoing.length} chars=${prompt.length} ` +
          `conversation=${isContinuationTurn ? known.conversationId : '(new)'}\n`,
        )
      }

      if (parsed.stream === false) {
        const result = await chat(prompt, upstreamOptions)
        remember(result.conversationId)
        // Same contract as the streaming path: the fence is parsed out of the
        // visible text and becomes tool_calls, never prose the user must read.
        const emulated = emulate ? parseToolCalls(result.text) : { calls: [], text: result.text }
        const content = [
          emulated.text,
          result.images.length > 0 ? imageMarkdown(result.images) : '',
        ].filter((part) => part !== '').join('\n\n')
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
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: content === '' ? ' ' : content,
              ...(emulated.calls.length > 0
                ? {
                    tool_calls: emulated.calls.map((call) => ({
                      id: call.id,
                      type: 'function',
                      function: { name: call.name, arguments: call.arguments },
                    })),
                  }
                : {}),
            },
            finish_reason: emulated.calls.length > 0 ? 'tool_calls' : 'stop',
          }],
        })
        return
      }

      await streamCompletion(
        res, prompt, parsed, upstreamOptions, remember,
        () => sessions.forget(sessionKey),
        emulate,
        { signal, onActivity, clientGone },
      )
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
      // `server.close()` only stops accepting; it waits for every live
      // connection to end. An in-flight stream (or a keep-alive client between
      // requests) therefore kept `dispose` pending for minutes, so the sockets
      // are dropped explicitly.
      server.closeAllConnections?.()
      // `close()` still resolves only once the last connection is really gone,
      // and a wedged socket must not hold plugin disposal hostage.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000)
        timer.unref?.()
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}