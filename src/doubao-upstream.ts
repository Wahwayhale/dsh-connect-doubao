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
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { hostname, homedir, tmpdir } from 'node:os'
import { browserRelayChat, browserRelayEnabled } from './doubao-browser-relay.ts'
import { dirname, isAbsolute, join, relative as relativeTo } from 'node:path'
import {
  findDoubaoUserDataDir,
  loadDoubaoCredentials,
  CORE_AUTH_COOKIE_NAMES,
  REQUIRED_COOKIE_NAMES,
  type DoubaoCredentials,
} from './doubao-auth.ts'
import {
  CHAT_AGENT_MODE,
  TASK_AGENT_MODE,
  CREATION_BLOCK_TYPE,
  DOUBAO_CONTEXT_WINDOW,
  DOUBAO_IMAGE_MODEL_ID,
  type DoubaoSkillName,
  findDoubaoModel,
  findReasoningLevel,
  inputSkillOf,
  isTaskModel,
  levelIdOf,
  needDeepThinkValue,
  TASK_RUNTIME_LOCAL_PC,
  TASK_SANDBOX_AUTH_ALLOW_ALL,
} from './doubao-catalog.ts'

import { taskWorkspaceOperationsToDshCalls } from './doubao-tools.ts'
import type { EmulatedToolCall, InboundTool } from './doubao-tools.ts'

export const CHAT_ENDPOINT = 'https://www.doubao.com/chat/completion'
export const QUOTA_ENDPOINT =
  'https://www.doubao.com/alice/commerce/sale/subscription/quota/summary/'
export const ACCOUNT_ENDPOINT = 'https://www.doubao.com/passport/account/info/v2/'
export const TOOL_LOCAL_ACK_ENDPOINT = 'https://www.doubao.com/alice/office/tool_local/msg/ack'
export const TOOL_LOCAL_UPLOAD_ENDPOINT =
  'https://www.doubao.com/alice/office/tool_local/upload_command_result'
export const TOOL_LOCAL_COMPLETE_ENDPOINT =
  'https://www.doubao.com/alice/office/tool_local/msg/complete'
export const ACTION_BAR_BRIEF_LIST_ENDPOINT =
  'https://www.doubao.com/alice/slot/action_bar_v3/brief_list'

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

/**
 * Optional fingerprint captured from the SAME browser profile that produced the
 * QR-login cookies. This is local configuration, never credentials.
 *
 * Browser login and request identity are separate: a web cookie presented with
 * desktop-only ids, UA and Referer is exactly the mismatch that can trigger
 * 710022004. The file lets this machine use its own web ids without hard-coding
 * them into the plugin or changing the login flow.
 */
export interface DoubaoBrowserFingerprint {
  userAgent?: string
  referer?: string
  secChUa?: string
  query?: Record<string, string>
}

let cachedBrowserFingerprint: DoubaoBrowserFingerprint | null | undefined
/** Warn at most once per process about a missing web identity. */
let warnedMissingFingerprint = false

function browserFingerprint(): DoubaoBrowserFingerprint | null {
  if (cachedBrowserFingerprint !== undefined) return cachedBrowserFingerprint
  try {
    const path = join(homedir(), '.dsh', 'doubao-browser-fingerprint.json')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as DoubaoBrowserFingerprint
    cachedBrowserFingerprint = parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    cachedBrowserFingerprint = null
  }
  return cachedBrowserFingerprint
}

function clientParam(name: keyof typeof CLIENT_PARAMS): string {
  return browserFingerprint()?.query?.[name] ?? CLIENT_PARAMS[name]
}

/** The default Doubao assistant; content routing means the model is chosen server-side. */
export const DEFAULT_BOT_ID = '7338286299411103781'

/** Headers that make an external request indistinguishable from the app's. */
export function buildHeaders(
  credentials: DoubaoCredentials,
  extra: Record<string, string> = {},
  fingerprint: DoubaoBrowserFingerprint | null = browserFingerprint(),
): Record<string, string> {
  return {
    'User-Agent': fingerprint?.userAgent ?? (
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      `Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/${DOUBAO_VERSION}`
    ),
    Referer: fingerprint?.referer ?? 'chrome://doubao-chat/',
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'sec-ch-ua': fingerprint?.secChUa ?? '"Chromium";v="147", "Not.A/Brand";v="8"',
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

export function buildQueryUrl(
  endpoint: string,
  msToken?: string,
  fingerprint: DoubaoBrowserFingerprint | null = browserFingerprint(),
): string {
  // A browser profile supplies the complete non-secret query shape. Do not merge
  // desktop-only fields into it: aid/web_id/fp/platform must stay one identity.
  const base = fingerprint?.query ?? CLIENT_PARAMS
  const params = new URLSearchParams({ ...base, web_tab_id: randomUUID() })
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

/** Server-reported context window breakdown from Doubao's `context_window_usage`. */
export interface DoubaoContextWindowUsage {
  systemPrompt: number
  messages: number
  skills: number
  tools: number
  totalWindowSize: number
  /** Sum of systemPrompt + messages + skills + tools reported by upstream. */
  totalUsed: number
}

/** Optional timing and window telemetry emitted on upstream SSE frames. */
export interface DoubaoUpstreamTelemetry {
  contextWindowUsage?: DoubaoContextWindowUsage
  ackCostMs?: number
  firstPacketCostMs?: number
  finishTimeMs?: number
  finishReasonChat?: string
}

/** One generated image from a creation block (`block_type: 2074`). */
export interface DoubaoImage {
  /** Server task id for this creation. */
  taskId?: string
  /** Stable asset key, e.g. `tos-cn-i-…/rc_gen_image/<uuid>.jpeg`. */
  key?: string
  /** Best available URL: original > preview > thumb. */
  url: string
  width?: number
  height?: number
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
  /** Tool calls delegated to this request's declared DSH functions. */
  toolCalls?: EmulatedToolCall[]
  /**
   * Images produced by a skill turn (`input_skill: imageGen`).
   *
   * Empty unless the request asked for a creation. The URLs are signed but
   * long-lived (`x-expires` in 2037 on the captured ones), so they can be
   * handed straight to the user or downloaded.
   */
  images: DoubaoImage[]
  /**
   * The agent the server says served this turn (`intention_agent_name`).
   *
   * Not a model identifier — it names the server-side AGENT, which is how a
   * 「工作任务」 turn becomes visible at all: chat turns and task turns use the
   * same endpoint and the same stream, and this field is the only read-back
   * evidence of which one was actually used.
   */
  intentionAgent?: string
  /** Server-side telemetry parsed from `ext.context_window_usage` and timing tags. */
  telemetry?: DoubaoUpstreamTelemetry
}

/**
 * Extra evidence about a failure, carried on the error itself.
 *
 * Classification needs more than the business code: an HTTP status, whether
 * the transport (fetch/reader) failed, and whether the answer was cut off all
 * map to different kinds and different retry decisions. Keeping that evidence
 * on the error means the classifier never has to re-derive it from a message
 * string, and a throw site can declare its own class when the shape is
 * unusual (`kind`).
 */
export interface DoubaoUpstreamErrorMeta {
  /** HTTP status of the failing response, when there was one. */
  httpStatus?: number
  /** The socket/fetch itself failed — the server never answered. */
  transport?: boolean
  /** The stream ended before the reply did: the answer is partial. */
  truncated?: boolean
  /** Classify as this kind regardless of code/status. */
  kind?: DoubaoErrorKind
  /**
   * The plugin refused the turn locally, before any byte reached the network.
   *
   * Needed because a local cooldown reuses the upstream risk-control code and
   * message shape: without this flag a blocked retry looks identical to a fresh
   * challenge, and recovery logic would try to "rescue" a turn that never ran.
   */
  local?: boolean
}

export class DoubaoUpstreamError extends Error {
  readonly httpStatus: number | undefined
  readonly transport: boolean
  readonly truncated: boolean
  readonly kindHint: DoubaoErrorKind | undefined
  readonly local: boolean

  constructor(
    message: string,
    readonly code?: number,
    readonly rateLimited = false,
    meta: DoubaoUpstreamErrorMeta = {},
  ) {
    super(message)
    this.name = 'DoubaoUpstreamError'
    this.httpStatus = meta.httpStatus
    this.transport = meta.transport === true
    this.truncated = meta.truncated === true
    this.kindHint = meta.kind
    this.local = meta.local === true
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
   * Doubao SKILL to run the turn under — the capability axis.
   *
   * Orthogonal to `modelKey`: `imageGen` (3) makes Doubao answer with a
   * creation block (real generated images) while still riding the chat
   * endpoint. Verified live 2026-11-02: `input_skill: {skill_id:"3",
   * skill_type:3}` returns `rc_gen_image/*.jpeg` from Seedream 5.0.
   */
  skill?: DoubaoSkillName
  /**
   * Reasoning effort: `low` | `mid` | `high`, mapping to `reasoning_effort`
   * 3 / 4 / 5.
   *
   * Defaults to 高 (5), the level the desktop app itself starts on. All three
   * values were read off the running client — see {@link DOUBAO_REASONING_LEVELS}.
   */
  reasoningLevel?: 'low' | 'mid' | 'high' | 'xhigh' | 'max'
  /**
   * `option.agent_mode` / `ext.agent_mode`.
   *
   * VERIFIED: the desktop app sends 1 for BOTH ordinary chat and a 「工作任务」
   * (a real 2026-09-15 task request carries 1). Kept explicit so these small
   * integers are never confused with the numeric model keys, which are also
   * small integers.
   */
  agentMode?: number
  /**
   * Send the request as a 「工作任务 · 本地电脑」 instead of a plain chat.
   *
   * DEFAULTS TO TRUE. The whole point of this route is that the executing
   * machine is this one, which is where the Harness already runs its tools; the
   * cloud VM runtime (`runtime_type: 1`) puts execution somewhere we cannot
   * reach.
   *
   * What travels: `ext.general_task_param` as a JSON *string* — the client's own
   * shape, transcribed from a captured request. Its presence is what makes the
   * server treat the turn as a task (the client's `is_general_task` check is
   * `!!ext.general_task_param`); `agent_mode` stays 1.
   *
   * Set `DSH_DOUBAO_TASK=0` in the host environment to fall back to plain chat
   * without a rebuild — the escape hatch for a server-side rejection.
   */
  taskMode?: boolean
  /**
   * Ask for the 深度思考 pass (probe knob; see `buildChatBody`).
   */
  deepThink?: boolean
  /**
   * Continue the conversation named by {@link ChatRequestOptions.conversationId}
   * instead of opening a new one.
   *
   * The client sends `need_create_conversation: false` plus the id it got back;
   * omitting both starts a fresh thread. Set by the shim from its own
   * conversation store (see `doubao-session.ts`).
   */
  continueConversation?: boolean
  /**
   * Directory the task declares as its workspace.
   *
   * The cloud plans against these paths, so they must be real on THIS machine.
   * Defaults to `DSH_DOUBAO_WORKSPACE`, then `process.cwd()`.
   */
  workspace?: string
  /** DSH functions declared on this request; never expanded to undeclared tools. */
  declaredTools?: readonly InboundTool[]
  /** Uploaded ImageX attachments prepended before the text block. */
  attachments?: readonly DoubaoImageAttachment[]
}

/* ------------------------------------------------------------------ *
 * 「工作任务 · 本地电脑」
 * ------------------------------------------------------------------ */

/**
 * Stable-per-process id that rides along as `client_env_id`.
 *
 * The client generates one per app environment; ours is per host process so a
 * restart looks like a new environment, which is exactly what it is.
 */
const CLIENT_ENV_ID = randomUUID()

/** Whether a request asks for local-PC task mode. Default: OFF — see below. */
export function taskModeEnabled(options: ChatRequestOptions): boolean {
  if (options.taskMode !== undefined) return options.taskMode
  // Selecting a 「工作任务」 model (2.1 Lite = seed-lite-7b, 2.1 Pro = 5, 自动 = 9)
  // automatically switches the turn into task mode (mode_id: "3", agent_mode: 1).
  if (isTaskModel(options.modelKey)) return true
  const flag = process.env.DSH_DOUBAO_TASK
  return flag === undefined ? false : /^(1|true|on|yes)$/i.test(flag.trim())
}

/** The directory this machine declares to the task runtime. */
export function taskWorkspaceOf(options: ChatRequestOptions): string {
  return options.workspace ?? process.env.DSH_DOUBAO_WORKSPACE ?? process.cwd()
}

/**
 * Build `ext.general_task_param` — the field that makes a turn a 工作任务.
 *
 * Transcribed field-for-field from a real 「工作任务 · 本地电脑」 request the
 * desktop client sent on 2026-09-15 (recovered from the app's own IndexedDB
 * message store), then reduced to what is portable:
 *
 *   thread_local_message_id  the local message id being submitted
 *   client_option            the workspace and the sandbox/authorisation policy
 *   runtime_type             2 — Local_PC; the cloud VM would be 1
 *   agent_task_param         the same facts again, device-side
 *   agent_task_param_change  all false: nothing is being switched mid-thread
 *
 * Paths are computed from THIS machine rather than copied, because the cloud
 * plans against them: a workspace that does not exist here would make the task
 * fail inside the runtime instead of at submit time. `local_device_id` and
 * `local_app_id` reuse the frozen client identity already in {@link CLIENT_PARAMS}
 * — the captured request carries the same two values, so they are the same
 * install identity and not per-request state.
 */
export function buildGeneralTaskParam(
  localMessageId: string,
  workspace: string,
  prompt?: string,
): Record<string, unknown> {
  const userData = findDoubaoUserDataDir()
  const agentWorkspace = userData === undefined
    ? join(tmpdir(), 'dsh-doubao-agent-workspace')
    : join(userData, 'Default', '.doubao', 'agent_mode', 'workspace')
  return {
    thread_local_message_id: [localMessageId],
    client_option: {
      shared_folder_path: [workspace, agentWorkspace],
      enable_sandbox: true,
      os: process.platform === 'win32' ? 'Windows' : process.platform,
      client_env_id: CLIENT_ENV_ID,
      sandbox_id: `route-${randomUUID()}`,
      workspace,
      agent_workspace: {
        agent_workspace: agentWorkspace,
        local_skill_paths: [join(homedir(), 'Doubao', 'skills'), join(homedir(), '.agents', 'skills')],
      },
      sandbox_auth_type: TASK_SANDBOX_AUTH_ALLOW_ALL,
    },
    runtime_type: TASK_RUNTIME_LOCAL_PC,
    need_modify_conversation: false,
    agent_task_param: {
      runtime_type: TASK_RUNTIME_LOCAL_PC,
      device_name: hostname(),
      workspace,
      local_device_id: clientParam('device_id'),
      local_app_id: clientParam('aid'),
      sandbox_auth_type: TASK_SANDBOX_AUTH_ALLOW_ALL,
    },
    agent_task_param_change: {
      runtime_changed: false,
      device_changed: false,
      sandbox_auth_type_changed: false,
    },
    ...(prompt !== undefined
      ? { task_input_json: JSON.stringify({ text: prompt, files: [], skills: [] }) }
      : {}),
  }
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
/**
 * Add the 「生成图片：」 prefix that Doubao's image skill requires.
 *
 * The desktop app gets this for free: its `chat_ability.ability_param` carries
 * `reply_message_format: "生成图片：%s"`, which rewrites the outgoing text before
 * the request leaves. An external client has no such hook, so the same rewrite
 * happens here. Without it the server treats the turn as ordinary chat and
 * answers with prose instead of drawing.
 *
 * Deliberately ONLY the prefix: appending extra instructions makes Doubao read
 * them as part of the subject and drop the picture entirely (measured).
 */
export function withImagePrefix(prompt: string, options: ChatRequestOptions = {}): string {
  const isImageTurn = options.skill === 'imageGen' || options.modelKey === DOUBAO_IMAGE_MODEL_ID
  if (!isImageTurn) return prompt
  if (/^\s*(生成图片|生成一张|画一张|画个|绘制)/.test(prompt)) return prompt
  return `生成图片：${prompt}`
}

export const ATTACHMENT_BLOCK_TYPE = 10052
export const DOUBAO_IMAGE_LIMIT_BYTES = 10 * 1024 * 1024
const DOUBAO_IMAGE_CACHE_MAX = 64

export interface DecodedDoubaoImage {
  mime: string
  bytes: Buffer
  ext: string
}

export interface UploadedDoubaoImage {
  uri: string
  identifier: string
  name: string
  mime: string
}

export interface DoubaoImageAttachment {
  type: 1
  identifier: string
  image: {
    name: string
    uri: string
    image_ori: {
      url: string
      width: number
      height: number
      format: string
      url_formats: Record<string, never>
    }
  }
  parse_state: 1
  review_state: 1
  upload_status: 1
  progress: 100
  src: string
}

export interface DoubaoAttachmentBlock {
  block_type: typeof ATTACHMENT_BLOCK_TYPE
  block_id: string
  parent_id: string
  meta_info: unknown[]
  extra_info: Record<string, unknown>
  append_fields: unknown[]
  content: {
    attachment_block: { attachments: readonly DoubaoImageAttachment[] }
    pc_event_block: string
  }
}

interface ImagexUploadCredentials {
  access_key: string
  secret_key: string
  session_token: string
}

const doubaoImageUploadCache = new Map<string, UploadedDoubaoImage>()

/** Clear the in-memory ImageX upload deduplication cache (used in tests). */
export function clearDoubaoImageUploadCache(): void {
  doubaoImageUploadCache.clear()
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Decode a `data:image/(png|jpeg|jpg|webp|gif);base64,...` URL into raw bytes. */
export function decodeImageDataUrl(source: unknown): DecodedDoubaoImage | undefined {
  if (typeof source !== 'string') return undefined
  const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.*)$/s.exec(source)
  if (match === null) return undefined
  const rawMime = match[1]!
  const mime = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime
  const bytes = Buffer.from(match[2] ?? '', 'base64')
  if (bytes.length === 0 || bytes.length > DOUBAO_IMAGE_LIMIT_BYTES) {
    throw new DoubaoUpstreamError('图片为空或超过 10 MiB 上限', CODE_INVALID_PARAM)
  }
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.slice(6)
  return { mime, bytes, ext }
}

/** Compute lowercase 8-hex-digit CRC32 required by ImageX upload endpoints. */
export function imagexCrc32(bytes: Buffer): string {
  let crc = -1
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index] ?? 0
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0')
}

function canonicalImagexQuery(params: Record<string, string>): string {
  const entries = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return new URLSearchParams(entries).toString()
}

/** Validate an ImageX API or TOS upload host returned by Doubao. */
export function validateImagexHost(host: unknown, isImagexApi: boolean): string {
  if (typeof host !== 'string' || /[/@:]/.test(host) || host === '') {
    throw new DoubaoUpstreamError('豆包返回了非法的图片上传域名', CODE_INVALID_PARAM)
  }
  const name = host.toLowerCase()
  const allowed = isImagexApi
    ? name === 'imagex.bytedanceapi.com' || name === 'imagex.volcengineapi.com'
    : ['snssdk.com', 'byteimg.com', 'volces.com'].some((suffix) => name.endsWith(`.${suffix}`))
  if (!allowed) {
    throw new DoubaoUpstreamError('豆包返回了不受支持的图片上传域名', CODE_INVALID_PARAM)
  }
  return `https://${name}`
}

/** Sign an ImageX request with AWS4-HMAC-SHA256 (`cn-north-1` / `imagex`). */
export function signImagexRequest(
  method: string,
  query: string,
  credentials: ImagexUploadCredentials,
  body: Buffer = Buffer.alloc(0),
  now: Date = new Date(),
): Record<string, string> {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const timestamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  const day = timestamp.slice(0, 8)
  const scope = `${day}/cn-north-1/imagex/aws4_request`
  const headers: Record<string, string> = {
    'x-amz-date': timestamp,
    'x-amz-security-token': credentials.session_token,
  }
  if (body.length > 0) headers['x-amz-content-sha256'] = sha256Hex(body)
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('')
  const signedHeaders = names.join(';')
  const payloadHash = sha256Hex(body)
  const canonical = [method.toUpperCase(), '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256Hex(Buffer.from(canonical, 'utf8'))].join('\n')
  let key = Buffer.from(`AWS4${credentials.secret_key}`, 'utf8')
  for (const part of [day, 'cn-north-1', 'imagex', 'aws4_request']) {
    key = createHmac('sha256', key).update(part).digest()
  }
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${credentials.access_key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return headers
}

/** Upload one decoded image via Doubao `alice/resource` + ImageX STS flow. */
export async function uploadDoubaoImage(
  credentials: DoubaoCredentials,
  image: DecodedDoubaoImage,
  filename?: string,
): Promise<UploadedDoubaoImage> {
  if (!credentials.ok || !credentials.pairs) {
    throw new DoubaoUpstreamError('豆包登录态不可用，无法上传图片', CODE_SESSION_DEAD)
  }
  const msToken = credentials.pairs.get('msToken')
  const csrf = credentials.pairs.get('passport_csrf_token') ?? credentials.pairs.get('passport_csrf_token_default')
  const extra: Record<string, string> = {
    'content-type': 'application/json',
    origin: 'https://www.doubao.com',
    referer: 'https://www.doubao.com/chat/',
    'x-requested-with': 'XMLHttpRequest',
  }
  if (csrf !== undefined) extra['x-tt-passport-csrf-token'] = csrf
  const headers = buildHeaders(credentials, extra)

  const api = async (path: string, payload: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(buildQueryUrl(`https://www.doubao.com${path}`, msToken), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
    absorbSetCookies(response.headers)
    const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
    if (!response.ok) {
      throw new DoubaoUpstreamError(
        `豆包图片接口失败（HTTP ${response.status}）`,
        undefined,
        false,
        { httpStatus: response.status },
      )
    }
    const responseMetadata = body?.ResponseMetadata as { Error?: unknown } | undefined
    if (body === null || typeof body !== 'object' || responseMetadata?.Error) {
      throw new DoubaoUpstreamError('豆包图片接口返回错误', CODE_INVALID_PARAM)
    }
    if (typeof body.code === 'number' && body.code !== 0) {
      throw new DoubaoUpstreamError(
        `豆包图片接口返回 ${body.code}`,
        body.code,
        body.code === CODE_RATE_LIMITED,
      )
    }
    return body
  }

  const preparedBody = await api('/alice/resource/prepare_upload', {
    tenant_id: '5',
    scene_id: '5',
    resource_type: 2,
  })
  const prepared = preparedBody.data as Record<string, unknown> | undefined
  if (prepared === null || typeof prepared !== 'object') {
    throw new DoubaoUpstreamError('豆包图片上传接口没有返回资源信息', CODE_INVALID_PARAM)
  }
  const imagexBase = validateImagexHost(prepared.upload_host, true)
  const rawCreds = prepared.upload_auth_token as Record<string, unknown> | undefined
  for (const field of ['access_key', 'secret_key', 'session_token']) {
    if (typeof rawCreds?.[field] !== 'string' || rawCreds[field] === '') {
      throw new DoubaoUpstreamError('豆包图片上传凭证不完整', CODE_INVALID_PARAM)
    }
  }
  const uploadCredentials: ImagexUploadCredentials = {
    access_key: rawCreds!.access_key as string,
    secret_key: rawCreds!.secret_key as string,
    session_token: rawCreds!.session_token as string,
  }
  const serviceId = typeof prepared.service_id === 'string' ? prepared.service_id : ''
  if (serviceId === '') {
    throw new DoubaoUpstreamError('豆包图片上传接口缺少 service_id', CODE_INVALID_PARAM)
  }

  const applyParams = {
    Action: 'ApplyImageUpload',
    Version: '2018-08-01',
    ServiceId: serviceId,
    FileSize: String(image.bytes.length),
    FileExtension: `.${image.ext}`,
    s: randomUUID().replace(/-/g, '').slice(0, 12),
    device_platform: 'web',
  }
  const applyQuery = canonicalImagexQuery(applyParams)
  const appliedResponse = await fetch(`${imagexBase}/?${applyQuery}`, {
    method: 'GET',
    headers: signImagexRequest('GET', applyQuery, uploadCredentials),
  })
  const applied = (await appliedResponse.json().catch(() => undefined)) as {
    ResponseMetadata?: { Error?: unknown }
    Result?: {
      UploadAddress?: {
        SessionKey?: unknown
        UploadHosts?: unknown[]
        StoreInfos?: Array<{ StoreUri?: unknown; Auth?: unknown }>
      }
    }
  } | undefined
  if (!appliedResponse.ok || !applied || applied.ResponseMetadata?.Error) {
    throw new DoubaoUpstreamError('豆包图片上传申请失败', CODE_INVALID_PARAM)
  }

  const address = applied.Result?.UploadAddress
  const storeInfo = address?.StoreInfos?.[0]
  const uploadBase = validateImagexHost(address?.UploadHosts?.[0], false)
  if (
    typeof storeInfo?.StoreUri !== 'string' ||
    typeof storeInfo?.Auth !== 'string' ||
    typeof address?.SessionKey !== 'string'
  ) {
    throw new DoubaoUpstreamError('豆包返回的图片上传地址不完整', CODE_INVALID_PARAM)
  }

  const storeUri = storeInfo.StoreUri.split('/').map((part) => encodeURIComponent(part)).join('/')
  const uploadResponse = await fetch(`${uploadBase}/upload/v1/${storeUri}`, {
    method: 'POST',
    headers: {
      Authorization: storeInfo.Auth,
      'Content-CRC32': imagexCrc32(image.bytes),
      'Content-Type': 'application/octet-stream',
    },
    body: new Uint8Array(image.bytes),
  })
  const uploaded = (await uploadResponse.json().catch(() => undefined)) as { code?: unknown } | undefined
  const uploadedCode = String(uploaded?.code ?? 2000)
  if (!uploadResponse.ok || !uploaded || (uploadedCode !== '2000' && uploadedCode !== '0')) {
    throw new DoubaoUpstreamError('豆包图片传输失败', CODE_INVALID_PARAM)
  }

  const commitQuery = canonicalImagexQuery({
    Action: 'CommitImageUpload',
    Version: '2018-08-01',
    ServiceId: serviceId,
  })
  const commitBody = Buffer.from(JSON.stringify({ SessionKey: address.SessionKey }), 'utf8')
  const commitResponse = await fetch(`${imagexBase}/?${commitQuery}`, {
    method: 'POST',
    headers: {
      ...signImagexRequest('POST', commitQuery, uploadCredentials, commitBody),
      'Content-Type': 'application/json',
    },
    body: new Uint8Array(commitBody),
  })
  const committed = (await commitResponse.json().catch(() => undefined)) as {
    ResponseMetadata?: { Error?: unknown }
    Result?: { Results?: Array<{ UriStatus?: unknown }> }
  } | undefined
  if (!commitResponse.ok || !committed || committed.ResponseMetadata?.Error) {
    throw new DoubaoUpstreamError('豆包图片提交失败', CODE_INVALID_PARAM)
  }
  const results = committed.Result?.Results
  if (!Array.isArray(results) || results.length === 0 || results.some((item) => item?.UriStatus !== 2000)) {
    throw new DoubaoUpstreamError('豆包图片提交未被接受', CODE_INVALID_PARAM)
  }

  const identifier = randomUUID().replace(/-/g, '')
  const digest = createHash('md5').update(image.bytes).digest('hex')
  const name = filename ?? `image.${image.ext}`
  const registeredBody = await api('/alice/resource/register', {
    tenant_id: '5',
    scene_id: '5',
    resource_list: [{
      uri: storeInfo.StoreUri,
      resource_type: 2,
      meta: {
        image_meta: {
          data: { md5: digest, identifier },
          parse_extra: {},
          image_info: {
            file_name: name,
            format: image.ext === 'jpg' ? 'jpeg' : image.ext,
            size: image.bytes.length,
          },
        },
      },
    }],
  })
  const dataMap = registeredBody.data as Record<string, { resource_id?: unknown } | undefined> | undefined
  const record = dataMap?.[storeInfo.StoreUri]
  if (!record?.resource_id) {
    throw new DoubaoUpstreamError('豆包图片登记失败', CODE_INVALID_PARAM)
  }
  return {
    uri: storeInfo.StoreUri,
    identifier,
    name,
    mime: image.mime,
  }
}

/** Build the Doubao `attachment_block` item for one uploaded image. */
export function toImageAttachment(uploaded: UploadedDoubaoImage): DoubaoImageAttachment {
  const subtype = uploaded.mime.split('/')[1] ?? 'png'
  return {
    type: 1,
    identifier: uploaded.identifier,
    image: {
      name: uploaded.name,
      uri: uploaded.uri,
      image_ori: {
        url: '',
        width: 0,
        height: 0,
        format: subtype === 'jpeg' ? 'jpeg' : subtype,
        url_formats: {},
      },
    },
    parse_state: 1,
    review_state: 1,
    upload_status: 1,
    progress: 100,
    src: '',
  }
}

/** Wrap uploaded image attachments into a `block_type: 10052` content block. */
export function buildAttachmentBlock(attachments: readonly DoubaoImageAttachment[]): DoubaoAttachmentBlock {
  return {
    block_type: ATTACHMENT_BLOCK_TYPE,
    block_id: randomUUID(),
    parent_id: '',
    meta_info: [],
    extra_info: {},
    append_fields: [],
    content: {
      attachment_block: { attachments },
      pc_event_block: '',
    },
  }
}

/** Decode and upload inbound `data:image/...` URLs with per-account SHA-256 caching. */
export async function uploadDoubaoImageAttachments(
  credentials: DoubaoCredentials,
  sources: readonly string[] | undefined,
): Promise<DoubaoImageAttachment[]> {
  const attachments: DoubaoImageAttachment[] = []
  const accountKey = credentials.ok ? (credentials.pairs.get('uid_tt') ?? '') : ''
  let index = 0
  for (const source of sources ?? []) {
    const image = decodeImageDataUrl(source)
    if (image === undefined) continue
    index += 1
    const key = `${accountKey}:${sha256Hex(image.bytes)}`
    let uploaded = doubaoImageUploadCache.get(key)
    if (uploaded === undefined) {
      uploaded = await uploadDoubaoImage(credentials, image, `image-${index}.${image.ext}`)
      if (doubaoImageUploadCache.size >= DOUBAO_IMAGE_CACHE_MAX) {
        const oldest = doubaoImageUploadCache.keys().next().value
        if (oldest !== undefined) doubaoImageUploadCache.delete(oldest)
      }
      doubaoImageUploadCache.set(key, uploaded)
    }
    attachments.push(toImageAttachment(uploaded))
  }
  return attachments
}

export function buildChatBody(prompt: string, options: ChatRequestOptions = {}) {
  prompt = withImagePrefix(prompt, options)
  const model = findDoubaoModel(options.modelKey)
  const level = findReasoningLevel(options.reasoningLevel)
  const task = taskModeEnabled(options)
  // A DISCOVERED 「工作任务」 model (a third-party `person-*` slug, say) is not in
  // the static catalog, so `isTaskModel` cannot recognise it; the shim resolves
  // that case from the live catalog and passes it down as `taskMode`.
  const taskModelSelected = isTaskModel(model.id) || options.taskMode === true
  /**
   * Deep-thinking toggle, for probing only.
   *
   * The captured ordinary turn sends `need_deep_think: 0`; the client's 深度思考
   * switch is what turns this on, and the value it sends there has NOT been
   * captured yet. `DSH_DOUBAO_DEEP_THINK=1` reproduces the old 10000+level shape
   * so the resulting stream can be inspected.
   *
   * In 「工作任务」 mode (`seed-lite-7b`, `5`, `9`), captured requests send `10001`.
   */
  const deepThink = options.deepThink === true ||
    (options.deepThink === undefined && process.env.DSH_DOUBAO_DEEP_THINK === '1')
  const needDeepThink = taskModelSelected && options.deepThink === undefined
    ? 10001
    : needDeepThinkValue(deepThink)
  /**
   * 2 = 普通对话, 1 = 「工作任务」.
   *
   * CDP-captured from the running client on 2026-10-22. This constant was the
   * bug: the plugin sent 1 for chat, so the server answered every turn as a work
   * task — `Agent-GeneralTask`, then `710010702` because the task runtime used
   * to be the desktop app's own CUA process. Task turns now complete through the
   * `tool_local` responder, which is why `TASK_AGENT_MODE` is safe to send.
   */
  const agentMode = options.agentMode ?? (task ? TASK_AGENT_MODE : CHAT_AGENT_MODE)
  const localMessageId = randomUUID()
  /**
   * Mode id the model picker groups by. The captured chat request carries "1" in
   * BOTH `conversation_init_ext` and `aggregate_params`, whereas 「工作任务」
   * models (`seed-lite-7b`, `5`, `9`) carry "3".
   */
  // Grouped by whether this turn is a 工作任务, not by whether the id is a catalog
  // entry: a discovered task model needs mode_id "3" exactly like 2.1 Pro does.
  const modeId = (process.env.DSH_DOUBAO_MODE_ID ?? '').trim() || (task ? '3' : '1')
  /**
   * The client's own default for `general_task_param` on an ordinary turn.
   *
   * NOTE the shape: an OBJECT inside `option` and the same thing STRINGIFIED
   * inside `ext`. That asymmetry is the client's, not a mistake here.
   */
  const plainTaskParam = { server_do_compare: true }
  const taskParam = task
    ? buildGeneralTaskParam(
        localMessageId,
        taskWorkspaceOf(options),
        taskModelSelected ? prompt : undefined,
      )
    : plainTaskParam
  const modelExtraParams: Record<string, string> = taskModelSelected
    ? {
        input_token_limit: '256k',
        ...(model.id === 'seed-lite-7b' ? { reasoning_effort: levelIdOf(level.level) } : {}),
      }
    : {}

  return {
    messages: [
      {
        local_message_id: localMessageId,
        message_status: 0,
        content_block: [
          ...(options.attachments !== undefined && options.attachments.length > 0
            ? [buildAttachmentBlock(options.attachments)]
            : []),
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
      // 0 on an ordinary turn. The level itself travels in `reasoning_effort`;
      // this is the (off) 深度思考 toggle, worth 10000+level when on.
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
      resend_for_regen: false,
      scene_type: 0,
      unique_key: randomUUID(),
      start_seq: 0,
      // A continuation reuses the server-side thread: `false` + the id it issued.
      // Anything else starts a new conversation.
      need_create_conversation: options.continueConversation !== true,
      conversation_init_option: { need_ack_conversation: true },
      ...(taskModelSelected && options.continueConversation !== true
        ? { conversation_mode: 2 }
        : {}),
      // The model and the mode are declared here as well as in `model_config`.
      // The captured request does both; the server reads this pair first.
      conversation_init_ext: {
        model_item_key: model.id,
        reasoning_effort: String(level.level),
        mode_id: modeId,
      },
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: '',
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: '',
      shared_app_id: '',
      // Ask for incremental blocks so STREAM_CHUNK deltas actually arrive.
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      is_ai_playground: false,
      is_old_user: true,
      general_task_param: taskParam,
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: Math.floor(Date.now() / 1000),
        append_sse_event_scene: 0,
      },
      message_storage_type: 0,
      related_deleted_message_ids: {},
      connector_info_list: [],
      model_config: {
        model_item_key: model.id,
        // Empty in the captured chat request; in 「工作任务」 mode, carries
        // `input_token_limit: "256k"` (and `reasoning_effort` for seed-lite-7b).
        model_extra_params: modelExtraParams,
        reasoning_effort: level.level,
      },
      aggregate_params: {
        mention_skill_list: '[]',
        mention_plugin_list: '[]',
        mention_ext: '[{}]',
        // The captured deep-think request carries "1" here while an ordinary turn
        // carries "". Without it the 10040 thinking block still appears in the
        // stream but stays empty (`deep_think_intention: "0"`), i.e. the server
        // opens the shell and skips the thinking.
        conversation_mode: taskModelSelected && options.continueConversation !== true
          ? '2'
          : deepThink
            ? '1'
            : '',
        mode_id: modeId,
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
      // The client reports the permissions it holds; the server echoes them into
      // its own telemetry. Shape copied verbatim from the capture.
      local_permissions: [
        { permission_name: 'ACCESS_COARSE_LOCATION', status: 1 },
        { permission_name: 'ACCESS_FINE_LOCATION', status: 1 },
        { permission_name: 'ACCESS_BACKGROUND_LOCATION', status: 1 },
      ],
    },
    user_context: [],
    ext: {
      agent_mode: String(agentMode),
      use_deep_think: String(needDeepThink),
      sub_conv_firstmet_type: '1',
      general_task_param: JSON.stringify(taskParam),
      collection_id: '',
      is_finish: '1',
      conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
      commerce_credit_config_enable: '0',
      // The skill axis. Absent (or "0") is ordinary chat; `imageGen` turns the
      // reply into a creation block with generated images. A JSON STRING — the
      // client stringifies it the same way, and a nested object is a shape the
      // server never sees from the app.
      ...(() => {
        const encoded = inputSkillOf(options.skill)
        return encoded === undefined ? {} : { input_skill: encoded }
      })(),
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

/**
 * Collect answer text and thinking text, separated by block ownership.
 *
 * A deep-think reply carries a `block_type: 10040` container (the visible
 * 「正在思考 / 已完成思考」 shell) and then streams the reasoning as ordinary
 * `block_type: 10000` blocks whose `parent_id` is that container's id. The shell
 * and its children both point at `Deep_Think.png`, but `parent_id` is the
 * reliable discriminator, so it is what this uses.
 *
 * Treating every `text` as answer text — what the previous revision did — mixes
 * the model's private reasoning into the reply the user sees.
 */
const PLACEHOLDER_THINKING_TITLE_RE =
  /^(?:正在思考(?:中)?|思考中|已(?:完成)?(?:深度)?思考(?:\s*[（(].*[)）])?|深度思考(?:中)?|思考完成|正在(?:生成图片|生图)|已完成(?:图片生成|生图)|thinking|thought)(?:[.。…]+)?$/i

function nonPlaceholderTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || PLACEHOLDER_THINKING_TITLE_RE.test(trimmed)) return undefined
  return trimmed
}

function trailingNewlineCount(text: string, fallback = 0): number {
  if (text === '') return fallback
  if (/(?:\r?\n){2}$/.test(text)) return 2
  if (/\r?\n$/.test(text)) return 1
  return 0
}

export interface BlockCollectState {
  thinkingIds: Set<string>
  /** Active target for id-less `CHUNK_DELTA` frames across SSE events. */
  activeTarget?: 'thinking' | 'answer'
  /** Last seen title per thinking block id. */
  lastTitles?: Map<string, string>
  /** Normalized thinking titles already emitted in this stream. */
  seenTitles?: Set<string>
  /** Last seen cumulative/snapshot `text_block.summary` per block id. */
  lastSummaries?: Map<string, string>
  /** True once full CoT `text_block.text` has appeared for a thinking block. */
  hasFullThinkingText?: boolean
  /** True when a `10040` thinking container or thinking content appeared. */
  sawThinkingBlock?: boolean
  hasEmittedThinking?: boolean
  trailingNewlines?: number
}

export function createBlockCollectState(): BlockCollectState {
  return {
    thinkingIds: new Set<string>(),
    lastTitles: new Map<string, string>(),
    seenTitles: new Set<string>(),
    lastSummaries: new Map<string, string>(),
    hasFullThinkingText: false,
    sawThinkingBlock: false,
    hasEmittedThinking: false,
    trailingNewlines: 2,
  }
}

function pushThinkingPiece(
  state: BlockCollectState,
  into: { thinking: string[] },
  piece: string,
  discrete: boolean,
): void {
  if (piece === '') return
  if (!discrete) {
    into.thinking.push(piece)
    state.hasEmittedThinking = true
    state.trailingNewlines = trailingNewlineCount(piece, state.trailingNewlines ?? 0)
    return
  }
  const nl = state.trailingNewlines ?? 0
  const prefix = !state.hasEmittedThinking ? '' : nl >= 2 ? '' : nl === 1 ? '\n' : '\n\n'
  const out = `${prefix}${piece}`
  into.thinking.push(out)
  state.hasEmittedThinking = true
  state.trailingNewlines = trailingNewlineCount(out, nl)
}

export function collectBlocks(
  node: unknown,
  into: { answer: string[]; thinking: string[]; images?: DoubaoImage[] },
  thinkingIdsOrState: Set<string> | BlockCollectState,
  depth = 0,
): void {
  const state: BlockCollectState = thinkingIdsOrState instanceof Set
    ? { thinkingIds: thinkingIdsOrState }
    : thinkingIdsOrState
  const thinkingIds = state.thinkingIds

  if (Array.isArray(node)) {
    for (const item of node) collectBlocks(item, into, state, depth)
    return
  }
  if (node === null || typeof node !== 'object') return
  const record = node as Record<string, unknown>

  const blockType = record.block_type
  if (typeof blockType === 'number') {
    const blockId = typeof record.block_id === 'string' && record.block_id !== ''
      ? record.block_id
      : undefined
    const parentId = typeof record.parent_id === 'string' ? record.parent_id : ''
    const isThinking = blockType === THINKING_BLOCK_TYPE ||
      (parentId !== '' && thinkingIds.has(parentId))

    if (blockType === THINKING_BLOCK_TYPE) {
      if (blockId !== undefined) thinkingIds.add(blockId)
    }

    // A creation block: `content.creation_block.creations[]`. Each creation
    // streams in pieces (first a placeholder with no URL, later the finished
    // one), so the same task id can arrive several times — the caller dedupes
    // by keeping the entries that actually carry a URL.
    if (blockType === CREATION_BLOCK_TYPE) {
      state.activeTarget = 'answer'
      if (into.images !== undefined) {
        const content = record.content as { creation_block?: { creations?: unknown } } | undefined
        const creations = content?.creation_block?.creations
        if (Array.isArray(creations)) {
          for (const raw of creations) {
            const image = toDoubaoImage(raw)
            if (image !== undefined) into.images.push(image)
          }
        }
      }
    }

    const content = record.content as {
      text_block?: { text?: unknown; summary?: unknown }
      thinking_block?: {
        streaming_title?: unknown
        finish_title?: unknown
        unfold_streaming_title?: unknown
        cot_ui_style?: unknown
        empty_disable_click?: unknown
      }
    } | undefined

    const thinkingBlock = content?.thinking_block
    const text = content?.text_block?.text
    const summary = content?.text_block?.summary

    if (isThinking) {
      if (
        thinkingBlock !== undefined &&
        typeof thinkingBlock === 'object' &&
        thinkingBlock !== null &&
        thinkingBlock.empty_disable_click !== true
      ) {
        const isSummaryStyle = thinkingBlock.cot_ui_style === 'summary'
        if (!state.hasFullThinkingText || isSummaryStyle) {
          const title = nonPlaceholderTitle(thinkingBlock.finish_title) ??
            nonPlaceholderTitle(thinkingBlock.unfold_streaming_title) ??
            nonPlaceholderTitle(thinkingBlock.streaming_title)
          if (title !== undefined) {
            state.sawThinkingBlock = true
            state.seenTitles ??= new Set<string>()
            state.lastTitles ??= new Map<string, string>()
            const titleKey = blockId ?? '__thinking_title__'
            if (!state.seenTitles.has(title) && state.lastTitles.get(titleKey) !== title) {
              state.seenTitles.add(title)
              state.lastTitles.set(titleKey, title)
              pushThinkingPiece(state, into, `${title}\n\n`, true)
            }
          }
        }
      }

      if (typeof text === 'string' && text !== '') {
        state.hasFullThinkingText = true
        state.sawThinkingBlock = true
        pushThinkingPiece(state, into, text, false)
      } else if (typeof summary === 'string' && summary.trim() !== '') {
        const trimmedSummary = summary.trim()
        if (!PLACEHOLDER_THINKING_TITLE_RE.test(trimmedSummary)) {
          state.sawThinkingBlock = true
          state.seenTitles ??= new Set<string>()
          state.lastSummaries ??= new Map<string, string>()
          const summaryKey = blockId ?? (parentId !== '' ? `${parentId}:summary` : '__thinking_summary__')
          const prev = state.lastSummaries.get(summaryKey) ?? ''
          if (prev === '' && state.seenTitles.has(trimmedSummary)) {
            state.lastSummaries.set(summaryKey, summary)
          } else if (summary !== prev) {
            state.lastSummaries.set(summaryKey, summary)
            if (prev !== '' && summary.startsWith(prev)) {
              const delta = summary.slice(prev.length)
              pushThinkingPiece(state, into, delta, false)
            } else {
              state.seenTitles.add(trimmedSummary)
              pushThinkingPiece(state, into, summary, true)
            }
          }
        }
      }

      if (typeof text === 'string' && text !== '' && record.is_finish !== true) {
        state.activeTarget = 'thinking'
      } else if (blockType !== THINKING_BLOCK_TYPE && record.is_finish !== true) {
        state.activeTarget = 'thinking'
      } else if (blockType === THINKING_BLOCK_TYPE && state.activeTarget === undefined && record.is_finish !== true) {
        state.activeTarget = 'thinking'
      }
    } else {
      if (typeof text === 'string' && text !== '') {
        into.answer.push(text)
      }
      if (content?.text_block !== undefined) {
        state.activeTarget = 'answer'
      }
    }
  } else if (
    typeof record.text === 'string' &&
    record.text !== '' &&
    !('content_block' in record) &&
    !('message' in record) &&
    (typeof record.id === 'string' || (depth === 0 && !('block_type' in record) && !('icon_url' in record)))
  ) {
    // `event: CHUNK_DELTA` frames carry incremental text as `{ text: "...", id: "<block_id>" }`
    // or `{ text: "..." }` without `id` (routed to the active block target).
    const isThinkingDelta = typeof record.id === 'string'
      ? thinkingIds.has(record.id)
      : state.activeTarget === 'thinking'
    if (isThinkingDelta) {
      state.sawThinkingBlock = true
      pushThinkingPiece(state, into, record.text, false)
    } else {
      into.answer.push(record.text)
    }
    return
  }

  for (const value of Object.values(record)) collectBlocks(value, into, state, depth + 1)
}

/**
 * Turn one `creations[]` entry into an image, or undefined when it carries no
 * usable URL yet (the placeholder stage).
 *
 * URL preference is original → preview → thumb: `image_ori` is the full-
 * resolution artefact, the others are watermarked/derivative variants the app
 * uses for lists and thumbnails.
 */
function toDoubaoImage(raw: unknown): DoubaoImage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const creation = raw as Record<string, unknown>
  const image = creation.image as Record<string, unknown> | undefined
  if (image === undefined) return undefined
  const pick = (key: string): { url: string; width?: unknown; height?: unknown } | undefined => {
    const value = image[key]
    if (typeof value !== 'object' || value === null) return undefined
    const url = (value as { url?: unknown }).url
    if (typeof url !== 'string' || url === '') return undefined
    return value as { url: string; width?: unknown; height?: unknown }
  }
  // IMAGEGEN_RAW_PATCH: image_ori 带 logo 水印；image_ori_raw 才是原图。
  const best = pick('image_ori_raw') ?? pick('image_ori') ?? pick('image_preview') ?? pick('image_thumb')
  if (best === undefined) return undefined
  const taskId = typeof creation.id === 'string' ? creation.id
    : typeof creation.id === 'number' ? String(creation.id) : undefined
  const out: DoubaoImage = { url: best.url }
  if (taskId !== undefined) out.taskId = taskId
  if (typeof image.key === 'string') out.key = image.key
  if (typeof best.width === 'number') out.width = best.width
  if (typeof best.height === 'number') out.height = best.height
  return out
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
    if (typeof useDeepThink === 'string' && useDeepThink !== '' && useDeepThink !== '0') return true
  }
  return false
}

export interface StreamCallbacks {
  onText?: (delta: string) => void
  /** Private reasoning deltas (deep-think turns); never part of the answer. */
  onThinking?: (delta: string) => void
  onEvent?: (event: string) => void
}

/**
 * Local workspace HTTP responder for 「工作任务」 (`Agent-GeneralTask`) turns.
 *
 * When a task-mode turn starts with `option.unique_key = <U>`, the server's
 * `Agent-GeneralTask` dispatches sequential local workspace commands with
 * deterministic IDs: `${uniqueKey}:${device_id}:${aid}:message:${seq}` for
 * `seq = 0, 1, 2, ...`.
 *
 * CRITICAL: `POST /alice/office/tool_local/msg/ack` MUST be called with a
 * SINGLE `msg_id` (`{ msg_ids: [msgId] }`). If `msg_ids` contains any `seq`
 * that has not been created on the server yet, the entire `msg/ack` batch fails
 * with `710010702`. Polling one `seq` at a time and replying to `cmd_call`
 * (`command: 6003`, e.g. `local.workspace.apply`) via `upload_command_result`
 * + `msg/complete` until `agent_finished` (`command: 6004`) satisfies the server
 * runtime without requiring the Doubao desktop CUA process.
 */
export function unsupportedLocalTaskResult(inputObj: Record<string, unknown>, reason?: string): Record<string, unknown> {
  const error = reason ?? '本插件不会执行豆包任务通道发来的本地命令；请通过 DSH 声明的工作区工具执行。'
  const operations = Array.isArray(inputObj.operations) ? inputObj.operations : []
  return {
    request_id: typeof inputObj.request_id === 'string' ? inputObj.request_id : '',
    status: 'error',
    error_code: 'LOCAL_EXECUTION_UNAVAILABLE',
    error_msg: error,
    results: operations.map((entry: unknown) => {
      const op = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? entry as Record<string, unknown>
        : {}
      return {
        ...(typeof op.sequence === 'number' || typeof op.sequence === 'string' ? { sequence: op.sequence } : {}),
        ...(typeof op.id === 'string' ? { id: op.id } : {}),
        ...(typeof op.type === 'string' ? { type: op.type } : {}),
        ...(typeof op.path === 'string' ? { path: op.path } : {}),
        status: 'error',
        error_msg: error,
      }
    }),
  }
}

/**
 * Perform a task runtime's own workspace bookkeeping (session dirs, board,
 * trajectory log) inside the workspace this turn declared.
 *
 * Only `ensure_dir`, `ensure_file` and appends to files under the session
 * prefix are honoured; every path is resolved under the root and rejected if it
 * escapes it, so a crafted `..` cannot write outside the workspace. Anything
 * unrecognised fails rather than being silently reported as done.
 */
/**
 * Whether a `cmd_call` is the task runtime's own workspace bookkeeping.
 *
 * Judged by what the command touches, not by an exhaustive name list: the
 * runtime names these per target (init_agent_workspace,
 * append_workspace_trajectory_memory, write_workspace_board,
 * write_workspace_assignment_main, …) and a list silently misses the next one —
 * which is what turned a finished turn into a redispatch loop. A command is
 * bookkeeping when every path it writes stays inside the runtime's own
 * `.sessions/` prefix; anything reaching a real workspace path is real work and
 * must go through the DSH tool bridge instead.
 */
export function isTaskBookkeeping(commandName: string, input: Record<string, unknown>): boolean {
  const operations = Array.isArray(input.operations) ? input.operations : []
  if (operations.length === 0) return false
  const insideSessions = operations.every((operation) => {
    if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) return false
    const path = (operation as Record<string, unknown>).path
    if (typeof path !== 'string') return false
    const normalized = path.split(String.fromCharCode(92)).join('/')
    return normalized === '.sessions' || normalized.startsWith('.sessions/')
  })
  if (!insideSessions) return false
  return commandName.startsWith('init_agent_workspace')
    || commandName.startsWith('append_workspace_trajectory_memory')
    || commandName.startsWith('write_workspace_')
    || commandName.includes('_workspace_')
}

export async function applyTaskBookkeeping(
  input: Record<string, unknown>,
  workspaceRoot?: string,
): Promise<{ ok: boolean; message: string }> {
  const root = workspaceRoot ?? process.env.DSH_DOUBAO_WORKSPACE ?? process.cwd()
  const operations = Array.isArray(input.operations) ? input.operations : []
  if (operations.length === 0) return { ok: true, message: 'no operations' }
  const resolveInside = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value === '' || value.includes(String.fromCharCode(0))) return undefined
    const normalized = value.split(String.fromCharCode(92)).join('/')
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return undefined
    if (normalized.split('/').some((part) => part === '..')) return undefined
    const absolute = join(root, normalized)
    const relative = relativeTo(root, absolute)
    if (relative.startsWith('..') || isAbsolute(relative)) return undefined
    return absolute
  }
  try {
    for (const entry of operations) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return { ok: false, message: 'invalid operation entry' }
      }
      const operation = entry as Record<string, unknown>
      const target = resolveInside(operation.path)
      if (target === undefined) return { ok: false, message: 'path outside workspace' }
      const type = operation.type
      if (type === 'ensure_dir') await mkdir(target, { recursive: true })
      else if (type === 'ensure_file') {
        await mkdir(dirname(target), { recursive: true })
        await appendFile(target, '')
      } else if (type === 'write_file' || type === 'append_file') {
        if (typeof operation.content !== 'string') return { ok: false, message: 'missing content' }
        await mkdir(dirname(target), { recursive: true })
        if (type === 'append_file' || operation.mode === 'append') await appendFile(target, operation.content, 'utf8')
        else await writeFile(target, operation.content, 'utf8')
      } else {
        return { ok: false, message: 'unsupported bookkeeping operation' }
      }
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'bookkeeping failed' }
  }
  return { ok: true, message: 'ok' }
}

async function runToolLocalResponder(
  uniqueKey: string,
  credentials: DoubaoCredentials,
  isStreamDone: () => boolean,
  signal: AbortSignal | undefined,
  declaredTools: readonly InboundTool[],
  onToolCalls: (calls: EmulatedToolCall[]) => void,
): Promise<boolean> {
  let localOperationRejected = false
  const msToken = credentials.pairs.get('msToken')
  // Same identity as the task turn that produced these calls: the session is a
  // web session, and a second identity here would be the same mismatch again.
  const postToolJson = async (endpoint: string, payload: unknown): Promise<Record<string, any> | undefined> => {
    const url = buildQueryUrl(endpoint, msToken)
    const headers = buildHeaders(credentials, {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
    })
    delete headers['last-event-id']
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    })
    absorbSetCookies(res.headers)
    const text = await res.text()
    if (!res.ok) throw new Error(`Doubao task endpoint failed with HTTP ${res.status}`)
    return JSON.parse(text) as Record<string, any>
  }

  let seq = 0
  let postStreamPolls = 0
  while (!signal?.aborted) {
    if (isStreamDone()) {
      if (seq === 0 || postStreamPolls >= 8) break
      postStreamPolls += 1
    }
    const msgId = `${uniqueKey}:${clientParam('device_id')}:${clientParam('aid')}:message:${seq}`
    let ack: Record<string, any> | undefined
    try {
      ack = await postToolJson(TOOL_LOCAL_ACK_ENDPOINT, { msg_ids: [msgId] })
    } catch {
      // If fetch fails or returns non-JSON (e.g. a stubbed unit-test fetch),
      // exit quietly so the caller's stream handling is unaffected.
      return localOperationRejected
    }
    const msg = ack?.code === 0 ? ack?.data?.msgs?.[0] : undefined
    if (msg !== undefined) {
      const cmdCall = msg?.body?.cmd_call
      const agentFinished = msg?.body?.agent_finished
      if (cmdCall !== undefined) {
        let inputObj: Record<string, any> = {}
        try {
          inputObj = JSON.parse(cmdCall.input ?? '{}') as Record<string, any>
        } catch {
          inputObj = {}
        }
        /**
         * Two kinds of command arrive here, and they must be treated differently.
         *
         * `init_agent_workspace` / `append_workspace_trajectory_memory` are the
         * task runtime's OWN bookkeeping: it creates its session directory, its
         * board and its trajectory log, then expects them to exist. These are not
         * DSH work, and handing them to DSH made the runtime answer "workspace not
         * ready" and dispatch the same command again — an endless loop that never
         * reached the user's actual request. The plugin performs them itself
         * against the workspace it declared, then answers success.
         */
        const commandName = String(cmdCall.id ?? '')
        /**
         * Recognise bookkeeping by what it DOES, not by an exhaustive list of
         * names. The runtime names these per target — init_agent_workspace,
         * append_workspace_trajectory_memory, write_workspace_board,
         * write_workspace_assignment_main, and more appear as the app evolves —
         * and a name list silently misses the next one, which is what turned a
         * finished turn into a redispatch loop. Anything that only touches the
         * runtime's own `.sessions/` prefix is bookkeeping; anything reaching a
         * real workspace path still goes through the DSH tool bridge below.
         */
        const bookkeeping = isTaskBookkeeping(commandName, inputObj)
        if (bookkeeping) {
          const outcome = await applyTaskBookkeeping(inputObj)
          try {
            const uploaded = await postToolJson(TOOL_LOCAL_UPLOAD_ENDPOINT, {
              device_id: clientParam('device_id'),
              command_result: { id: cmdCall.id, code: outcome.ok ? 0 : 1, message: outcome.message },
              workspace_apply_response: {
                request_id: inputObj.request_id,
                status: outcome.ok ? 'success' : 'failed',
                ...(outcome.ok ? {} : { error_code: 'WORKSPACE_BOOKKEEPING_FAILED', error_message: outcome.message }),
                operation_results: (Array.isArray(inputObj.operations) ? inputObj.operations : []).map((operation: Record<string, unknown>, operation_index: number) => ({
                  operation_index,
                  ...(typeof operation.path === 'string' ? { path: operation.path } : {}),
                  status: outcome.ok ? 'success' : 'failed',
                  ...(outcome.ok ? {} : { error_code: 'WORKSPACE_BOOKKEEPING_FAILED', error_message: outcome.message }),
                })),
                workspace_ready: outcome.ok,
              },
            })
            if (uploaded?.code !== 0) return localOperationRejected
            const completed = await postToolJson(TOOL_LOCAL_COMPLETE_ENDPOINT, { msg_id: msgId })
            if (completed?.code !== 0) return localOperationRejected
          } catch {
            return localOperationRejected
          }
          seq += 1
          continue
        }
        // This endpoint is not connected to DSH's workspace tools. Never tell the
        // remote task agent that a local operation succeeded when nothing ran.
        localOperationRejected = true
        const mapped = taskWorkspaceOperationsToDshCalls(inputObj, declaredTools)
        const handoffReason = mapped.reason ?? '操作已作为 DSH 工具调用转交；等待宿主执行结果。'
        if (mapped.calls.length === 0) {
          // Why a task turn ended in LOCAL_EXECUTION_UNAVAILABLE is otherwise
          // unanswerable: the payload is the server's, and the mapper's refusal
          // reason names only the category. Log both, plus what was declared.
          // Only on failure, so a healthy turn writes nothing.
          const line = '[task] command=' + String(cmdCall.id ?? '')
            + ' operations=' + JSON.stringify(inputObj.operations ?? [])
            + ' declared=' + JSON.stringify(declaredTools.map((tool) => tool.function?.name ?? ''))
            + ' reason=' + (mapped.reason ?? '(none)') + '\n'
          process.stderr.write(line)
          try {
            appendFileSync(join(homedir(), '.dsh', 'doubao-task.log'), line)
          } catch {
            /* diagnostics must never break the request */
          }
        }
        unsupportedLocalTaskResult(inputObj, handoffReason)
        try {
          const uploaded = await postToolJson(TOOL_LOCAL_UPLOAD_ENDPOINT, {
            device_id: clientParam('device_id'),
            command_result: { id: cmdCall.id, code: 1, message: handoffReason },
            workspace_apply_response: {
              request_id: inputObj.request_id,
              status: 'failed',
              error_code: mapped.calls.length > 0 ? 'DSH_TOOL_HANDOFF' : 'DSH_TOOL_UNAVAILABLE',
              error_message: handoffReason,
              operation_results: (Array.isArray(inputObj.operations) ? inputObj.operations : []).map((operation: Record<string, unknown>, operation_index: number) => ({
                operation_index,
                ...(typeof operation.path === 'string' ? { path: operation.path } : {}),
                status: 'failed',
                error_code: mapped.calls.length > 0 ? 'DSH_TOOL_HANDOFF' : 'DSH_TOOL_UNAVAILABLE',
                error_message: handoffReason,
              })),
              workspace_ready: false,
            },



          })
          if (uploaded?.code !== 0) return localOperationRejected
          const completed = await postToolJson(TOOL_LOCAL_COMPLETE_ENDPOINT, { msg_id: msgId })
          if (completed?.code !== 0) return localOperationRejected
        } catch {
          return localOperationRejected
        }
        if (mapped.calls.length > 0) {
          onToolCalls(mapped.calls)
          return true
        }
        seq += 1
        continue
      }
      if (agentFinished !== undefined) {
        return localOperationRejected
      }
      seq += 1
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 180))
  }
  return localOperationRejected
}

/**
 * One attempt, no fallback. Split out so {@link streamChat} can retry a
 * task-mode call as plain chat when the task runtime is not attached.
 */
async function streamOnce(
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
      undefined,
      false,
      // Not a network problem: no cookie means "sign in again", and telling the
      // user to check their connection sends them the wrong way.
      { kind: 'session_dead' },
    )
  }
  const missing = CORE_AUTH_COOKIE_NAMES.filter((name) => !credentials.pairs.get(name))
  if (missing.length > 0) {
    throw new DoubaoUpstreamError(
      `Doubao session cookies missing: ${missing.join(', ')}`,
      undefined,
      false,
      { kind: 'session_dead' },
    )
  }

  const msToken = credentials.pairs.get('msToken')
  const isTask = taskModeEnabled(options)
  // ONE identity, both modes.
  //
  // The session is a WEB session (QR login), so every request it authorises must
  // present the web identity — the frozen desktop one (`aid=582478`, a shared
  // device_id, `SamanthaDoubao/2.31.4`) is exactly the mismatch risk control
  // compared. Task turns used to keep the desktop identity on the theory that
  // task mode "belongs" to the desktop client, but the captured web query already
  // carries the same desktop-shaped fields (`doubao_pc_version`, `samantha_web=1`),
  // so the split bought no protocol safety — only a second, inconsistent
  // fingerprint for the same session.
  const identity = browserFingerprint()
  // Non-fatal, but never silent: a browser session presented with the desktop
  // identity is the mismatch that invites 710022004, and the fix is one command.
  if (!isTask && identity === null && !warnedMissingFingerprint) {
    warnedMissingFingerprint = true
    process.stderr.write('[identity] no web fingerprint; sending with the desktop identity — run: dsh-connect-doubao-doctor --fingerprint\n')
  }
  const url = buildQueryUrl(CHAT_ENDPOINT, msToken, identity)
  const headers = buildHeaders(credentials, { 'content-type': 'application/json' }, identity)
  const bodyObj = buildChatBody(prompt, options)
  const uniqueKey = bodyObj.option.unique_key
  const body = JSON.stringify(bodyObj)
  // Image turns and task turns keep their specialized channels. Ordinary chat
  // can use the official page itself, including its model selection and signing.
  const useBrowserRelay = !isTask
    && options.skill === undefined
    && options.modelKey !== DOUBAO_IMAGE_MODEL_ID
    && (options.attachments === undefined || options.attachments.length === 0)
    && browserRelayEnabled()

  let response: Response
  try {
    response = useBrowserRelay
      ? await browserRelayChat(prompt, {
          ...(options.signal ? { signal: options.signal } : {}),
        })
      : await fetch(url, {
          method: 'POST',
          headers,
          body,
          ...(options.signal ? { signal: options.signal } : {}),
        })
  } catch (error) {
    // A caller abort is not a failure — let the AbortError through untouched so
    // the shim can tell "user cancelled" from "network broke".
    if (options.signal?.aborted) throw error
    throw new DoubaoUpstreamError(
      useBrowserRelay
        ? `官方浏览器转发失败：${(error as Error).message}`
        : `Doubao request did not reach the server: ${(error as Error).message}`,
      undefined,
      false,
      { transport: true },
    )
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new DoubaoUpstreamError(
      `Doubao chat request failed with HTTP ${response.status}. ${detail.slice(0, 200)}`,
      undefined,
      false,
      { httpStatus: response.status },
    )
  }

  // Fold the server's credential refreshes back into our in-memory jar so the
  // next call stays authenticated.
  absorbSetCookies(response.headers)

  let streamDone = false
  let taskToolCalls: EmulatedToolCall[] = []
  let localOperationRejected = false
  const responderPromise = isTask
    ? runToolLocalResponder(uniqueKey, credentials, () => streamDone, options.signal, options.declaredTools ?? [], (calls) => { taskToolCalls = calls })
        .then((rejected) => { localOperationRejected = rejected })
        .catch(() => {})
    : Promise.resolve()

  let result: DoubaoChatResult | undefined
  let streamError: unknown
  try {
    result = await consumeStream(response, options.callbacks, {
      harvestNotifyText: isTask,
    })
  } catch (error) {
    streamError = error
  } finally {
    streamDone = true
    await responderPromise
  }
  if (localOperationRejected && taskToolCalls.length === 0) {
    throw new DoubaoUpstreamError(
      'LOCAL_EXECUTION_UNAVAILABLE: Doubao task mode requested a local operation, but this plugin did not execute it through DSH tools.',
      undefined,
      false,
      { kind: 'upstream' },
    )
  }
  if (streamError !== undefined) throw streamError
  if (result === undefined) throw new Error('Doubao stream ended without a result')
  return taskToolCalls.length > 0 ? { ...result, toolCalls: taskToolCalls } : result
}

/**
 * Conservative direct-Node request controls.
 *
 * These are deliberately NOT official Doubao limits. They exist to stop the
 * plugin itself from looking like an automation loop: one request at a time, a
 * quiet gap between attempts, and a persistent circuit breaker after 710022004.
 */
/**
 * 8s was chosen while the direct path still presented the DESKTOP identity with
 * web cookies, i.e. while every request was a candidate for a slider challenge.
 * With the captured web identity a plain turn costs ~1.7-4s of upstream time, so
 * the old gap made any second request in the same turn (title, summary, retry)
 * wait up to 8 seconds for no protection it still needed. 2s stays serialized and
 * slower than a human typing a follow-up.
 */
const DEFAULT_NODE_INTERVAL_MS = 2_000
const DEFAULT_RISK_COOLDOWN_MS = 60 * 60 * 1000
let nodeQueue: Promise<unknown> = Promise.resolve()
let lastNodeAttemptAt = 0

interface RiskCircuitState {
  until?: number
  updatedAt?: string
}

function envDuration(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function riskStatePath(): string {
  return process.env.DSH_DOUBAO_RISK_STATE_PATH
    ?? join(homedir(), '.dsh', 'doubao-risk-circuit.json')
}

function readRiskState(): RiskCircuitState | undefined {
  try {
    return JSON.parse(readFileSync(riskStatePath(), 'utf8')) as RiskCircuitState
  } catch {
    return undefined
  }
}

function remainingRiskCooldown(): number {
  const until = readRiskState()?.until
  return typeof until === 'number' ? Math.max(0, until - Date.now()) : 0
}

function enforceRiskCircuit(): void {
  const remaining = remainingRiskCooldown()
  if (remaining <= 0) return
  const minutes = Math.max(1, Math.ceil(remaining / 60_000))
  process.stderr.write(`[circuit] blocked; ${minutes}m remaining\n`)
  throw new DoubaoUpstreamError(
    `豆包风控冷却中，约 ${minutes} 分钟后再试。本次没有向上游发送请求。`,
    CODE_RATE_LIMITED,
    true,
    { kind: 'rate_limited', local: true },
  )
}

function openRiskCircuit(error: unknown): void {
  if (!(error instanceof DoubaoUpstreamError) || error.code !== CODE_RATE_LIMITED) return
  const cooldownMs = envDuration('DSH_DOUBAO_RISK_COOLDOWN_MS', DEFAULT_RISK_COOLDOWN_MS)
  if (cooldownMs <= 0) return
  const path = riskStatePath()
  const until = Date.now() + cooldownMs
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ until, updatedAt: new Date().toISOString() }), 'utf8')
  process.stderr.write(`[circuit] opened for ${Math.ceil(cooldownMs / 60_000)}m after 710022004\n`)
}

/** Milliseconds left on the local risk cooldown (0 when it is not open). */
export function riskCircuitRemainingMs(): number {
  return remainingRiskCooldown()
}

/** Clear the local cooldown once a human has cleared the challenge upstream. */
export function clearRiskCircuit(): void {
  const path = riskStatePath()
  const state = readRiskState()
  if (state?.until === undefined || state.until <= 0) return
  writeFileSync(path, JSON.stringify({ until: 0, updatedAt: new Date().toISOString() }), 'utf8')
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      if (signal !== undefined) signal.removeEventListener('abort', aborted)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const aborted = (): void => {
      clearTimeout(timer)
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal?.aborted === true) { aborted(); return }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

async function runNodeCall<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const execute = async (): Promise<T> => {
    enforceRiskCircuit()
    const interval = envDuration('DSH_DOUBAO_MIN_INTERVAL_MS', DEFAULT_NODE_INTERVAL_MS)
    const waitMs = Math.max(0, lastNodeAttemptAt + interval - Date.now())
    if (waitMs > 0) {
      process.stderr.write(`[throttle] waiting ${waitMs}ms before the next Node request\n`)
      await delay(waitMs, signal)
    }
    enforceRiskCircuit()
    lastNodeAttemptAt = Date.now()
    try {
      const result = await call()
      clearRiskCircuit()
      return result
    } catch (error) {
      openRiskCircuit(error)
      throw error
    }
  }
  const run = nodeQueue.then(execute, execute)
  nodeQueue = run.catch(() => {})
  return run
}

/**
 * Stream one completion and return the assembled reply.
 *
 * Rejects with `DoubaoUpstreamError` when the server answers with a business
 * error frame — notably `710022004 rate limited`, which is risk control asking
 * for a slider CAPTCHA rather than an authentication failure.
 *
 * TASK MODE FALLBACK. Since 0.4.1 a task-mode turn is served by the
 * `tool_local` responder above, so it normally completes. This is now a
 * last-resort net: if the responder cannot satisfy the runtime (upstream change,
 * network failure), the server answers with `710010702 system error` instead of
 * a reply (verified: the stream still names `Agent-GeneralTask`, so the mode
 * itself was accepted). Rather than hand that placeholder to the user, the call
 * is retried ONCE as plain chat — and only when the failed attempt emitted no
 * text, so a fallback can never duplicate a partially streamed answer.
 */
export async function streamChat(
  prompt: string,
  options: ChatRequestOptions & {
    signal?: AbortSignal
    callbacks?: StreamCallbacks
    credentials?: DoubaoCredentials
  } = {},
): Promise<DoubaoChatResult> {
  let emittedText = false
  const wrapped: StreamCallbacks = {
    onText: (delta) => {
      if (delta) emittedText = true
      options.callbacks?.onText?.(delta)
    },
    // Forwarded, or the deep-think deltas die here: consumeStream emits them
    // through this wrapper, so omitting the field silently swallowed every
    // reasoning delta and `reasoning_content` was always empty.
    onThinking: (delta) => options.callbacks?.onThinking?.(delta),
    onEvent: (event) => options.callbacks?.onEvent?.(event),
  }
  const wanted = taskModeEnabled(options)
  const call = (taskMode: boolean): Promise<DoubaoChatResult> => {
    const execute = (): Promise<DoubaoChatResult> =>
      streamOnce(prompt, { ...options, callbacks: wrapped, taskMode })
    const useRelay = !taskMode
      && options.skill === undefined
      && options.modelKey !== DOUBAO_IMAGE_MODEL_ID
      && browserRelayEnabled()
    return useRelay ? execute() : runNodeCall(execute, options.signal)
  }
  try {
    return await call(wanted)
  } catch (error) {
    const taskRuntimeMissing = error instanceof DoubaoUpstreamError &&
      (error.code === CODE_TASK_RUNTIME_UNAVAILABLE || /agent_err_real_answer/.test(error.message))
    if (!wanted || !taskRuntimeMissing || emittedText) throw error
    return call(false)
  }
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
  options: { harvestNotifyText?: boolean } = {},
): Promise<DoubaoChatResult> {
  const reader = response.body?.getReader()
  if (!reader) throw new DoubaoUpstreamError('Doubao returned an empty response body.')
  const decoder = new TextDecoder()
  let buffer = ''
  const texts: string[] = []
  /** Text carried by STREAM_MSG_NOTIFY instead of by chunk deltas. */
  const notifyTexts: string[] = []
  /** Generated images, in arrival order (may repeat a task while it streams). */
  const images: DoubaoImage[] = []
  /** Private reasoning (deep-think turns), kept out of the answer. */
  const reasoningParts: string[] = []
  /** Shared per-stream state across `10040` / `10000` / `CHUNK_DELTA` frames. */
  const blockState = createBlockCollectState()
  let conversationId: string | undefined
  let messageId: string | undefined
  let model: string | undefined
  let thinking = false
  let reasoningText: string | undefined
  let lastEventId: string | undefined
  let ended = false
  /**
   * Every event name seen, in arrival order (deduped).
   *
   * Task mode answers with a richer event vocabulary than chat, so an empty
   * completion is usually "the text lives in an event we do not harvest yet"
   * rather than "the server said nothing". Naming the events turns an opaque
   * failure into a next step.
   */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* best-effort telemetry parse */
  }
  return undefined
}

function parseContextWindowUsage(raw: unknown): DoubaoContextWindowUsage | undefined {
  const obj = parseJsonObject(raw)
  if (obj === undefined) return undefined
  const systemPrompt = toFiniteNumber(obj.system_prompt)
  const messages = toFiniteNumber(obj.messages)
  const skills = toFiniteNumber(obj.skills)
  const tools = toFiniteNumber(obj.tools)
  const totalWindowSize = toFiniteNumber(obj.total_window_size)
  if (
    systemPrompt === undefined &&
    messages === undefined &&
    skills === undefined &&
    tools === undefined &&
    totalWindowSize === undefined
  ) {
    return undefined
  }
  const s = Math.max(0, systemPrompt ?? 0)
  const m = Math.max(0, messages ?? 0)
  const k = Math.max(0, skills ?? 0)
  const t = Math.max(0, tools ?? 0)
  const w = Math.max(0, totalWindowSize ?? 0)
  return {
    systemPrompt: s,
    messages: m,
    skills: k,
    tools: t,
    totalWindowSize: w,
    totalUsed: s + m + k + t,
  }
}

function collectTelemetryFromExt(ext: unknown, target: DoubaoUpstreamTelemetry): void {
  const record = parseJsonObject(ext)
  if (record === undefined) return
  const contextWindow = parseContextWindowUsage(record.context_window_usage)
  if (contextWindow !== undefined) {
    target.contextWindowUsage = contextWindow
  }
  const teaCost = parseJsonObject(record.tea_tags_time_cost)
  if (teaCost !== undefined) {
    const ack = toFiniteNumber(teaCost.ack_cost_time)
    if (ack !== undefined && ack >= 0) target.ackCostMs = ack
    const firstPacket = toFiniteNumber(teaCost.first_packet_cost_time)
    if (firstPacket !== undefined && firstPacket >= 0) target.firstPacketCostMs = firstPacket
  }
  const finishTime = toFiniteNumber(record.finish_time_ms)
  if (finishTime !== undefined && finishTime >= 0) target.finishTimeMs = finishTime
  if (typeof record.finish_reason_chat === 'string' && record.finish_reason_chat !== '') {
    target.finishReasonChat = record.finish_reason_chat
  }
}

function collectTelemetry(payload: unknown, target: DoubaoUpstreamTelemetry): void {
  if (payload === null || typeof payload !== 'object') return
  const record = payload as {
    ext?: unknown
    content?: { ext?: unknown }
    message?: { ext?: unknown }
    patch_op?: Array<{ patch_value?: { ext?: unknown } }>
  }
  collectTelemetryFromExt(record.ext, target)
  collectTelemetryFromExt(record.content?.ext, target)
  collectTelemetryFromExt(record.message?.ext, target)
  if (Array.isArray(record.patch_op)) {
    for (const op of record.patch_op) {
      collectTelemetryFromExt(op?.patch_value?.ext, target)
    }
  }
}

  const events = new Set<string>()
  /** The agent that served this turn, when the server names one. */
  let intentionAgent: string | undefined
  /** Server-side timing & context window telemetry harvested across SSE frames. */
  const telemetry: DoubaoUpstreamTelemetry = {}
  /**
   * `expose_reason` of a task turn whose runtime was unreachable.
   *
   * Recorded instead of surfacing its placeholder text (「出了点问题，请稍后重试。」),
   * which reads like a transient glitch and hides the actual cause.
   */
  let taskAgentError: string | undefined

  const handle = (frame: StreamFrame): void => {
    const name = frame.event ?? ''
    if (name) events.add(name)
    // Task mode answers with frames chat mode never emits. Dump them on demand
    // rather than guessing which envelope carries the text.
    if (process.env.DSH_DOUBAO_DEBUG_FRAMES === '1' && frame.data) {
      process.stderr.write(`[frame ${name || '(none)'}] ${frame.data.slice(0, 1500)}\n`)
    }
    if (name && callbacks?.onEvent) callbacks.onEvent(name)
    if (frame.id) lastEventId = frame.id
    if (!frame.data) return

    let payload: unknown
    try {
      payload = JSON.parse(frame.data)
    } catch {
      return
    }
    collectTelemetry(payload, telemetry)

    if (name === 'STREAM_ERROR') {
      const record = payload as { error_code?: number; error_msg?: string }
      const code = record.error_code
      const message = record.error_msg ?? 'unknown stream error'
      const rateLimited = code === 710022004 || /rate limit/i.test(message)
      // Content moderation is a different stop than the slider: no retry will
      // clear it, and the user can actually fix the wording.
      if (isContentModerationNotice(message)) {
        throw new DoubaoUpstreamError(
          `豆包内容审核拦截了这条消息：${message}`,
          code,
          false,
          { kind: 'content_blocked' },
        )
      }
      throw new DoubaoUpstreamError(
        rateLimited
          ? '豆包请求触发风控（710022004）。请停止重试并等待风控缓解；如果豆包网页出现人机验证，请完成验证。插件无法绕过风控。'
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
      const record = payload as {
        message?: { message_id?: string; ext?: unknown; content?: unknown }
        content?: { ext?: unknown; content_block?: unknown }
        ext?: unknown
      }
      messageId = record.message?.message_id ?? messageId
      model = model ?? extractModel(payload)
      thinking = thinking || extractThinking(payload)

      const ext = (record.content?.ext ?? record.message?.ext ?? record.ext) as
        | Record<string, unknown>
        | undefined
      if (ext !== undefined && ext !== null && typeof ext === 'object') {
        const agent = ext.intention_agent_name
        if (typeof agent === 'string' && agent !== '') intentionAgent = agent
        const reason = ext.expose_reason
        if (typeof reason === 'string' && /agent_err_real_answer/.test(reason)) {
          taskAgentError = reason
        }
      }

      // Chat mode streams the answer as STREAM_CHUNK deltas; a TASK turn instead
      // delivers the whole reply in THIS frame's content_block. Harvest both and
      // decide afterwards which one was real (chunks win), so neither shape is
      // lost — and so an empty `texts` can no longer hide a reply that arrived
      // here instead.
      //
      // FULL_MSG_NOTIFY stays excluded: it carries the USER's own message, so
      // harvesting it would replay the prompt into the answer.
      if (name === 'STREAM_MSG_NOTIFY') {
        thinking = thinking || extractThinking(payload)
        const acc = { answer: [] as string[], thinking: [] as string[], images }
        collectBlocks(record.content?.content_block, acc, blockState)
        const joinedAccThinking = acc.thinking.join('')
        const priorThinking = reasoningParts.join('')
        const isDuplicateThinkingReplay = joinedAccThinking !== '' && priorThinking !== '' && joinedAccThinking === priorThinking
        if (!isDuplicateThinkingReplay) {
          for (const piece of acc.thinking) {
            if (!piece) continue
            reasoningParts.push(piece)
            if (callbacks?.onThinking) callbacks.onThinking(piece)
          }
        }
        for (const piece of acc.answer) {
          if (!piece) continue
          notifyTexts.push(piece)
          // Emitted live: this frame carries the OPENING of the reply, and the
          // chunk patches that follow are deltas appended after it.
          if (callbacks?.onText) callbacks.onText(piece)
        }
      }
      return
    }

    if (name === 'STREAM_CHUNK' || name === 'CHUNK_DELTA') {
      model = model ?? extractModel(payload)
      thinking = thinking || extractThinking(payload)
      const acc = { answer: [] as string[], thinking: [] as string[], images }
      collectBlocks(payload, acc, blockState)
      for (const piece of acc.thinking) {
        if (!piece) continue
        reasoningParts.push(piece)
        if (callbacks?.onThinking) callbacks.onThinking(piece)
      }
      for (const text of acc.answer) {
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
    // Flush the decoder and parse whatever trailing bytes are still buffered:
    // when the socket closes without a final blank line, the last frame was
    // left in `buffer` and dropped.
    const tail = decoder.decode()
    if (tail) {
      const { frames, rest } = parseFrames(buffer + tail)
      buffer = rest
      for (const frame of frames) handle(frame)
    }
  } finally {
    // Cancel before releasing: releasing the lock with the body still unread
    // leaves the connection (and the upstream turn) running to completion.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }

  const chunkText = texts.join('')
  const notifyText = notifyTexts.join('')
  const raw = assembleReplyText(notifyText, chunkText)
  const text = stripPromptEcho(raw)
  if (taskAgentError !== undefined) {
    // Checked BEFORE the empty-completion branch: the placeholder text is
    // non-empty, so ordering it after would report a generic failure and lose
    // the one fact that matters — the task runtime was never reached.
    throw new DoubaoUpstreamError(
      `Doubao accepted the task but its executing runtime was unreachable ` +
      `(${taskAgentError}). The 「工作任务」 runtime is attached by the desktop ` +
      `client; without it the agent has nowhere to run.`,
      CODE_TASK_RUNTIME_UNAVAILABLE,
    )
  }
  // TERMINAL VERDICT.
  //
  // Only SSE_REPLY_END means the server finished this reply. A socket that
  // closes early (proxy reset, idle timeout, client gone) used to be treated as
  // success: the partial text was returned and the shim wrote
  // finish_reason:"stop" + [DONE], so a truncated answer looked complete.
  if (!ended) {
    const received = texts.join('').length + notifyTexts.join('').length
    throw new DoubaoUpstreamError(
      `Doubao closed the stream before the reply finished` +
        `${received > 0 ? ` after ${received} characters` : ''}; ` +
        `the answer is incomplete. Retry the turn.`,
      undefined,
      false,
      { truncated: true },
    )
  }

  // A creation streams the same task several times (placeholder → filled), so
  // collapse by URL and keep first-seen order.
  // The notice can also arrive as ordinary reply text. Returning it as the
  // answer would make the plugin look like it "replied" with a policy message
  // and would hide the one fact the user can act on.
  if (isContentModerationNotice(text)) {
    throw new DoubaoUpstreamError(
      `豆包内容审核拦截了这条消息：${text}`,
      undefined,
      false,
      { kind: 'content_blocked' },
    )
  }

  const uniqueImages = [...new Map(images.map((image) => [image.url, image])).values()]
  if (!text && uniqueImages.length === 0) {
    const seen = [...events]
    throw new DoubaoUpstreamError(
      `Doubao returned an empty completion` +
      `${lastEventId ? ` (last event id ${lastEventId})` : ''}` +
      `${seen.length > 0 ? `; events seen: ${seen.join(', ')}` : '; no events at all'}.`,
    )
  }
  return {
    text,
    ...(model !== undefined ? { model } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(reasoningParts.length > 0 ? { reasoningText: reasoningParts.join('') } : {}),
    ...(intentionAgent !== undefined ? { intentionAgent } : {}),
    ...(Object.keys(telemetry).length > 0 ? { telemetry } : {}),
    images: uniqueImages,
    thinking: thinking || blockState.sawThinkingBlock === true || reasoningParts.length > 0,
  }
}

/**
 * Join the two halves of a reply.
 *
 * The opening of every answer arrives in STREAM_MSG_NOTIFY and the remainder as
 * patch deltas in STREAM_CHUNK. Reading only the chunks swallowed the first
 * character of EVERY reply — 「1+1等于2。」 came back as 「+1等于2。」, 「我是豆包」
 * as 「是豆包」 — and nothing failed loudly, which is exactly why it survived.
 *
 * A cumulative chunk stream (one that re-sends what was already delivered)
 * already starts with the notification text; that case is detected rather than
 * concatenated twice. Exported so the rule can be tested without a live stream.
 */
export function assembleReplyText(notifyText: string, chunkText: string): string {
  if (notifyText === '') return chunkText
  if (chunkText === '') return notifyText
  return chunkText.startsWith(notifyText) ? chunkText : notifyText + chunkText
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
  options: ChatRequestOptions & { signal?: AbortSignal; callbacks?: StreamCallbacks; credentials?: DoubaoCredentials } = {},
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
export type DoubaoErrorKind =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'session_dead'
  | 'network'
  | 'upstream'
  /**
   * The account is routing to the 「工作任务」 agent, whose executing runtime is
   * the desktop app's own process.
   *
   * Kept as its own class because the fix is a single toggle, and calling it
   * `network` (which is where the old classifier dropped it) sends the user to
   * check their Wi-Fi for a problem that is one switch away from solved.
   */
  | 'task_runtime_unavailable'
  /**
   * The prompt is larger than Doubao's own request-body ceiling.
   *
   * Measured 2026-11-22: the wall is on the UTF-8 BYTES of the message text,
   * not on tokens and not on characters — 262,144 ASCII characters pass and
   * 262,145 fail, i.e. exactly 256 KiB. Doubao answers this with 710020202
   * ("common invalid param"), the same code a dead conversation id produces,
   * which is why it used to read as an unexplained parameter error.
   *
   * Its own class because the fix is the host's, not the user's: compact and
   * retry. Reported as CONTEXT_WINDOW_EXCEEDED so that path is taken.
   */
  | 'context_overflow'
  /**
   * Doubao's CONTENT moderation stopped the message — not the risk-control
   * slider, not a broken upstream.
   *
   * Its own class because the only fix is the user's wording: the notice itself
   * says 「涉嫌违反豆包使用规范」 and offers 反馈与举报, and resending identical
   * text only adds to the same record.
   */
  | 'content_blocked'

/** The server's business code for "this session is not valid". */
const CODE_SESSION_DEAD = 710012001
/** The server's business code for a risk-control slider challenge. */
const CODE_RATE_LIMITED = 710022004
/**
 * `block_type` of the deep-think container.
 *
 * A 深度思考 turn opens one `10040` block (the 「正在思考 / 已完成思考」 shell) and
 * then streams the reasoning as `10000` blocks whose `parent_id` is its id.
 * Captured 2026-10-23.
 */
const THINKING_BLOCK_TYPE = 10040
/**
 * The server's business code when a 「工作任务」 was accepted but its executing
 * runtime could not be reached (`expose_reason: agent_err_real_answer`).
 *
 * This is the signature of "the mode is right, the local runtime is not
 * attached" — the desktop client's CUA runtime registers itself; an external
 * client has nothing to register, so the agent has nowhere to run.
 */
const CODE_TASK_RUNTIME_UNAVAILABLE = 710010702
/**
 * The server's business code for "common invalid param".
 *
 * Observed on a CONTINUATION turn whose remembered `conversation_id` the
 * server no longer accepts (the thread expired or was deleted upstream): the id
 * is the only parameter that differs from a fresh-conversation request, and the
 * same request then fails identically on every retry.
 */
const CODE_INVALID_PARAM = 710020202

/**
 * Whether the upstream rejected the request parameters outright.
 *
 * Callers that were continuing a remembered conversation should drop the id
 * after this failure — keeping it would repeat the same rejection for the rest
 * of the session TTL instead of opening a fresh thread.
 */
export function isInvalidParamFailure(error: unknown): boolean {
  return error instanceof DoubaoUpstreamError && error.code === CODE_INVALID_PARAM
}

/**
 * Map one upstream error onto its class.
 *
 * Order matters: the explicit evidence (code, hint, HTTP status) is consulted
 * before the generic `upstream` bucket, and the old catch-all was wrong — every
 * unrecognised failure was reported as `network`, i.e. "check your connection",
 * for HTTP 400s and business errors that a retry cannot fix.
 */
export function classifyDoubaoFailure(error: DoubaoUpstreamError): DoubaoErrorKind {
  if (error.kindHint !== undefined) return error.kindHint
  if (error.rateLimited || error.code === CODE_RATE_LIMITED) return 'rate_limited'
  if (error.code === CODE_TASK_RUNTIME_UNAVAILABLE) return 'task_runtime_unavailable'
  if (error.code === CODE_SESSION_DEAD) return 'session_dead'
  if (error.httpStatus === 401 || error.httpStatus === 403) return 'session_dead'
  if (error.httpStatus === 429) return 'quota_exhausted'
  if (error.transport) return 'network'
  return 'upstream'
}

/**
 * Whether the host should retry this failure.
 *
 * Deliberately narrow. Re-sending a turn costs quota AND opens a server-side
 * thread, so only a failure that provably never produced an answer qualifies:
 * a transport error before any bytes, or a 5xx. A truncated stream is NOT
 * retryable here — the retry would be a fresh conversation that silently
 * abandons the half-received one, so the user is told instead.
 */
export function isRetryableFailure(error: unknown): boolean {
  if (!(error instanceof DoubaoUpstreamError)) return false
  if (error.transport) return true
  if (error.httpStatus !== undefined) return error.httpStatus >= 500
  return false
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
    '豆包请求触发风控（710022004）—— 这是人机验证（滑块），不是普通限流，插件不会也无法绕过。'
    + '先对齐网页身份（多数情况就是它引起的）：dsh-connect-doubao-doctor --fingerprint，'
    + '再 --resume 解除本地冷却；仍被要求验证时用 --verify 打开官方页面人工过滑块；'
    + '想彻底避开就用 --relay on 让对话请求走真实浏览器。',
  quota_exhausted:
    '豆包额度已用尽。请等待额度窗口重置，或在豆包客户端查看「订阅与额度管理」。',
  session_dead:
    '豆包登录态失效。请在豆包客户端重新登录，然后重试。',
  network:
    '连接豆包失败（网络或超时）。请检查网络后重试。',
  task_runtime_unavailable:
    '豆包把这个账号路由到了「工作任务」代理，而该任务的执行运行时只存在于豆包客户端进程里，外部客户端接不上。请打开豆包客户端，把输入框上方的开关切回「对话」，然后重试；需要多步执行的话，交给 DSH 自己的工具来做。',
  upstream:
    '豆包返回了错误响应（不是网络问题，重试通常无效）。',
  content_blocked:
    '豆包的内容审核拦截了这条消息 —— 不是网络、额度或滑块风控的问题。插件不会也无法绕过内容审核。'
    + '请换一种表达、或把问题拆小后重试；如果是误判，在豆包客户端长按该条消息 →「反馈与举报」。'
    + '反复触发可能导致账号被限制。',
  context_overflow:
    '这次请求的内容超过了豆包单次请求上限（256 KiB 的 UTF-8 文本，约 26 万 ASCII 字符）。请压缩上下文或缩短单条消息后重试；DSH 通常会自动压缩并重发。',
}

/**
 * Whether a text is Doubao's content-moderation notice rather than an answer.
 *
 * Deliberately narrow: a model that EXPLAINS the notice (a user asking
 * 「这句提示是什么意思」) quotes it inside a normal reply, and turning that reply
 * into an error would be worse than showing it. Both a head that names the
 * message as violating and the appeal hint are required, and the text must be
 * short — the real notice is one sentence.
 */
export function isContentModerationNotice(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > 200) return false
  // The platform's own wording: names the policy it violated, prints the exact
  // appeal button, and tells you how to reach it. A model explaining the notice
  // paraphrases at least one of the three, which is what keeps it an answer.
  const flagged = /涉嫌违反|违反[^。！？\n]{0,6}使用规范/.test(trimmed)
  const appeal = /反馈与举报/.test(trimmed)
  const instruction = /长按|本条消息|该内容|这条消息/.test(trimmed)
  return flagged && appeal && instruction
}

/** Build a user-facing message for a Doubao failure. */
export function describeDoubaoFailure(error: unknown): string {
  if (error instanceof DoubaoUpstreamError) {
    // The cooldown is OURS, not the server's. Saying "被风控" for a turn that was
    // never sent sends the user to the Doubao web page for a challenge that does
    // not exist; the only useful next step is the local reset.
    if (error.local) {
      return `${error.message}（如果已经在官方页面完成过人机验证，运行 dsh-connect-doubao-doctor --resume 立即解除本地冷却。）`
    }
    return `${DOUBAO_ERROR_HINTS[classifyDoubaoFailure(error)]}（${error.message}）`
  }
  // Not an upstream failure at all — a bug here, not a bad connection.
  return `豆包请求失败：${(error as Error)?.message ?? String(error)}`
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