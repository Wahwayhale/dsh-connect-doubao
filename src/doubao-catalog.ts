/**
 * Doubao model catalog.
 *
 * Doubao DOES let the caller pick a model. The choice travels in the request
 * body at TWO mirrored locations, and upstream ignores the request if only one
 * is written:
 *
 *   option.model_config.model_item_key       ← numeric or slug
 *   option.aggregate_params.model_item_key   ← same value, same body
 *
 * Every id below was read off a real request the desktop app sent, not inferred.
 * They are NOT interchangeable with numbers that appear elsewhere in the body:
 * `aggregate_params.mode_id` is also often "3", but it means the 对话/工作 mode
 * switch, NOT the Turbo model. The two are named apart throughout this codebase
 * precisely because the collision is easy to fall into.
 *
 * ⚠️ ENCODING IS MIXED. `seed-lite-7b` is a string slug; `3`, `5` and `9` are
 * numeric enum values. They travel as JSON strings either way and MUST be
 * forwarded verbatim — never parsed to a number, or the slug is lost.
 *
 * 推理强度 (reasoning effort) is a separate axis. It travels as
 * `reasoning_effort` (mirrored like the model) and, redundantly, as
 * `need_deep_think = 10000 + level` plus `ext.use_deep_think`. See
 * {@link DOUBAO_REASONING_LEVELS} for which levels are verified.
 *
 * @module dsh-connect-doubao/catalog
 */

/** Provider route id this bundle owns. */
export const DOUBAO_PROVIDER = 'doubao'

/** Shown in the DSH model picker. */
export const DOUBAO_PROVIDER_DISPLAY_NAME = '豆包（Doubao）'

/** How much context a Doubao conversation holds. */
export const DOUBAO_CONTEXT_WINDOW = 256_000

/** Generous output ceiling; the subscription quota, not this, is the real bound. */
export const DOUBAO_MAX_TOKENS = 32_000

/**
 * `option.agent_mode` / `ext.agent_mode`.
 *
 * VERIFIED AGAINST A CDP-CAPTURED REQUEST (2026-10-22, 对话 mode):
 *
 *   agent_mode 2  →  普通对话
 *   agent_mode 1  →  「工作任务」 (where every turn is handed to
 *                    `Agent-GeneralTask` and then fails 710010702 when the
 *                    desktop client's CUA runtime is not the requester)
 *
 * The previous revision of this constant said 1 for chat and carried a comment
 * claiming work mode sends 2 — BOTH were backwards, and sending 1 is exactly
 * what made every request from this plugin look like a work task.
 */
export const CHAT_AGENT_MODE = 2

/** 「工作任务」 mode. Its executing runtime is the desktop app's own process. */
export const TASK_AGENT_MODE = 1

/**
 * Which machine runs a 「工作任务」.
 *
 * Read off the desktop client's own enum (`ai-views` bundle, module 941658):
 *
 *   RuntimeType_Cloud_VM  = 1   → 「工作任务 · 云电脑」: ByteDance's VM executes
 *   RuntimeType_Local_PC  = 2   → 「工作任务 · 本地电脑」: THIS machine executes
 *
 * The plugin uses 2 on purpose: the cloud VM's artefacts are unreachable from an
 * external client, whereas the local runtime is this very machine — the same one
 * the Harness already executes tools on.
 */
export const TASK_RUNTIME_CLOUD_VM = 1
export const TASK_RUNTIME_LOCAL_PC = 2

/**
 * Sandbox authorisation level.
 *
 * `2` is what the client sends with its 「全部允许」 authorisation setting (read
 * off the same captured task request). The cloud uses it to decide how freely it
 * may plan file and command actions inside the declared workspace.
 */
export const TASK_SANDBOX_AUTH_ALLOW_ALL = 2

/**
 * A reasoning-effort level.
 *
 * `level` is Doubao's own ordinal and maps onto the wire as
 * `reasoning_effort` and `need_deep_think = 10000 + level`.
 *
 * `level` IS Doubao's `reasoning_effort` — the two are the same number, not two
 * parallel scales. It also feeds `need_deep_think = 10000 + level` and
 * `ext.use_deep_think`. So 高 is `reasoning_effort: 5` AND
 * `need_deep_think: 10005`; there is no separate "tier" numbering anywhere.
 *
 * All three values were read off the running desktop app by diffing the config
 * it re-serialises when the level is switched (M8 续二). They are not inferred
 * and not extrapolated from a pattern.
 */
export interface DoubaoReasoningLevel {
  /** DSH-facing label, matching the desktop app's picker. */
  id: 'low' | 'mid' | 'high'
  name: string
  /** The value sent as `reasoning_effort`; also `need_deep_think - 10000`. */
  level: number
  /** True when `level` was observed on the running client. */
  verified: boolean
}

export const DOUBAO_REASONING_LEVELS: readonly DoubaoReasoningLevel[] = [
  { id: 'low',  name: '低', level: 3, verified: true },
  { id: 'mid',  name: '中', level: 4, verified: true },
  { id: 'high', name: '高', level: 5, verified: true },
]

/** The level used when a request names none. Verified on the wire. */
export const DEFAULT_REASONING_LEVEL_ID = 'high'

/** Reasoning level for an id, falling back to the default. */
export function findReasoningLevel(id: string | undefined): DoubaoReasoningLevel {
  return DOUBAO_REASONING_LEVELS.find((level) => level.id === id)
    ?? DOUBAO_REASONING_LEVELS.find((level) => level.id === DEFAULT_REASONING_LEVEL_ID)!
}

/** `need_deep_think` for a reasoning level: 10000 + level, per a captured request. */
export function needDeepThinkOf(level: DoubaoReasoningLevel): number {
  return 10_000 + level.level
}

export interface DoubaoModelInfo {
  /**
   * Catalog id, and the exact `model_item_key` to put on the wire. These are the
   * same string on purpose: DSH keys every join on the model id, so keeping them
   * identical removes a translation layer that could only be wrong.
   */
  id: string
  /** UI name, verbatim from the desktop app's picker. */
  name: string
  /**
   * Status badge shown next to the name, exactly as the app renders it.
   * `undefined` when the app shows no badge.
   *
   * Note 「即将下线」 is NOT a property of the Turbo model: the app publishes
   * TWO Turbo entries and only the retiring one carries it.
   */
  badge?: string
  /** Every model in the current catalog offers the reasoning-effort picker. */
  reasoning: true
}

/**
 * The two entries DSH may offer.
 *
 * WHY ONLY TWO. Doubao groups models by MODE, and the model list is per-mode:
 *
 *   对话       → 豆包 快速 (0), 豆包 2.1 Turbo·专家 (3)
 *   工作任务   → 自动 (9), 2.1 Lite (seed-lite-7b), 2.1 Pro (5), Turbo (3)
 *
 * The 「工作任务」 group is not offered here because its requests are executed by
 * the desktop client's own CUA runtime (`tasks-mode-resource` + `sbox`), which an
 * external client cannot register; every such turn fails `710010702`. See the
 * README's known limitations.
 *
 * MEASURED, 2026-10-22: `model_item_key` is forwarded verbatim (the server stores
 * it on the message), but in 对话 mode it does NOT change what answers —
 * 0 / 3 / 5 / seed-lite-7b AND a deliberately bogus key all returned answers of
 * indistinguishable length and latency (12.3–14.0 s). So this list is honest
 * about what the PICKER can offer; it does not claim per-key routing.
 *
 * 「豆包 快速」 leads because it is the app's own chat-mode default, so an
 * unconfigured install reproduces the app rather than something that merely
 * happens to work.
 */
export const DOUBAO_MODELS: readonly DoubaoModelInfo[] = [
  { id: '0', name: '豆包 快速', reasoning: true },
  { id: '3', name: '豆包 2.1 Turbo', badge: '专家', reasoning: true },
]

/**
 * Entries that exist in the desktop app but are deliberately NOT offered here.
 *
 * Kept as data rather than a comment so the README and any future UI can state
 * the reason from one place — and so re-adding one is a deliberate act that has
 * to confront this note.
 */
export const DOUBAO_UNAVAILABLE_MODELS: readonly { id: string; name: string; reason: string }[] = [
  { id: '5', name: '豆包 2.1 Pro', reason: '「工作任务」专属：执行侧是客户端内的 CUA 运行时，外部客户端注册不进去' },
  { id: 'seed-lite-7b', name: '豆包 2.1 Lite', reason: '同上（工作任务专属）' },
  { id: '9', name: '自动', reason: '同上（工作任务专属）' },
  { id: '4', name: '豆包 2.1 Turbo（即将下线）', reason: '客户端已用「即将下线」标注，不引导用户选择' },
]

/**
 * The model used when a request names none.
 *
 * 「豆包 快速」 is the app's own chat-mode default — `menuConfV2`'s
 * `default_select_mode_map.chat` points at it — so leaving it unnamed here
 * reproduces what the desktop app would have done. Spelled out rather than
 * taken from `DOUBAO_MODELS[0]`, so reordering the list cannot silently change
 * which model an unconfigured session gets.
 */
export const DOUBAO_DEFAULT_MODEL_ID = '0'

/**
 * Catalog entry for a model id, falling back to {@link DOUBAO_DEFAULT_MODEL_ID}.
 *
 * An id the catalog does not know resolves to the default rather than throwing:
 * a stale id in a saved session should degrade to a working model, not break
 * the request. `describeRequestedModel` in the shim is what surfaces the miss.
 */
export function findDoubaoModel(id: string | undefined): DoubaoModelInfo {
  return DOUBAO_MODELS.find((model) => model.id === id)
    ?? DOUBAO_MODELS.find((model) => model.id === DOUBAO_DEFAULT_MODEL_ID)!
}

/** Entries as pi-ai-shaped descriptors, for model discovery. */
export interface DiscoveredDoubaoModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  inputModalities: ('text' | 'image')[]
  reasoning: boolean
}

export function discoverDoubaoModels(): DiscoveredDoubaoModel[] {
  return DOUBAO_MODELS.map((model) => ({
    id: model.id,
    name: model.badge === undefined ? model.name : `${model.name} · ${model.badge}`,
    contextWindow: DOUBAO_CONTEXT_WINDOW,
    maxTokens: DOUBAO_MAX_TOKENS,
    // Text-only: this route sends one Doubao text_block and never forwards
    // image parts, so advertising otherwise would be a lie the picker honours.
    inputModalities: ['text'],
    reasoning: model.reasoning,
  }))
}

/**
 * Narrow the catalog to the ids the user has ticked.
 *
 * Selecting an entry now genuinely selects a model, so this is a real
 * restriction — but it still only decides WHICH ENTRIES APPEAR IN DSH's MODEL
 * PICKER; the per-request choice is made by the DSH session, not here.
 *
 * `undefined` (never configured) serves the whole catalog: a first-run install
 * must show its models. Ids that no longer exist are dropped.
 */
export function enabledModelsOf(enabledIds: string[] | undefined): DoubaoModelInfo[] {
  if (enabledIds === undefined || enabledIds.length === 0) return [...DOUBAO_MODELS]
  const wanted = new Set(enabledIds)
  return DOUBAO_MODELS.filter(model => wanted.has(model.id))
}

/** One catalog entry as the card's checklist consumes it. */
export interface DoubaoCatalogEntry {
  /** The real `model_item_key`. */
  id: string
  name: string
  /** Status badge, or null when the app shows none. */
  badge: string | null
  /** Reasoning-effort levels this model offers. */
  reasoningLevels: Array<{ id: string; name: string; level: number; verified: boolean }>
}

export function doubaoCatalogEntries(): DoubaoCatalogEntry[] {
  return DOUBAO_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    badge: model.badge ?? null,
    reasoningLevels: DOUBAO_REASONING_LEVELS.map((level) => ({
      id: level.id,
      name: level.name,
      level: level.level,
      verified: level.verified,
    })),
  }))
}