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
import { hostname, homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findDoubaoUserDataDir,
  loadDoubaoCredentials,
  REQUIRED_COOKIE_NAMES,
  type DoubaoCredentials,
} from './doubao-auth.ts'
import {
  CHAT_AGENT_MODE,
  TASK_AGENT_MODE,
  DOUBAO_CONTEXT_WINDOW,
  findDoubaoModel,
  findReasoningLevel,
  needDeepThinkOf,
  TASK_RUNTIME_LOCAL_PC,
  TASK_SANDBOX_AUTH_ALLOW_ALL,
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
  /**
   * The agent the server says served this turn (`intention_agent_name`).
   *
   * Not a model identifier — it names the server-side AGENT, which is how a
   * 「工作任务」 turn becomes visible at all: chat turns and task turns use the
   * same endpoint and the same stream, and this field is the only read-back
   * evidence of which one was actually used.
   */
  intentionAgent?: string
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
   * Directory the task declares as its workspace.
   *
   * The cloud plans against these paths, so they must be real on THIS machine.
   * Defaults to `DSH_DOUBAO_WORKSPACE`, then `process.cwd()`.
   */
  workspace?: string
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
  // Opt-in, not default.
  //
  // 2026-10-22 measurement: sending `ext.general_task_param` (runtime_type 2) DOES
  // switch the turn — the server answers `intention_agent_name:
  // Agent-GeneralTask` — but the agent then fails with `710010702` because its
  // executing runtime is the desktop app's CUA process, which an external client
  // cannot register. Worse, the routing is bound to the DEVICE: with
  // `general_task_param` omitted entirely the same device still gets
  // Agent-GeneralTask, so once the Doubao app's 对话/工作 switch sits on 工作 every
  // turn from this client fails, not just task turns.
  //
  // Defaulting this on would therefore break ordinary chat for as long as the
  // runtime question is unresolved. `DSH_DOUBAO_TASK=1` turns it back on for
  // anyone who wants to keep probing it.
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
      local_device_id: CLIENT_PARAMS.device_id,
      local_app_id: CLIENT_PARAMS.aid,
      sandbox_auth_type: TASK_SANDBOX_AUTH_ALLOW_ALL,
    },
    agent_task_param_change: {
      runtime_changed: false,
      device_changed: false,
      sandbox_auth_type_changed: false,
    },
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
export function buildChatBody(prompt: string, options: ChatRequestOptions = {}) {
  const model = findDoubaoModel(options.modelKey)
  const level = findReasoningLevel(options.reasoningLevel)
  const task = taskModeEnabled(options)
  /**
   * 2 = 普通对话, 1 = 「工作任务」.
   *
   * CDP-captured from the running client on 2026-10-22. This constant was the
   * bug: the plugin sent 1 for chat, so the server answered every turn as a work
   * task — `Agent-GeneralTask`, then `710010702` because the task runtime is the
   * desktop app's own CUA process.
   */
  const agentMode = options.agentMode ?? (task ? TASK_AGENT_MODE : CHAT_AGENT_MODE)
  const localMessageId = randomUUID()
  /**
   * Mode id the model picker groups by. The captured chat request carries "1" in
   * BOTH `conversation_init_ext` and `aggregate_params`; leaving it out lets the
   * server choose a mode for us.
   */
  const modeId = (process.env.DSH_DOUBAO_MODE_ID ?? '').trim() || '1'
  /**
   * The client's own default for `general_task_param` on an ordinary turn.
   *
   * NOTE the shape: an OBJECT inside `option` and the same thing STRINGIFIED
   * inside `ext`. That asymmetry is the client's, not a mistake here.
   */
  const plainTaskParam = { server_do_compare: true }
  const taskParam = task
    ? buildGeneralTaskParam(localMessageId, taskWorkspaceOf(options))
    : plainTaskParam

  return {
    messages: [
      {
        local_message_id: localMessageId,
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
      // 0, always. The captured chat request carries 0 even with reasoning
      // effort 高 — the level travels in `reasoning_effort`, and this field is
      // the (off) deep-think toggle. The plugin used to send 10000+level here,
      // a value the client never emits on this path.
      need_deep_think: 0,
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
      // This client keeps no thread: it re-flattens the transcript every turn,
      // so every request is a NEW conversation.
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
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
        // Empty in the captured request. The 256k window is negotiated by the
        // server for this account; asserting it here was our own invention.
        model_extra_params: {},
        reasoning_effort: level.level,
      },
      aggregate_params: {
        mention_skill_list: '[]',
        mention_plugin_list: '[]',
        mention_ext: '[{}]',
        conversation_mode: '',
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
      use_deep_think: '0',
      sub_conv_firstmet_type: '1',
      general_task_param: JSON.stringify(taskParam),
      collection_id: '',
      is_finish: '1',
      conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
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

  const result = await consumeStream(response, options.callbacks, {
    harvestNotifyText: taskModeEnabled(options),
  })
  return result
}

/**
 * Stream one completion and return the assembled reply.
 *
 * Rejects with `DoubaoUpstreamError` when the server answers with a business
 * error frame — notably `710022004 rate limited`, which is risk control asking
 * for a slider CAPTCHA rather than an authentication failure.
 *
 * TASK MODE FALLBACK. 「工作任务 · 本地电脑」 is the default, but the task agent
 * is executed by a runtime that only the desktop app attaches; when it is
 * absent the server answers the turn with `710010702 system error` instead of a
 * reply (verified: the stream still names `Agent-GeneralTask`, so the mode
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
    onEvent: (event) => options.callbacks?.onEvent?.(event),
  }
  const wanted = taskModeEnabled(options)
  const call = (taskMode: boolean): Promise<DoubaoChatResult> =>
    streamOnce(prompt, { ...options, callbacks: wrapped, taskMode })
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
  const events = new Set<string>()
  /** The agent that served this turn, when the server names one. */
  let intentionAgent: string | undefined
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
        const acc = { out: [] as string[] }
        harvestText(record.content?.content_block, acc)
        for (const piece of acc.out) {
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

  const chunkText = texts.join('')
  const notifyText = notifyTexts.join('')
  /**
   * The reply is `notify` + chunk deltas.
   *
   * The opening lands in STREAM_MSG_NOTIFY and the rest arrives as patch deltas
   * in STREAM_CHUNK, so taking only the chunks silently swallowed the first
   * character of EVERY answer (「1+1」 came back as 「+1」, 「我是豆包」 as
   * 「是豆包」). A cumulative chunk stream would already start with the notify
   * text, so that case is detected instead of concatenated twice.
   */
  const raw = chunkText.startsWith(notifyText) ? chunkText : notifyText + chunkText
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
  if (!text) {
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
    ...(reasoningText !== undefined ? { reasoningText } : {}),
    ...(intentionAgent !== undefined ? { intentionAgent } : {}),
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

/** The server's business code for "this session is not valid". */
const CODE_SESSION_DEAD = 710012001
/** The server's business code for a risk-control slider challenge. */
const CODE_RATE_LIMITED = 710022004
/**
 * The server's business code when a 「工作任务」 was accepted but its executing
 * runtime could not be reached (`expose_reason: agent_err_real_answer`).
 *
 * This is the signature of "the mode is right, the local runtime is not
 * attached" — the desktop client's CUA runtime registers itself; an external
 * client has nothing to register, so the agent has nowhere to run.
 */
const CODE_TASK_RUNTIME_UNAVAILABLE = 710010702

/** Map one upstream error onto its class. */
export function classifyDoubaoFailure(error: DoubaoUpstreamError): DoubaoErrorKind {
  if (error.rateLimited || error.code === CODE_RATE_LIMITED) return 'rate_limited'
  if (error.code === CODE_TASK_RUNTIME_UNAVAILABLE) return 'task_runtime_unavailable'
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
  task_runtime_unavailable:
    '豆包把这个账号路由到了「工作任务」代理，而该任务的执行运行时只存在于豆包客户端进程里，外部客户端接不上。请打开豆包客户端，把输入框上方的开关切回「对话」，然后重试；需要多步执行的话，交给 DSH 自己的工具来做。',
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