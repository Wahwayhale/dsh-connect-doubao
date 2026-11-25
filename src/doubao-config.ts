/**
 * Persisted settings for the Doubao plugin.
 *
 * ONE field on purpose. Doubao takes no credentials, no region, no pool and no
 * multipliers — the only thing a user can meaningfully configure is which catalog
 * entries appear in DSH's model picker.
 *
 * IMPORTANT: the schema lives in its own module so the browser half can mirror
 * the field name without importing anything Node-side. The Loader reads `Config`
 * from the plugin entry, which re-exports this.
 *
 * @module dsh-connect-doubao/config
 */
import z from '@deepseek-ai/schemastery'

/** The single settings field. Mirrored by the card as `enabledModelIds`. */
export const ENABLED_MODEL_IDS_FIELD = 'enabledModelIds'

/**
 * Shape of the config the HOST hands to `apply`, i.e. what `Config` validates.
 *
 * Every field is required here: schemastery's `.default()` marks a field
 * `"defined"`, so the Loader always supplies a value. `enabledModelIds` is a
 * plain array at this layer — the schema's `[]` placeholder for "never saved"
 * is not distinguishable from a saved empty list until the plugin's own
 * settings file is consulted, which {@link DoubaoSettings} accounts for.
 */
export interface DoubaoConfig {
  enabledModelIds: string[]
  toolEmulation: boolean
  profileDir: string
}

/**
 * Shape of this plugin's LIVE settings, after {@link withStoredSettings} has
 * merged the Host config with the plugin's own settings file.
 */
export interface DoubaoSettings extends Omit<DoubaoConfig, 'enabledModelIds'> {
  /**
   * Catalog ids the user has ticked, or `undefined` when never saved.
   *
   * THREE states, all meaningful:
   *
   *   `undefined` — the user has never saved a selection. The whole catalog is
   *                 served, so a first-run install shows its models.
   *   `[]`        — the user saved an EMPTY selection. Nothing is served; this
   *                 is a real choice and must not be read as "not configured".
   *   `[a, b]`    — serve exactly these ids.
   *
   * The distinction is carried by {@link withStoredSettings}, not by the
   * schema: `Config` declares `z.array(z.string()).default([])`, so the Host
   * always hands `apply` an empty array for a user who never saved. That empty
   * value is the schema's placeholder and is folded to `undefined` while
   * merging the plugin's own settings file — a saved `[]` in that file survives
   * as `[]`. Collapsing the two would silently re-publish every entry for a
   * user who had deliberately ticked none.
   */
  enabledModelIds: string[] | undefined
  /**
   * Simulate tool calling in the prompt so Doubao can drive the Harness tools.
   *
   * ON by default: Doubao ignores an OpenAI `tools` array, so the plugin carries
   * this request's DSH-declared tools in the prompt and converts a matching
   * response back to `tool_calls`. The DSH host still enforces its current-session
   * tool permissions and performs the actual workspace operation; this plugin
   * never writes files itself. The selected DSH tool list is the parser allow-list.
   *
   * Work-task models use a separate upstream local runtime and cannot safely
   * execute DSH tools through this path; requests combining them are rejected.
   * The switch can be disabled at any time.
   */
  toolEmulation: boolean
  /**
   * Absolute path to the Doubao profile, or `''` for "detect it yourself".
   *
   * Only needed when the app keeps `User Data` somewhere the four automatic
   * strategies cannot reach — an external drive that is not mounted at scan
   * time, a redirected folder, or a copy the user moved by hand. The card
   * offers a picker for it; the value is validated host-side (it must contain
   * `Default\Network\Cookies`) before it is stored.
   */
  profileDir: string
}

/** The settings field holding the tool-emulation switch. */
export const TOOL_EMULATION_FIELD = 'toolEmulation'

/** The settings field holding a manually chosen profile directory. */
export const PROFILE_DIR_FIELD = 'profileDir'

/** Read the chosen profile directory, or `undefined` when it is not set. */
export function profileDirOf(config: unknown): string | undefined {
  const value = (config as { profileDir?: unknown } | undefined)?.profileDir
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Read the switch out of an arbitrary config snapshot; default true. */
export function toolEmulationOf(config: unknown): boolean {
  const value = (config as { toolEmulation?: unknown } | undefined)?.toolEmulation
  return value !== false
}

/** Whether the user has ever saved a selection (i.e. the field is not the default). */
export function isConfigured(config: unknown): boolean {
  return enabledIdsOf(config) !== undefined
}

/**
 * Mark one schema field as volatile.
 *
 * This is what makes the field WRITABLE from a settings form at all. The host
 * only surfaces volatile fields (`Forms expose only volatile fields from
 * active, uniquely addressed profile entries`), and its write gate rejects
 * everything else:
 *
 *   Plugin entry "<id>" has no volatile fields
 *
 * — which is exactly why `settings.describe()` listed 33 namespaces and this
 * plugin's was the one missing: the namespace is derived from the marker, not
 * from the Loader entry. The comparison plugin states the failure verbatim:
 * "the scope's `set()` still resolves — so the card would look like it saved
 * and silently revert", which is precisely the symptom that started this hunt.
 *
 * `volatile()` ships in schemastery 3.18.3+ and the peer range requires
 * >=3.18.4, so the function probe is a safety net rather than the normal path;
 * it degrades to the bare schema on an older resolution instead of throwing.
 */
function asVolatile<T>(schema: T): T {
  const candidate = schema as unknown as { volatile?: () => T }
  return typeof candidate.volatile === 'function' ? candidate.volatile() : schema
}

/**
 * The settings SCHEMA the Loader reads.
 *
 * It MUST be a real schemastery schema: Cordis calls `.validate()` on it while
 * resolving the entry's config, so a plain object literal throws
 * `TypeError: Cannot read properties of undefined (reading 'validate')` and the
 * Loader reports `1 entry did not activate` — the plugin then contributes
 * nothing at all (no provider, no routes), with only that one warning to show
 * for it. Verified against a real DSH 0.2.0-rc.2 host (M5-B).
 *
 * schemastery is a peer dependency resolved from the Harness at runtime and is
 * never bundled (see tsdown.config.ts).
 */
export const Config: z<DoubaoConfig> = z.object({
  enabledModelIds: asVolatile(z.array(z.string()).default([]))
    .description('Catalog ids enabled in the DSH model picker. Doubao routes upstream by content, so this selects which entries are offered, never which model answers. Leave untouched to serve the whole catalog; an explicitly emptied list serves none.'),
  toolEmulation: asVolatile(z.boolean().default(true))
    .description('使用提示词模拟工具调用（OpenAI tools → doubao-tool 围栏 → tool_calls），让豆包及客户端接入的第三方模型能驱动 Harness 的本地工具。默认开启。'),
  profileDir: asVolatile(z.string().default(''))
    .description('豆包客户端 User Data 目录。留空表示自动探测（%LOCALAPPDATA%、%APPDATA%、运行中客户端的 --user-data-dir、全盘扫描）。只有当豆包把数据放在自动探测找不到的位置时才需要填。'),
})

/**
 * The ticked ids, or `undefined` when the field is ABSENT.
 *
 * A present-but-empty array is returned as-is: it is a real (empty) selection,
 * distinct from `undefined` ("never configured"). {@link withStoredSettings}
 * is the only place that folds the schema's `[]` placeholder into `undefined`,
 * so by the time this is called on the merged settings the two are already
 * separated.
 */
export function enabledIdsOf(config: unknown): string[] | undefined {
  const value = (config as { enabledModelIds?: unknown } | undefined)?.enabledModelIds
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * The ids the adapter should filter by, or `undefined` for "serve everything".
 *
 * A pure pass-through of {@link enabledIdsOf}: `undefined` stays `undefined`
 * (never configured → whole catalog) and a saved empty list stays empty (the
 * user ticked nothing → serve nothing). An earlier version folded `[]` into
 * `undefined` to keep a first-run install from showing an empty picker, but the
 * merge in `withStoredSettings` already performs that fold exactly once, where
 * "the Host's schema default" and "the user's saved value" can still be told
 * apart. Folding again here erased a deliberate "ticked none".
 */
export function effectiveIds(config: unknown): string[] | undefined {
  return enabledIdsOf(config)
}
