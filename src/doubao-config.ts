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

/** Shape of this plugin's settings. */
export interface DoubaoSettings {
  /**
   * Catalog ids the user has ticked.
   *
   * Defaults to `[]` — which means "NOT YET CONFIGURED" rather than "ticked
   * nothing". The two are separated by {@link isConfigured}, which treats a
   * never-saved field the same as an empty one; schemastery 3.18.4 has no
   * `.optional()` and folds an `undefined` default into a NULLABLE field, which
   * would add a third state (`null`) for the card to disambiguate. The reference
   * connector uses the same default-plus-explicit-seeding approach.
   *
   * An empty list therefore serves the WHOLE catalog, so a first-run install
   * shows its models. Collapsing the two states would instead silently re-publish
   * every entry for a user who had deliberately ticked none — which is why
   * `enabledModelsOf` keys off {@link isConfigured} rather than off emptiness.
   */
  enabledModelIds: string[]
}

/** Whether the user has ever saved a selection (i.e. the field is not the default). */
export function isConfigured(config: unknown): boolean {
  return enabledIdsOf(config) !== undefined
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
export const Config: z<DoubaoSettings> = z.object({
  enabledModelIds: z.array(z.string()).default([])
    .description('Catalog ids enabled in the DSH model picker. Doubao routes upstream by content, so this selects which entries are offered, never which model answers. Empty means "not yet configured" and serves the whole catalog.'),
})

/**
 * The ticked ids, or `undefined` when the field is ABSENT.
 *
 * The absent case is what `enabledModelsOf` keys off to mean "never
 * configured"; a present-but-empty array is a real (empty) selection.
 */
export function enabledIdsOf(config: unknown): string[] | undefined {
  const value = (config as { enabledModelIds?: unknown } | undefined)?.enabledModelIds
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * The ids the adapter should filter by, or `undefined` for "serve everything".
 *
 * Normalises the schemastery default (`[]`, meaning not-yet-configured) into
 * the `undefined` that `enabledModelsOf` reads as "serve the whole catalog".
 * Without this the default would read as a user who ticked nothing, and a
 * first-run install would show an empty model picker.
 */
export function effectiveIds(config: unknown): string[] | undefined {
  const ids = enabledIdsOf(config)
  if (ids === undefined || ids.length === 0) return undefined
  return ids
}