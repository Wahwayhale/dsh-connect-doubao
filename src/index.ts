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
import { registerDoubaoQuotaRoute, registerDoubaoCatalogRoute, registerDoubaoSaveRoute, registerDoubaoAuthRoute } from './doubao-status.ts'
import { setProfileOverride } from './doubao-profile.ts'
import type { WebServerLike } from './doubao-status.ts'
import {
  DOUBAO_CONTEXT_WINDOW,
  DOUBAO_MAX_TOKENS,
  DOUBAO_MODELS,
  DOUBAO_PROVIDER,
  DOUBAO_PROVIDER_DISPLAY_NAME,
  discoverDoubaoModels,
  enabledModelsOf,
} from './doubao-catalog.ts'
import { ENABLED_MODEL_IDS_FIELD, effectiveIds, profileDirOf, toolEmulationOf } from './doubao-config.ts'
import { writeStoredSetting, readStoredSettings, withStoredSettings } from './doubao-store.ts'
import { liveModels, invalidateDiscovery, discoverAllCachedModels } from './doubao-discovery.ts'
import type { DoubaoSettings } from './doubao-config.ts'

export const PLUGIN_ID = 'dsh-connect-doubao'
export const PLUGIN_NAME = 'DSH Connect Doubao'

/**
 * Diagnostic trail for the settings-presentation registration.
 *
 * `settings.configure()` is what makes this plugin a settings namespace, and it
 * can fail in four completely different places without raising: the inject
 * child never runs (no `settings` service), `ctx.effect` never runs, the call
 * itself throws, or it succeeds and the host still does not list us. Those look
 * identical from the outside — a missing namespace — so each step records
 * whether it was reached and the save route reports the trail.
 */
export const presentationDiag: {
  injectRan?: boolean
  hasSettings?: boolean
  hasFiber?: boolean
  effectRan?: boolean
  configureRan?: boolean
  error?: string
  /** Entry ids the host's config editor actually holds, as seen from the settings service. */
  editorEntries?: string[]
  /** Why enumerating them failed, when it did. */
  editorError?: string
  /** `ctx.fiber.entry.options.id` — the id `settings.mutate()` resolves against. */
  fiberEntryId?: string
  /** The namespace this plugin asks the save route to write into. */
  settingsNs?: string
} = {}
/**
 * The plugin's Cordis name — the value the Loader and the Settings service key
 * on. It must be the ENTRY ID, not a human-readable title.
 *
 * Two working siblings prove the rule: `dsh-connect-trae` and
 * `dsh-connect-workbuddy` both export `name === their entry id`, and both have
 * a namespace in `settings.describe()`. This plugin exported
 * `'DSH Connect Doubao'`, and its namespace was the ONE absent from a 28-entry
 * `describe()` list even though it calls `settings.configure()` exactly like
 * they do. A display title is not an identifier; the settings row never existed
 * because nothing registered under that name.
 */
export const name = PLUGIN_ID

export * from './doubao-auth.ts'
export * from './doubao-upstream.ts'
export * from './doubao-quota.ts'
export * from './doubao-catalog.ts'
export * from './doubao-config.ts'
export {
  liveModels,
  invalidateDiscovery,
  discoverModels,
  discoverAllCachedModels,
  DISCOVERY_TTL_MS,
} from './doubao-discovery.ts'
export { createDoubaoAdapter, DOUBAO_STREAM_IDLE_TIMEOUT_MS } from './doubao-adapter.ts'
export { createDoubaoShim, type DoubaoShim } from './doubao-shim.ts'
export {
  doubaoQuotaView,
  registerDoubaoQuotaRoute,
  registerDoubaoCatalogRoute,
  registerDoubaoSaveRoute,
  registerDoubaoAuthRoute,
  DOUBAO_QUOTA_PATH,
  DOUBAO_CATALOG_PATH,
  DOUBAO_SAVE_PATH,
  DOUBAO_AUTH_PATH,
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
 * A bare `apply` export (not a `plugin = { ... }` object): the Loader reads
 * `name` / `inject` / `Config` / `apply` as named exports of the entry module.
 * `name` is exported above, next to PLUGIN_ID, which is what it must equal.
 */

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
export function apply(ctx: DoubaoPluginContext, config: DoubaoSettings = { enabledModelIds: [], toolEmulation: false, profileDir: '' }): void {
  let shim: ReturnType<typeof createDoubaoShim> | undefined
  let adapterRelease: (() => void) | undefined
  let directoryRelease: (() => void) | undefined
  let discoveryRelease: (() => void) | undefined

  // The namespace the host serves, resolved once from the Loader entry.
  const settingsNs = settingsNamespaceOf(ctx)
  /**
   * Live config, replaced on every settings write.
   *
   * Seeded from the plugin's OWN file, which wins over the Loader config: on
   * this host line the fiber never reaches ACTIVE, so the Loader can neither
   * expose nor accept a settings write for this plugin (`No configurable plugin
   * entry "dsh-connect-doubao"`, measured 2026-11-02). The file is the only
   * place a save can land, which is why it takes precedence — trusting the
   * Loader value would resurrect the silent-revert bug for any user who ever
   * saved a switch.
   */
  let current: DoubaoSettings = withStoredSettings(config)

  // Point credential discovery at the user's choice before ANY caller runs.
  // `apply` is the only place that sees the stored settings this early, and the
  // shim/quota/adapter all reach for credentials through the module-level
  // resolver — so the override has to be installed here, not lazily.
  setProfileOverride(profileDirOf(current))

  try {
    shim = createDoubaoShim({
      // Read live so a settings change takes effect without a host restart.
      toolEmulation: () => toolEmulationOf(current),
    })
    const { adapter, invalidate, setEnabledModelIds } = createDoubaoAdapter({
      shim,
      enabledModelIds: effectiveIds(config),
      modelsProvider: liveModels,
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

    // Model discovery publishes the catalog, filtered by the user's ticked
    // entries. The list itself comes from the CLIENT'S OWN CACHE (see
    // doubao-discovery.ts), so a model Doubao ships appears here without a
    // plugin release; the static catalog is only the fallback.
    //
    // The checklist decides which entries exist in DSH's model picker. Routing
    // is a separate axis: the picked entry travels as `model_item_key`, and
    // `input_skill` (生图) is a third axis on top of that.
    try {
      discoveryRelease = ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
        if (request.provider !== undefined && request.provider !== DOUBAO_PROVIDER) return []
        return enabledModelsOf(effectiveIds(current), liveModels()).map(model => ({
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

    /**
     * Settings presentation, via a NESTED `ctx.inject(['settings'], ...)`.
     *
     * This used to be a soft `ctx.get('settings')` probe at apply time, and that
     * is why this plugin's settings row never existed: `apply` can run BEFORE
     * the settings service is mounted, so the probe returned `undefined` and
     * `configure()` was simply never called — no error, no retry, and the
     * namespace stayed absent from `settings.describe()` while
     * `dsh-connect-trae` and `dsh-connect-workbuddy` were both listed.
     *
     * Both working siblings use an inject child for exactly this reason: the
     * child is held back until the service exists, and re-runs if it is replaced.
     * The soft probe stays only as the fallback for hosts that never provide
     * `settings` at all (that is also why `settings` is not in the top-level
     * `inject`, which would stop `apply` from running entirely).
     */
    const presentationOwner = (ctx as unknown as { fiber?: unknown }).fiber
    try {
      if (typeof ctx.inject === 'function') {
        // `configEditor` is injected alongside `settings` on purpose. Without it
        // Cordis refuses even to READ `settingsCtx.configEditor`
        // ("cannot get property \"configEditor\" without inject"), which is why the
        // first version of this probe could not tell "entry absent" apart from
        // "entry present but schemaless".
        // `configEditor` is deliberately NOT in this array. It brings its own
        // dependency on `profileContext`, and a child that demands a service the
        // host does not provide never activates — which would take the card with
        // it. The probe below asks for it separately, so a failure there costs
        // only the diagnostic.
        ctx.inject(['settings'], (settingsCtx: never) => {
          const child = settingsCtx as unknown as {
            settings?: { configure(presentation: { auto?: boolean }, owner?: unknown): () => void }
            effect?: (fn: () => unknown) => unknown
          }
          presentationDiag.injectRan = true
          presentationDiag.hasSettings = child.settings !== undefined
          presentationDiag.hasFiber = presentationOwner !== undefined
          // The id the host keys settings on. `mutate` looks entries up by
          // `options.id`, so recording it lets the probe compare the two directly
          // instead of inferring it from an error message.
          presentationDiag.fiberEntryId = String(
            (presentationOwner as { entry?: { options?: { id?: unknown } } } | undefined)?.entry?.options?.id,
          )
          presentationDiag.settingsNs = settingsNs
          const settings = child.settings
          if (settings === undefined || typeof settings.configure !== 'function') return
          // The working reference (`@opencode2dsh/dsh-plugin`) claims the page with
          // `configure({ auto: false }, ...)` registered on the CHILD effect, not the
          // outer one — `auto: true` asks the host to synthesise a form from the
          // schema, which is not what a plugin that ships its own card wants.
          const claim = (): unknown => {
            presentationDiag.effectRan = true
            const dispose = settings.configure({ auto: false }, presentationOwner)
            presentationDiag.configureRan = true
            return dispose
          }
          if (typeof child.effect === 'function') child.effect.call(settingsCtx, claim)
          else claim()
        })
        // Diagnostic-only sibling. `ConfigEditor.entries()` keeps a Loader entry
        // only when its parent is an `include` AND its id is unique across the
        // profile, so for the save route "not in configEditor" and "not unique"
        // are the same symptom. Asking here costs one extra service and cannot
        // stop the card from working if it is unavailable.
        ctx.inject(['configEditor'], (editorCtx: never) => {
          try {
            const editor = editorCtx as unknown as {
              configEditor?: {
                entries?: () => Array<{
                  options?: { id?: unknown }
                  parent?: { tree?: { ctx?: { fiber?: { entry?: { id?: unknown } } } } }
                  fiber?: { state?: unknown; runtime?: { Config?: unknown } }
                }>
              }
            }
            const rows = typeof editor.configEditor?.entries === 'function' ? editor.configEditor.entries() : undefined
            if (rows === undefined) {
              presentationDiag.editorError = 'configEditor present but no entries()'
              return
            }
            presentationDiag.editorEntries = rows.map(row => {
              const runtime = row.fiber?.runtime as { Config?: unknown } | null | undefined
              const config = runtime?.Config as { toJSON?: unknown } | undefined
              const ours = String(row.options?.id) === PLUGIN_ID ? ':ours' : ''
              return `${String(row.options?.id)}@${String(row.fiber?.state)}${config === undefined ? ':noschema' : ':schema'}${ours}`
            })
          } catch (error: unknown) {
            presentationDiag.editorError = (error as Error)?.message ?? String(error)
          }
        })
      }
    } catch (error: unknown) {
      presentationDiag.error = (error as Error)?.message ?? String(error)
      ctx.logger.error('dsh-connect-doubao: settings presentation registration failed', error)
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
        const disposeCatalog = registerDoubaoCatalogRoute(webCtx, { modelsProvider: liveModels })
        const disposeSave = registerDoubaoSaveRoute(
          {
            webServer: (webCtx as unknown as { webServer: WebServerLike }).webServer,
          },
          {
            // The write goes to the plugin's OWN file. The host settings path is
            // unusable for this plugin (fiber stuck at LOADING => no
            // `runtime.Config` => `No configurable plugin entry`), so the file
            // is the only place a save can land — see ./doubao-store.ts.
            write: (field: string, value: unknown) => { writeStoredSetting(field, value) },
            read: () => readStoredSettings(),
            diagnostics: () => ({ ...presentationDiag, pluginName: name }),
            // Keep the live switch in sync with a write made through this route:
            // the host's own change event is not guaranteed on every line, and a
            // save that only lands on disk would otherwise take effect at restart.
            onApplied: (field: string, value: unknown) => {
              const next: DoubaoSettings = { ...current }
              if (field === 'enabledModelIds' && Array.isArray(value)) {
                next.enabledModelIds = value.filter((id): id is string => typeof id === 'string')
              } else if (field === 'toolEmulation' && typeof value === 'boolean') {
                next.toolEmulation = value
              }
              onSettingsChanged(next)
            },
          },
        )
        const disposeAuth = registerDoubaoAuthRoute(webCtx)
        ctx.effect(() => () => {
          disposeQuota()
          disposeCatalog()
          disposeSave()
          disposeAuth()
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