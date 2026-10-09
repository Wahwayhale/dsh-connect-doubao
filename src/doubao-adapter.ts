/**
 * The Doubao pi-ai provider, registered into the Harness LLM seam.
 *
 * Assembly follows the public `dsh-llm-pi-ai` extension points, as used by
 * `dsh-connect-workbuddy`:
 *
 *   createProvider(...)  ->  a pi-ai Provider whose models all point at the
 *                           loopback shim's OpenAI-shaped surface
 *   PiAiAdapter          ->  the Harness-facing adapter built from a resolved
 *                           provider profile
 *
 * The shim (not this file) owns the Doubao dialect and all inbound hardening;
 * this module only decides what the picker shows and how failures are labelled.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
 *   — pi-ai provider 的装配方式（createProvider + openAICompletionsApi +
 *     inert auth plane + 用 shim 的进程内 secret 作为 apiKey）由该项目实现。
 *
 * @module dsh-connect-doubao/adapter
 */
import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { DoubaoShim } from './doubao-shim.ts'
import {
  DOUBAO_CONTEXT_WINDOW,
  DOUBAO_MAX_TOKENS,
  DOUBAO_MODELS,
  DOUBAO_PROVIDER,
  DOUBAO_PROVIDER_DISPLAY_NAME,
  enabledModelsOf,
  type DoubaoModelInfo,
} from './doubao-catalog.ts'

/** Provider idle ceiling while one stream read is outstanding. */
export const DOUBAO_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Inert pi-ai auth plane.
 *
 * The Doubao route authenticates only through the shim's per-process shared
 * secret (resolved as the OpenAI apiKey) plus the cookie jar the shim reads
 * from the local profile. pi-ai's own credential lifecycle and ambient
 * discovery must never manufacture a credential here.
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-connect-doubao: the doubao route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** Image-request budgets: this route is text-only, so the caps are inert. */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 0,
  requestImagePixelBudget: 0,
  requestImageMaxBytes: 0,
} as const

/**
 * Thinking level map for an entry.
 *
 * The map is a TRANSLATION, not a passthrough: pi-ai spells levels OpenAI's way
 * (`minimal`, `low`, `medium`, `high`) while Doubao publishes only 低 / 中 / 高.
 * Doubao's own ids are sent as the values so the shim can hand them straight to
 * `streamChat` without a second lookup — see `toDoubaoLevel` in the shim.
 *
 * Doubao has no "off": the weakest published level is 低, so `off` maps to it
 * rather than to nothing. A model that declares no reasoning pins every level,
 * so the picker cannot request thinking from a route that will not honour it.
 */
function thinkingLevelMap(info: DoubaoModelInfo): Record<string, string | null> {
  const levels = ['minimal', 'low', 'medium', 'high'] as const
  if (!info.reasoning) {
    return Object.fromEntries([...levels, 'off'].map((level) => [level, null]))
  }
  return {
    minimal: 'low',
    low: 'low',
    medium: 'mid',
    high: 'high',
    off: 'low',
  }
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: DoubaoModelInfo, baseUrl: string, providerId: string): Model<Api> {
  const levels = thinkingLevelMap(info)
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: ['text'],
    cost: NO_COST,
    contextWindow: DOUBAO_CONTEXT_WINDOW,
    maxTokens: DOUBAO_MAX_TOKENS,
    reasoning: info.reasoning,
    thinkingLevelMap: levels,
    compat: { supportsReasoningEffort: info.reasoning },
  } as unknown as Model<Api>
}

export interface DoubaoAdapter {
  adapter: PiAiAdapter
  /** Rebuild the adapter's provider snapshot; call after a catalog change. */
  invalidate: () => void
  /**
   * Replace the ticked catalog ids and rebuild the snapshot.
   *
   * This is the ONLY effect the card's checklist has: it decides which entries
   * exist in DSH's model picker. Which one is actually used is the session's
   * choice, sent per request as `model_item_key`.
   *
   * `undefined` means "never configured" and serves the whole catalog; `[]`
   * serves nothing, which is a legitimate user choice.
   */
  setEnabledModelIds(ids: string[] | undefined): void
}

export interface DoubaoAdapterOptions {
  shim: DoubaoShim
  /** Initial ticked ids, or undefined for "never configured". */
  enabledModelIds?: string[] | undefined
}

/**
 * Assemble the adapter.
 *
 * Every model's `baseUrl` is re-resolved per read so the shim's ephemeral port
 * applies from the first snapshot after startup.
 */
export function createDoubaoAdapter(options: DoubaoAdapterOptions): DoubaoAdapter {
  const { shim } = options
  const providerId = DOUBAO_PROVIDER
  const providerName = DOUBAO_PROVIDER_DISPLAY_NAME

  /**
   * Which catalog ids are currently in force, or undefined for "never
   * configured" (serve everything). Updated by {@link setEnabledModelIds} when
   * the user saves a different checklist selection.
   */
  let enabledIds: string[] | undefined = options.enabledModelIds

  // pi-ai's `getModels` is synchronous and the shim's port binds asynchronously,
  // so the adapter warms the port once up front and reads the settled value.
  // `invalidate()` re-reads it; a failed bind leaves the catalog empty rather
  // than publishing a model pointed at `undefined`.
  let syncBaseUrl: string | undefined = shim.baseUrlSync()
  if (syncBaseUrl === undefined) {
    void shim.baseUrl().then((resolved) => { syncBaseUrl = resolved }).catch(() => {})
  }

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL, so
    // the shim's routes line up with the `/v1` prefix in place. Until the port
    // is bound there is nothing to publish; an empty snapshot is legal and the
    // next read (once `invalidate()` runs) fills it in.
    const address = syncBaseUrl
    if (address === undefined) return []
    const baseUrl = `${address}/v1`
    // Filtered by the checklist selection: this is the one and only thing the
    // card's ticks control — which entries exist in DSH's model picker. The
    // per-request choice among them is sent as `model_item_key`.
    return enabledModelsOf(enabledIds).map(info => toPiModel(info, baseUrl, providerId))
  }

  const base = createProvider({
    id: providerId,
    name: providerName,
    auth: {
      apiKey: {
        name: 'Doubao loopback shim secret',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'Doubao' }
        },
      },
    },
    models: buildModels(),
    // The OpenAI-completions shape is already the shim's contract; the shim
    // forwards the requested model to Doubao as `model_item_key`.
    api: openAICompletionsApi() as ProviderStreams,
  })

  // `getModels` is delegated to a live read so stream dispatch still runs
  // through the constructed provider while the catalog answer can be rebuilt.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName: providerName,
    streamIdleTimeoutMs: DOUBAO_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-doubao retryPolicy'),
    configuredMaxTokens: new Map(),
    // The catalog is static, so no model is known-bad up front. The route must
    // not pre-condemn a model that the shim would serve fine.
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    // TYPE ESCAPE, deliberately narrow and documented.
    //
    // `dsh-llm-pi-ai` declares `piProvider` with the pi-ai types from ITS OWN
    // dependency tree, while this module imports pi-ai directly. npm can
    // therefore install two different copies (the dev pin is `^0.85.1`, the host
    // runs 0.87.1) and TypeScript then refuses to relate the two `Provider`
    // types — even though at RUNTIME both are the same package and the host
    // supplies exactly one. The two copies even declare a private field of the
    // same name, so nothing but the package identity makes them distinct.
    //
    // The difference is confined to API surface this plugin never uses: the only
    // API it builds is `openAICompletionsApi()`. Casting through `unknown` at
    // this single boundary therefore discards a difference that cannot occur on
    // this code path, rather than papering over a real one.
    //
    // This is a DEVELOPMENT-TREE artifact only. The published bundle keeps pi-ai
    // external (see tsdown.config.ts `neverBundle`), so the host's single copy is
    // what actually loads.
    piProvider: provider as unknown as NonNullable<ResolvedPiAiProviderProfile['piProvider']>,
  }

  // Replacing (not mutating) the map forces the next profiles read to rebuild.
  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // The shim's per-process shared secret becomes the OpenAI apiKey, which
    // pi-ai sends as `Authorization: Bearer`. The shim validates it and never
    // forwards it upstream.
    resolveApiKey: async () => shim.token(),
  })

  return {
    adapter,
    invalidate: () => {
      // Re-read the port in case the warm-up above has not settled yet.
      syncBaseUrl ??= shim.baseUrlSync()
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
    setEnabledModelIds: (ids) => {
      enabledIds = ids
      syncBaseUrl ??= shim.baseUrlSync()
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
  }
}