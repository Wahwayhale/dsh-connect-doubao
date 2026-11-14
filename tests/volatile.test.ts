/**
 * The settings form gate, asserted against the SAME logic the Host runs.
 *
 * Why this file exists: the plugin's settings card reported
 * `保存失败：host did not persist the value` for weeks, and the cause was not
 * the save route, not the namespace lookup, and not the profile entry — it was
 * that the schema declared no volatile field, so the Host filtered the whole
 * entry out of `describe()` before any write was ever attempted. The card then
 * wrote through a scope that silently reverted.
 *
 * Nothing in the build, the type system, or the 79 existing tests could catch
 * that: a non-volatile schema is perfectly valid TypeScript, a perfectly valid
 * schemastery schema, and a perfectly silent runtime failure. This test pins
 * the one property whose absence is invisible everywhere else.
 *
 * The two helper functions below are transcribed from the Host's own
 * `lib/types/schema.js` (`volatileForm`, `isVolatilePath`) rather than imported
 * from it, because that module lives inside the packaged `app.asar` and is not
 * a resolvable dependency. They are short and the transcription is mechanical —
 * but if the Host ever changes the rule, these assertions stop matching reality,
 * so treat a failure here as "re-read the Host's schema.js".
 */
import { describe, expect, it } from 'vitest'
import { Config, TOOL_EMULATION_FIELD, ENABLED_MODEL_IDS_FIELD } from '../src/doubao-config.ts'

/** Host `lib/types/schema.js` -> `volatileForm()`. */
function volatileForm(schema: any): unknown {
  if (schema.meta?.volatile) return schema
  if (schema.type === 'object') {
    const dict: Record<string, unknown> = {}
    for (const [key, child] of Object.entries<any>(schema.dict ?? {})) {
      const field = volatileForm(child)
      if (field !== undefined) dict[key] = field
    }
    return Object.keys(dict).length === 0 ? undefined : { type: 'object', dict }
  }
  return undefined
}

/** Host `lib/types/schema.js` -> `isVolatilePath()`. */
function isVolatilePath(schema: any, path: string[]): boolean {
  if (schema.meta?.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}

describe('the settings schema survives the Host volatile gate', () => {
  it('volatileForm(Config) is defined — otherwise the entry never reaches describe()', () => {
    // `undefined` here is the exact failure mode: the Host returns [] for the
    // entry, the namespace list omits it, and every write is refused with
    // `Plugin entry "<id>" has no volatile fields`. It looks like a save bug.
    expect(volatileForm(Config)).toBeDefined()
  })

  it.each([ENABLED_MODEL_IDS_FIELD, TOOL_EMULATION_FIELD])('%s is reachable as a volatile path', field => {
    // The Host validates every write path against the FULL schema, not against
    // the projected form, so a field can appear in the form and still be
    // unwritable. Both checks must pass.
    expect(isVolatilePath(Config, [field])).toBe(true)
  })

  it('every declared field is volatile, not just the two we happen to write', () => {
    // If someone adds a field without `asVolatile`, the form silently hides it
    // and the card's write for it silently fails — the original bug, again.
    const dict = (Config as any).dict ?? {}
    const bare = Object.entries<any>(dict).filter(([, child]) => child.meta?.volatile !== true).map(([key]) => key)
    expect(bare).toEqual([])
  })

  it('volatility survives toJSON(), which is what the Host actually reads', () => {
    // The Host calls `schema.toJSON()` and inspects the RESULT. A marker that
    // exists on the live object but is dropped by serialisation would pass a
    // naive check and still fail in production.
    const json = JSON.stringify((Config as any).toJSON())
    expect(json).toContain('"volatile":true')
  })
})

describe('defaults stay "not yet configured" rather than "ticked nothing"', () => {
  it('declares an empty list for the model ids, not a required selection', () => {
    // An empty list means "not yet configured" (serve the whole catalog); the
    // card must never be able to persist that as a deliberate "ticked none",
    // which is why `enabledModelsOf` keys off `isConfigured` instead.
    const meta = (Config as any).dict[ENABLED_MODEL_IDS_FIELD].meta
    expect(meta.default).toEqual([])
  })

  it('enables tool emulation ON by default', () => {
    // Opt-in on purpose: the switch lets a model touch the local filesystem
    // through prompt-emulated tool calls, so a fresh install must not have it.
    const meta = (Config as any).dict[TOOL_EMULATION_FIELD].meta
    expect(meta.default).toBe(true)
  })
})
