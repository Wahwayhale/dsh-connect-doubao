/**
 * The model-picker filter.
 *
 * Regression suite for the reported bug: two models ticked in the settings card,
 * yet the DSH picker listed the whole catalog. The cause was an escape hatch in
 * `enabledModelsOf` that kept any model whose id was not in the static
 * `DOUBAO_MODELS` table, on the theory that such ids were "newly discovered" and
 * should stay visible. But the catalog actually served comes from client
 * discovery, where nearly every id IS absent from that table — so the escape
 * hatch matched almost everything and the tick list filtered nothing.
 *
 * The ids below are the real ones measured from a live
 * `GET /plugins/dsh-connect-doubao/catalog` (17 entries, 11 of them `person-*`),
 * not invented shapes: a test written against synthetic ids would have kept the
 * escape hatch green.
 */
import { describe, expect, it } from 'vitest'
import { DOUBAO_MODELS, enabledModelsOf, type DoubaoModelInfo } from '../src/doubao-catalog.ts'

/** Minimal catalog entry; only `id` matters to the filter. */
function model(id: string): DoubaoModelInfo {
  return { id, name: id, reasoning: false }
}

/**
 * The discovered catalog as it really arrives: the static table's ids plus the
 * eleven `person-*` ids measured live.
 */
const PERSON_IDS = [
  'person-deepseek-v4-1-flash-261017',
  'person-deepseek-v4-pro-ga-260813',
  'person-glm-5-3-261111',
  'person-glm-5-3-flash-261111',
  'person-glm-5-4',
  'person-kimi-k3-1-pro-261111',
  'person-kimi-k3-1-pro-highspeed-261111',
  'person-kimi-k3-261111',
  'person-qwen3-8-flash',
  'person-qwen3-8-max',
  'person-qwen4-max',
] as const

const DISCOVERED: DoubaoModelInfo[] = [
  ...DOUBAO_MODELS.map(catalogModel => model(catalogModel.id)),
  ...PERSON_IDS.map(model),
]

describe('enabledModelsOf', () => {
  it('serves the whole catalog when never configured', () => {
    // A first-run install has no saved selection and must still offer models.
    expect(enabledModelsOf(undefined, DISCOVERED)).toHaveLength(DISCOVERED.length)
  })

  it('serves nothing when the user saved an empty list', () => {
    // Deliberate "ticked none" — distinct from `undefined`, and must NOT be
    // read as "not configured" (that collapse would re-publish everything).
    expect(enabledModelsOf([], DISCOVERED)).toEqual([])
  })

  it('REGRESSION: a ticked discovered id filters out the unticked ones', () => {
    // The reported case: one `person-*` id ticked. Before the fix this returned
    // all 11 `person-*` entries, because none of them appear in the static
    // table, so every one of them looked "newly discovered" and was exempt.
    const picked = enabledModelsOf(['person-deepseek-v4-1-flash-261017'], DISCOVERED)
    expect(picked.map(entry => entry.id)).toEqual(['person-deepseek-v4-1-flash-261017'])
  })

  it('REGRESSION: two ticked ids yield exactly two entries', () => {
    const picked = enabledModelsOf(['person-glm-5-4', 'person-qwen4-max'], DISCOVERED)
    expect(picked.map(entry => entry.id)).toEqual(['person-glm-5-4', 'person-qwen4-max'])
  })

  it('REGRESSION: no unticked model sneaks through, static or discovered', () => {
    // The whole point of the fix: the filter is exhaustive. Ticking one id must
    // not leave a single other entry behind, whichever table it came from.
    const picked = enabledModelsOf(['0'], DISCOVERED)
    expect(picked.map(entry => entry.id)).toEqual(['0'])
    for (const unticked of PERSON_IDS) {
      expect(picked.map(entry => entry.id)).not.toContain(unticked)
    }
  })

  it('keeps a ticked static id and a ticked discovered id side by side', () => {
    const picked = enabledModelsOf(['3', 'person-kimi-k3-261111'], DISCOVERED)
    expect(picked.map(entry => entry.id)).toEqual(['3', 'person-kimi-k3-261111'])
  })

  it('preserves catalog order, not the order of the tick list', () => {
    // The picker's order must stay the catalog's: the tick list is a set, and
    // reordering the picker on save would be a surprising side effect.
    const picked = enabledModelsOf(['person-qwen4-max', '0'], DISCOVERED)
    expect(picked.map(entry => entry.id)).toEqual(['0', 'person-qwen4-max'])
  })

  it('drops ids that no longer exist in the catalog', () => {
    // A model can vanish between releases; a stale tick must not resurrect it.
    const picked = enabledModelsOf(['person-glm-5-4', 'person-retired-000000'], DISCOVERED)
    expect(picked.map(entry => entry.id)).toEqual(['person-glm-5-4'])
  })

  it('defaults to the static table when no catalog is supplied', () => {
    expect(enabledModelsOf(undefined)).toHaveLength(DOUBAO_MODELS.length)
    expect(enabledModelsOf(['0']).map(entry => entry.id)).toEqual(['0'])
  })

  it('does not mutate the caller’s catalog array', () => {
    const before = DISCOVERED.length
    enabledModelsOf(undefined, DISCOVERED)
    enabledModelsOf(['0'], DISCOVERED)
    expect(DISCOVERED).toHaveLength(before)
  })
})
