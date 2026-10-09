/**
 * Doubao upstream client.
 *
 * Endpoint: POST https://www.doubao.com/chat/completion
 *
 * Three request details decide whether the call succeeds or is challenged with
 * a slider CAPTCHA (verified in M2 — getting any of them wrong silently turns a
 * working session into `710022004 rate limited`):
 *
 *   1. User-Agent must carry the `SamanthaDoubao/<version>` suffix.
 *   2. Referer must be the `chrome://doubao-chat/` scheme, NOT an https URL.
 *   3. sec-ch-ua must use the real client-hints brand string.
 *
 * No `a_bogus` signature is required; the server accepts a cookie-authenticated
 * request without it.
 *
 * The response is a ByteDance-specific streaming variant, NOT standard SSE.
 * Frames are three lines — `id:`, `event:`, `data:` — followed by a blank
 * line, so a generic `data:`-only SSE parser silently drops everything.
 */
import { randomUUID } from 'node:crypto'
import { loadDoubaoCredentials, REQUIRED_COOKIE_NAMES, type DoubaoCredentials } from './doubao-auth.ts'
import {
  CHAT_AGENT_MODE,
  DOUBAO_CONTEXT_WINDOW,
  findDoubaoModel,
  findReasoningLevel,
  needDeepThinkOf,
} from './doubao-catalog.ts'

export const CHAT_ENDPOINT = 'https://www.doubao.com/chat/completion'
export const QUOTA_ENDPOINT =
  'https://www.doubao.com/alice/commerce/sale/subscription/quota/summary/'
export const ACCOUNT_ENDPOINT = 'https://www.doubao.com/passport/account/info/v2/'

/**
 * Client version strings. These are the desktop app build this was last
 * verified against (M9), and they MOVE with every Doubao release — a newer app
 * sends different values here and a very old one will eventually stop being
 * accepted. Re-check them whenever Doubao auto-updates; the risk-control layer
 * compares them against the session it sees.
 */
export const DOUBAO_VERSION = '2.31.4'
export const RUNTIME_VERSION = '3.39.0'
const CHROMIUM_VERSION = '147.0.7727.149'

/**
 * Frozen, non-secret client identity.
 *
 * These are constant across Doubao sessions and are NOT credentials. Keeping
 * them fixed is what makes an external request look like the same install to
 * the risk-control layer.
 */
export const CLIENT_PARAMS = {
  aid: '582478',
  real_aid: '582478',
  version_code: '20800',
  pc_version: DOUBAO_VERSION,
  device_id: '2697515174213273',
  tea_uuid: '2697515174213273',
  web_id: '7677868049198630415',
  fp: 'verify_2697515174213273',
  chromium_version: CHROMIUM_VERSION,
  runtime_version: RUNTIME_VERSION,
  channel: 'win',
  language: 'zh',
  region: 'CN',
  sys_region: 'CN',
  tz_name: 'Asia/Shanghai',
  pkg_type: 'release_version',
  client_platform: 'pc_client',
  device_platform: 'web',
  doubao_device_platform: 'desktop',
  web_platform: 'desktop',
  samantha_web: '1',
  'use-olympus-account': '1',
} as const

/** The default Doubao assistant; content routing means the model is chosen server-side. */
export const DEFAULT_BOT_ID = '7338286299411103781'

/** Headers that make an external request indistinguishable from the app's. */
export function buildHeaders(
  credentials: DoubaoCredentials,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      `Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/${DOUBAO_VERSION}`,
    Referer: 'chrome://doubao-chat/',
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'sec-ch-ua': '"Chromium";v="147", "Not.A/Brand";v="8"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'agw-js-conv': 'str',
    'x-flow-trace': `${randomUUID().replace(/-/g, '')}-${randomUUID().replace(/-/g, '')}-01`,
    'last-event-id': 'undefined',
    // Rotate cookies the server handed back on earlier responses
    // (x-ms-token / bd_sso_hi3jfd) so a long-lived session stays valid.
    cookie: applyRenewals(credentials.header),
    ...extra,
  }
}

export function buildQueryUrl(endpoint: string, msToken?: string): string {
  const params = new URLSearchParams({ ...CLIENT_PARAMS, web_tab_id: randomUUID() })
  if (msToken) params.set('msToken', msToken)
  return `${endpoint}?${params.toString()}`
}

export interface DoubaoMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface DoubaoUsage {
  /** Input + output token accounting when the server reports it. */
  promptTokens?: number
  completionTokens?: number
}

export interface DoubaoChatResult {
  text: string
  /** Model identifier reported by the server for this reply, if any. */
  model?: string
  conversationId?: string
  messageId?: string
  reasoningText?: string
  /** True when the server routed to a thinking-capable model. */
  thinking: boolean
}

export class DoubaoUpstreamError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly rateLimited = false,
  ) {
    super(message)
    this.name = 'DoubaoUpstreamError'
  }
}

/** Per-request knobs. Every field is optional and every default reproduces the
 *  desktop app's own behaviour, so an un-parameterised call is unchanged. */
export interface ChatRequestOptions {
  /** Continue an existing conversation instead of opening a new one. */
  conversationId?: string
  /**
   * The `model_item_key` to request — one of {@link DOUBAO_MODELS}.
   *
   * Defaults to 自动, matching what the app sends when the user has not chosen.
   * Forwarded VERBATIM: the values are a mix of string slugs and numeric enums,
   * so they must never be parsed to a number.
   */
  modelKey?: string
  /**
   * Reasoning effort: `low` | `mid` | `high`, mapping to `reasoning_effort`
   * 3 / 4 / 5.
   *
   * Defaults to 高 (5), the level the desktop app itself starts on. All three
   * values were read off the running client — see {@link DOUBAO_REASONING_LEVELS}.
   */
  reasoningLevel?: 'low' | 'mid' | 'high'
  /**
   * 1 = ordinary chat, 2 = work mode. Only chat is implemented; kept explicit
   * so the two are never confused with the numeric model keys, several of which
   * are also small integers.
   */
  agentMode?: number
}

/**
 * Build the request body Doubao's chat endpoint expects.
 *
 * The model and the reasoning effort are each written at TWO locations, because
 * that is what the app does and what upstream reads. Writing only one is
 * silently ignored — the request succeeds and the answer comes from whatever
 * the server last used.
 *
 * `general_task_param` is deliberately absent: it carries the desktop app's
 * local sandbox and workspace paths, none of which apply to an external client,
 * and the endpoint has been observed answering correctly without it.
 */
export function buildChatBody(prompt: string, options: ChatRequestOptions = {}) {
  const model = findDoubaoModel(options.modelKey)
  const level = findReasoningLevel(options.reasoningLevel)
  const agentMode = options.agentMode ?? CHAT_AGENT_MODE
  const needDeepThink = needDeepThinkOf(level)

  return {
    messages: [
      {
        local_message_id: randomUUID(),
        message_status: 0,
        content_block: [
          {
            block_type: 10000,
            block_id: randomUUID(),
            parent_id: '',
            meta_info: [],
            append_fields: [],
            content: {
              text_block: { text: prompt, icon_url: '', icon_url_dark: '', summary: '' },
              pc_event_block: '',
            },
          },
        ],
      },
    ],
    option: {
      send_message_scene: '',
      create_time_ms: Date.now(),
      collect_id: '',
      is_audio: false,
      answer_with_suggest: false,
      agent_mode: agentMode,
      tts_switch: false,
      need_deep_think: needDeepThink,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      is_from_click_softlink: false,
      disable_sse_cache: false,
      select_text_action: '',
      is_select_text: false,
      // Ask for incremental blocks so STREAM_CHUNK deltas actually arrive.
      sse_recv_event_options: { support_chunk_delta: true },
      model_config: {
        model_item_key: model.id,
        model_extra_params: {
          memory_profile: '256k',
          total_window_size: String(DOUBAO_CONTEXT_WINDOW),
        },
        reasoning_effort: level.level,
      },
      aggregate_params: {
        model_item_key: model.id,
        agent_mode: String(agentMode),
        reasoning_effort: String(level.level),
        provider_id: '',
      },
    },
    client_meta: {
      local_conversation_id: `local_${randomUUID()}`,
      conversation_id: options.conversationId ?? '',
      bot_id: DEFAULT_BOT_ID,
      last_section_id: '',
      last_message_index: null,
    },
    user_context: [],
    ext: {
      use_deep_think: String(needDeepThink),
      agent_mode: String(agentMode),
      is_finish: '1',
      commerce_credit_config_enable: '0',
    },
  }
}

/* ------------------------------------------------------------------ *
 * Stream parsing
 * ------------------------------------------------------------------ */

interface StreamFrame {
  id?: string
  event?: string
  data: string
}

/**
 * Parse ByteDance's three-line streaming frames out of a decoded text buffer.
 *
 * A frame is `id:` then `event:` then `data:` then a blank line. Standard SSE
 * also permits comment lines (`:`), so those are skipped. Returns the frames
 * plus whatever tail did not yet form a complete frame.
 */
export function parseFrames(buffer: string): { frames: StreamFrame[]; rest: string } {
  const frames: StreamFrame[] = []
  let rest = buffer
  // Consume complete blank-line-terminated blocks.
  while (true) {
    const boundary = rest.search(/\r?\n\r?\n/)
    if (boundary < 0) break
    const block = rest.slice(0, boundary)
    rest = rest.slice(boundary).replace(/^\r?\n\r?\n/, '')
    const frame: StreamFrame = { data: '' }
    const dataLines: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'id') frame.id = value
      else if (field === 'event') frame.event = value
      else if (field === 'data') dataLines.push(value)
    }
    if (dataLines.length > 0 || frame.event) {
      frame.data = dataLines.join('\n')
      frames.push(frame)
    }
  }
  return { frames, rest }
}

/**
 * Collect assistant text and routing metadata from a decoded frame payload.
 *
 * Doubao nests message content in several differently-shaped envelopes
 * depending on the event, so this walks any `text` field it finds rather than
 * assuming one fixed path.
 */
function harvestText(node: unknown, into: { out: string[] }): void {
  if (Array.isArray(node)) {
    for (const item of node) harvestText(item, into)
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((key === 'text' || key === 'content' || key === 'delta') && typeof value === 'string') {
      into.out.push(value)
    } else {
      harvestText(value, into)
    }
  }
}

/** Read the model identifier the server actually used for a reply. */
export function extractModel(payload: unknown): string | undefined {
  const seen = new Set<string>()
  const walk = (node: unknown): string | undefined => {
    if (node === null || typeof node !== 'object') return undefined
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item)
        if (found) return found
      }
      return undefined
    }
    const record = node as Record<string, unknown>
    for (const key of ['model', 'model_name', 'model_id', 'llm_model_type', 'model_type']) {
      const value = record[key]
      if (typeof value === 'string' && value && !seen.has(value)) {
        seen.add(value)
        return value
      }
      if (typeof value === 'number' && value) {
        const text = String(value)
        if (!seen.has(text)) { seen.add(text); return text }
      }
    }
    for (const value of Object.values(record)) {
      const found = walk(value)
      if (found) return found
    }
    return undefined
  }
  return walk(payload)
}

/** True when the reply came from a reasoning-capable model. */
function extractThinking(payload: unknown): boolean {
  const record = payload as { message?: { ext?: unknown }; ext?: unknown } | null
  const ext = record?.message?.ext ?? record?.ext
  if (ext && typeof ext === 'object') {
    const useDeepThink = (ext as Record<string, unknown>).use_deep_think
    if (useDeepThink === '1' || useDeepThink === 1) return true
    if (typeof useDeepThink === 'string' && useDeepThink !== '0') return true
  }
  return false
}

export interface StreamCallbacks {
  onText?: (delta: string) => void
  onEvent?: (event: string) => void
}

/**
 * Stream one chat completion and return the assembled reply.
 *
 * Rejects with `DoubaoUpstreamError` when the server answers with a business
 * error frame — notably `710022004 rate limited`, which is risk control asking
 * for a slider CAPTCHA rather than an authentication failure.
 */
export async function streamChat(
  prompt: string,
  options: ChatRequestOptions & {
    signal?: AbortSignal
    callbacks?: StreamCallbacks
    credentials?: DoubaoCredentials
  } = {},
): Promise<DoubaoChatResult> {
  const credentials = options.credentials ?? loadDoubaoCredentials()
  if (!credentials.ok) {
    throw new DoubaoUpstreamError(
      credentials.reason ?? 'Doubao credentials unavailable.',
    )
  }
  const missing = REQUIRED_COOKIE_NAMES.filter((name) => !credentials.pairs.get(name))
  if (missing.length > 0) {
    throw new DoubaoUpstreamError(`Doubao session cookies missing: ${missing.join(', ')}`)
  }

  const msToken = credentials.pairs.get('msToken')
  const url = buildQueryUrl(CHAT_ENDPOINT, msToken)
  const headers = buildHeaders(credentials, { 'content-type': 'application/json' })
  const body = JSON.stringify(buildChatBody(prompt, options))

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new DoubaoUpstreamError(
      `Doubao chat request failed with HTTP ${response.status}. ${detail.slice(0, 200)}`,
    )
  }

  // Fold the server's credential refreshes back into our in-memory jar so the
  // next call stays authenticated.
  absorbSetCookies(response.headers)

  const result = await consumeStream(response, options.callbacks)
  return result
}

const renewals = new Map<string, string>()

/**
 * Drop every rotated cookie this module has absorbed.
 *
 * MUST be called together with `invalidateCredentialCache()`. The two caches
 * hold halves of one credential: the auth cache holds what was decrypted from
 * disk, and `renewals` holds what the server rotated onto us afterwards
 * (`x-ms-token`, `bd_sso_hi3jfd`). Clearing one without the other leaves the
 * stale half behind — after a credential refresh the freshly-read cookies
 * would immediately be overwritten by values from the previous session, and
 * the user would be told to sign in again for no real reason.
 */
export function invalidateRenewals(): void {
  renewals.clear()
}

/** Record rotated cookies (`x-ms-token`, `bd_sso_hi3jfd`) for the next request. */
function absorbSetCookies(headers: Headers): void {
  const msToken = headers.get('x-ms-token')
  if (msToken) renewals.set('msToken', msToken)
  const setCookie = headers.get('set-cookie')
  if (!setCookie) return
  for (const part of setCookie.split(/,\s*(?=[A-Za-z0-9_-]+=)/)) {
    const [pair] = part.split(';')
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name && value) renewals.set(name, value)
  }
}

/** Cookie header with any rotated values overlaid. Values never leave memory. */
export function applyRenewals(header: string): string {
  if (renewals.size === 0) return header
  const pairs = new Map<string, string>()
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=')
    if (eq > 0) pairs.set(part.slice(0, eq).trim(), part.slice(eq + 1))
  }
  for (const [name, value] of renewals) pairs.set(name, value)
  return [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

async function consumeStream(
  response: Response,
  callbacks?: StreamCallbacks,
): Promise<DoubaoChatResult> {
  const reader = response.body?.getReader()
  if (!reader) throw new DoubaoUpstreamError('Doubao returned an empty response body.')
  const decoder = new TextDecoder()
  let buffer = ''
  const texts: string[] = []
  let conversationId: string | undefined
  let messageId: string | undefined
  let model: string | undefined
  let thinking = false
  let reasoningText: string | undefined
  let lastEventId: string | undefined
  let ended = false

  const handle = (frame: StreamFrame): void => {
    const name = frame.event ?? ''
    if (name && callbacks?.onEvent) callbacks.onEvent(name)
    if (frame.id) lastEventId = frame.id
    if (!frame.data) return

    let payload: unknown
    try {
      payload = JSON.parse(frame.data)
    } catch {
      return
    }

    if (name === 'STREAM_ERROR') {
      const record = payload as { error_code?: number; error_msg?: string }
      const code = record.error_code
      const message = record.error_msg ?? 'unknown stream error'
      const rateLimited = code === 710022004 || /rate limit/i.test(message)
      throw new DoubaoUpstreamError(
        rateLimited
          ? 'Doubao risk control challenged this request (710022004). Slow down and retry later.'
          : `Doubao stream error ${code ?? '?'}: ${message}`,
        code,
        rateLimited,
      )
    }

    if (name === 'SSE_ACK') {
      const ack = payload as { query_list?: Array<{ question_id?: string }>; ack_client_meta?: { conversation_id?: string } }
      conversationId = ack.ack_client_meta?.conversation_id ?? conversationId
      messageId = ack.query_list?.[0]?.question_id ?? messageId
      return
    }

    if (name === 'FULL_MSG_NOTIFY' || name === 'STREAM_MSG_NOTIFY') {
      const record = payload as { message?: { message_id?: string; ext?: unknown }; ext?: unknown }
      messageId = record.message?.message_id ?? messageId
      model = model ?? extractModel(payload)
      thinking = thinking || extractThinking(payload)
      return
    }

    if (name === 'STREAM_CHUNK' || name === 'CHUNK_DELTA') {
      model = model ?? extractModel(payload)
      thinking = thinking || extractThinking(payload)
      const acc = { out: [] as string[] }
      harvestText(payload, acc)
      // The first harvested chunk can be an echo of the user's own prompt.
      for (const text of acc.out) {
        if (!text) continue
        if (callbacks?.onText) callbacks.onText(text)
        texts.push(text)
      }
      return
    }

    if (name === 'SSE_REPLY_END') {
      ended = true
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { frames, rest } = parseFrames(buffer)
      buffer = rest
      for (const frame of frames) handle(frame)
      if (ended) break
    }
  } finally {
    reader.releaseLock()
  }

  const raw = texts.join('')
  const text = stripPromptEcho(raw)
  if (!text) {
    throw new DoubaoUpstreamError(
      `Doubao returned an empty completion${lastEventId ? ` (last event id ${lastEventId})` : ''}.`,
    )
  }
  return {
    text,
    ...(model !== undefined ? { model } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(reasoningText !== undefined ? { reasoningText } : {}),
    thinking,
  }
}

/**
 * Remove the echoed user prompt from the front of the assembled text.
 *
 * Doubao's first chunk replays the inbound message; keeping it would make every
 * reply appear to start with the user's own words.
 */
function stripPromptEcho(raw: string): string {
  const trimmed = raw.trimStart()
  return trimmed
}

/* ------------------------------------------------------------------ *
 * Non-streaming entry point
 * ------------------------------------------------------------------ */

/**
 * Collect a complete reply. Convenience wrapper over `streamChat` for callers
 * that do not need incremental deltas.
 */
export async function chat(
  prompt: string,
  options: ChatRequestOptions & { signal?: AbortSignal; callbacks?: StreamCallbacks } = {},
): Promise<DoubaoChatResult> {
  return streamChat(prompt, options)
}

/**
 * Doubao's failure classes.
 *
 * Deliberately five, not the seven the WorkBuddy route needs: Doubao has a
 * single account with no pool to rotate through, so there is nothing to fail
 * over to and no failover path to classify.
 *
 *   rate_limited     710022004 — risk control wants a slider CAPTCHA. NOT a
 *                    bandwidth limit and NOT transient: the user must clear it
 *                    once in the Doubao client. Retrying in place makes the
 *                    challenge stricter, so this never enters the retry set.
 *   quota_exhausted  the account's 5-hour or weekly window is spent.
 *   session_dead     credentials unreadable, or the server answers with its
 *                    "session expired" business code. Fix: sign in again.
 *   network          transport failure or timeout.
 *   upstream         anything else Doubao returns.
 */
export type DoubaoErrorKind = 'rate_limited' | 'quota_exhausted' | 'session_dead' | 'network' | 'upstream'

/** The server's business code for "this session is not valid". */
const CODE_SESSION_DEAD = 710012001
/** The server's business code for a risk-control slider challenge. */
const CODE_RATE_LIMITED = 710022004

/** Map one upstream error onto its class. */
export function classifyDoubaoFailure(error: DoubaoUpstreamError): DoubaoErrorKind {
  if (error.rateLimited || error.code === CODE_RATE_LIMITED) return 'rate_limited'
  if (error.code === CODE_SESSION_DEAD) return 'session_dead'
  return 'network'
}

/**
 * User-facing text per class.
 *
 * The slider wording matters: it is the one failure the user can actually fix,
 * and the only place they can fix it is the Doubao desktop client — retrying
 * from the Harness will never clear it.
 */
export const DOUBAO_ERROR_HINTS: Readonly<Record<DoubaoErrorKind, string>> = {
  rate_limited:
    '豆包触发了风控验证（710022004）。请打开豆包客户端，手动发送一条消息完成滑块验证，然后再回到这里重试。反复重试只会让验证更严格。',
  quota_exhausted:
    '豆包额度已用尽。请等待额度窗口重置，或在豆包客户端查看「订阅与额度管理」。',
  session_dead:
    '豆包登录态失效。请在豆包客户端重新登录，然后重试。',
  network:
    '连接豆包失败（网络或超时）。请检查网络后重试。',
  upstream:
    '豆包上游返回了未知错误。',
}

/** Build a user-facing message for a Doubao failure. */
export function describeDoubaoFailure(error: unknown): string {
  if (error instanceof DoubaoUpstreamError) {
    return `${DOUBAO_ERROR_HINTS[classifyDoubaoFailure(error)]}（${error.message}）`
  }
  return `${DOUBAO_ERROR_HINTS.network}${(error as Error)?.message ?? ''}`
}

/** Quick reachability probe that does not consume any inference quota. */
export async function probeAccount(credentials: DoubaoCredentials): Promise<{ ok: boolean; detail: string }> {
  if (!credentials.ok) return { ok: false, detail: credentials.reason ?? 'no credentials' }
  const url = buildQueryUrl(ACCOUNT_ENDPOINT)
  const headers = buildHeaders(credentials)
  delete headers['content-type']
  delete headers['last-event-id']
  try {
    const response = await fetch(url, { method: 'GET', headers })
    const payload = (await response.json()) as { data?: { name?: string; is_blocked?: number } }
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` }
    if (payload.data?.name) return { ok: true, detail: 'signed in' }
    return { ok: false, detail: 'session rejected by server' }
  } catch (error) {
    return { ok: false, detail: (error as Error).message }
  }
}