/**
 * DSH Connect Doubao — plugin entrypoint.
 *
 * Assembles three pieces and hands them to the Harness LLM seam:
 *
 *   createDoubaoShim()         loopback HTTP surface + Doubao dialect
 *   createDoubaoAdapter()      pi-ai provider registered into ctx.llm
 *   registerDoubaoQuotaRoute   read-only quota view for the settings card
 *
 * The model catalog is STATIC and REAL: Doubao accepts an explicit
 * `model_item_key`, so selecting an entry genuinely selects that model. See
 * `doubao-catalog.ts` for the four verified keys and the reasoning-effort axis.
 *
 * 参考：dsh-connect-workbuddy 的 provider 注册链路（adapter + 可配置 provider +
 *   模型发现 + webServer 只读路由），结构参照其做法。
 *
 * @module dsh-connect-doubao
 */
import { createDoubaoAdapter } from './doubao-adapter.ts'
import { createDoubaoShim } from './doubao-shim.ts'
import { registerDoubaoQuotaRoute, registerDoubaoCatalogRoute } from './doubao-status.ts'
import {
  DOUBAO_CONTEXT_WINDOW,
  DOUBAO_MAX_TOKENS,
  DOUBAO_MODELS,
  DOUBAO_PROVIDER,
  DOUBAO_PROVIDER_DISPLAY_NAME,
  discoverDoubaoModels,
  enabledModelsOf,
} from './doubao-catalog.ts'
import { ENABLED_MODEL_IDS_FIELD, effectiveIds } from './doubao-config.ts'
import type { DoubaoSettings } from './doubao-config.ts'

export const PLUGIN_ID = 'dsh-connect-doubao'
export const PLUGIN_NAME = 'DSH Connect Doubao'

export * from './doubao-auth.ts'
export * from './doubao-upstream.ts'
export * from './doubao-quota.ts'
export * from './doubao-catalog.ts'
export * from './doubao-config.ts'
export { createDoubaoAdapter, DOUBAO_STREAM_IDLE_TIMEOUT_MS } from './doubao-adapter.ts'
export { createDoubaoShim, type DoubaoShim } from './doubao-shim.ts'
export {
  doubaoQuotaView,
  registerDoubaoQuotaRoute,
  registerDoubaoCatalogRoute,
  DOUBAO_QUOTA_PATH,
  DOUBAO_CATALOG_PATH,
} from './doubao-status.ts'
// `Config` is re-exported (not redefined) from './doubao-config.ts' above: the
// Loader needs it as a real schemastery schema on this entry module.

/**
 * Settings namespace for this provider's configurable entry.
 *
 * DEPRECATED as a name to use: the Host resolves a provider's namespace by
 * EXACT match against the Loader entry id, which a profile chooses. Use
 * {@link settingsNamespaceOf}, which reads the entry the Loader actually made.
 * Kept as a documented fallback for hosts that expose no entry id.
 */
export const DOUBAO_SETTINGS_NS = 'llm:doubao'

/**
 * Minimal structural type for the context this plugin touches.
 *
 * Declared structurally rather than imported from `@deepseek-ai/cordis` so the
 * package builds and typechecks without the peer dependency installed. At
 * runtime Cordis passes a real `Context`, which satisfies this shape.
 */
export interface DoubaoPluginContext {
  llm: {
    registerAdapter(ids: string[], adapter: unknown): () => void
    registerConfigurableProviders(entries: Array<{
      provider: string
      displayName: string
      settingsNs: string
      settingsPath: string[]
      declared: boolean
    }>): () => void
    registerModelDiscovery(
      ns: string,
      fn: (request: { provider?: string }) => Promise<Array<{
        id: string
        name: string
        contextWindow: number
        maxTokens: number
        inputModalities: ('text' | 'image')[]
      }>>,
    ): () => void
  }
  inject(names: string[], apply: (webCtx: never) => void): void
  on(name: string, listener: (config?: DoubaoSettings) => void): unknown
  effect(fn: () => (() => void) | void): void
  logger: { error(message: string, error?: unknown): void; warn?(message: string, error?: unknown): void }
  get?(name: string): unknown
}

/**
 * Stable Cordis plugin name.
 *
 * A bare `apply` export (not a `plugin = { ... }` object): the Loader reads
 * `name` / `inject` / `Config` / `apply` as named exports of the entry module.
 */
export const name = PLUGIN_NAME

/**
 * Services required before the provider may register.
 *
 * `inject: ['llm']` is REQUIRED, not decorative. Cordis only exposes a service
 * to a plugin that declared it, and touching `ctx.llm` without the declaration
 * throws `cannot get property "llm" without inject` from inside `apply()` — which
 * takes the whole plugin down silently: no provider, no quota route, and only a
 * log line to show for it. Verified against a real DSH 0.2.0-rc.2 host (M5-B).
 *
 * `webServer` is deliberately NOT listed: it mounts later, and on Desktop it may
 * never appear, so listing it would hold the entire plugin back forever. The
 * quota route waits on a NESTED `ctx.inject(['webServer'], ...)` instead.
 *
 * `settings` is a soft probe (`ctx.get`), not an inject entry: the settings
 * surface differs by host line, and Cordis' gate is hard enough that naming a
 * service this host does not provide stops `apply` from ever running.
 */
export const inject = ['llm']

/**
 * The namespace the HOST actually serves this plugin's config under.
 *
 * The Host resolves a provider's namespace by EXACT match, and the namespace it
 * serves is the Loader entry id — which a profile may mount as
 * `dsh-connect-doubao` or, as the live Desktop host does, as an include. A
 * guessed name that misses makes the config entry read as unconfigured and the
 * model's settings disappear. So ask the Loader entry, with the declared id as
 * the documented fallback.
 */
export function settingsNamespaceOf(ctx: unknown): string {
  const entry = (ctx as { fiber?: { entry?: { options?: { id?: string } } } }).fiber?.entry
  return entry?.options?.id ?? PLUGIN_ID
}

/**
 * Wire the provider and the read-only routes.
 *
 * `apply` wires every disposer into one `ctx.effect`, so unloading the plugin
 * releases the shim's port, the adapter, the directory entry, the discovery
 * callback and the HTTP routes — nothing outlives the plugin.
 */
export function apply(ctx: DoubaoPluginContext, config: DoubaoSettings = { enabledModelIds: [] }): void {
  let shim: ReturnType<typeof createDoubaoShim> | undefined
  let adapterRelease: (() => void) | undefined
  let directoryRelease: (() => void) | undefined
  let discoveryRelease: (() => void) | undefined

  // The namespace the host serves, resolved once from the Loader entry.
  const settingsNs = settingsNamespaceOf(ctx)
  /**
   * Live config, replaced on every settings write.
   *
   * Cordis re-invokes nothing here: it hands `apply` the config once, so the
   * live value is what `loader/volatile-update` refreshes. Kept as a `let` so
   * the discovery closure always reads the CURRENT selection rather than the one
   * captured at registration.
   */
  let current: DoubaoSettings = config

  try {
    shim = createDoubaoShim()
    const { adapter, invalidate, setEnabledModelIds } = createDoubaoAdapter({
      shim,
      enabledModelIds: effectiveIds(config),
    })

    // Register the adapter first: an empty INITIAL registration is invalid
    // (`INVALID_ADAPTER`), whereas releasing a landed one is always legal.
    adapterRelease = ctx.llm.registerAdapter([DOUBAO_PROVIDER], adapter)
    directoryRelease = ctx.llm.registerConfigurableProviders([
      {
        provider: DOUBAO_PROVIDER,
        displayName: DOUBAO_PROVIDER_DISPLAY_NAME,
        settingsNs,
        settingsPath: [],
        declared: false,
      },
    ])

    ctx.effect(() => () => {
      adapterRelease?.()
      directoryRelease?.()
      discoveryRelease?.()
      void shim?.close()
      shim = undefined
    })

    // The shim's port is ephemeral and resolved per model read, so the first
    // snapshot after startup already points at the live port.
    invalidate()

    // Model discovery publishes the catalog filtered by the user's ticked
    // entries. This is the ONLY thing the checklist actually controls: which
    // entries exist in DSH's model picker. It does not route anything (Doubao
    // is content-driven — see doubao-catalog.ts).
    try {
      discoveryRelease = ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
        if (request.provider !== undefined && request.provider !== DOUBAO_PROVIDER) return []
        return enabledModelsOf(effectiveIds(current)).map(model => ({
          id: model.id,
          name: model.name,
          contextWindow: DOUBAO_CONTEXT_WINDOW,
          maxTokens: DOUBAO_MAX_TOKENS,
          inputModalities: ['text' as const],
        }))
      })
    } catch (error: unknown) {
      // Discovery is optional: the provider still streams without it.
      ctx.logger.error('dsh-connect-doubao: model discovery registration failed', error)
    }

    // Soft settings probe: `settings` is NOT an inject entry (see above), so it
    // must be reached with ctx.get() — reading an undeclared property throws.
    const settings = (ctx as unknown as { get(name: string): unknown }).get('settings') as
      | {
          configure(presentation: { auto?: boolean }, owner?: unknown): () => void
          on?(name: string, listener: () => void): unknown
        }
      | undefined
    if (settings !== undefined) {
      try {
        ctx.effect(() => settings.configure({ auto: true }, (ctx as unknown as { fiber?: unknown }).fiber))
      } catch (error: unknown) {
        ctx.logger.error('dsh-connect-doubao: settings presentation failed', error)
      }
    }

    // Re-filter the picker whenever the user saves a different selection.
    // Cordis hands `apply` a fresh config on every settings write, and this
    // event is how the host announces a write it accepted elsewhere.
    const onSettingsChanged = (next?: DoubaoSettings): void => {
      // Cordis updates the config value the host re-reads; `current` tracks it
      // so the discovery closure below sees the new selection.
      if (next !== undefined) current = next
      setEnabledModelIds(effectiveIds(current))
      invalidate()
    }
    try {
      ;(ctx as unknown as { on(name: string, listener: () => void): unknown })
        .on('loader/volatile-update', onSettingsChanged)
    } catch { /* the event does not exist on this host line */ }

    // Read-only routes. `webServer` can mount after this row (and on Desktop may
    // never mount), so wait reactively instead of sampling ctx.get() once.
    ctx.inject(['webServer'], (webCtx) => {
      try {
        const disposeQuota = registerDoubaoQuotaRoute(webCtx)
        const disposeCatalog = registerDoubaoCatalogRoute(webCtx)
        ctx.effect(() => () => {
          disposeQuota()
          disposeCatalog()
        })
      } catch (error: unknown) {
        ctx.logger.error('dsh-connect-doubao: web route registration failed', error)
      }
    })
  } catch (error: unknown) {
    ctx.logger.error('dsh-connect-doubao: provider registration failed', error)
    // Release whatever landed before the throw; a half-registered provider
    // would be visible in the model picker and unroutable.
    adapterRelease?.()
    directoryRelease?.()
    discoveryRelease?.()
    void shim?.close()
    shim = undefined
  }
}

export default { name, inject, apply }