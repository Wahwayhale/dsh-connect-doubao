/**
 * Regression tests for the checklist → model picker wiring.
 *
 * `apply()` must build the adapter's INITIAL `enabledModelIds` from the SAME
 * merged settings the discovery closure reads (`current`), not from the raw
 * Loader `config`. The plugin's own settings file is the only place a save can
 * land (see `src/doubao-store.ts`), so reading `config` there normalises to
 * `undefined` — "never configured, serve everything" — and a restart showed the
 * whole catalog again even though the checklist held a saved selection
 * (measured on 0.5.0, Windows: the picker kept listing every Doubao model after
 * ticking three and restarting the host).
 *
 * `withStoredSettings` is mocked because `apply()` calls it with a fixed path
 * under `homedir()` that the test cannot redirect. The mock keeps the SAME
 * precedence the real one implements — the stored file wins over the Loader
 * config — so the assertion is about which value `apply` reads, not about the
 * merge itself (that lives in `tests/store.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { createDoubaoAdapter } from '../src/doubao-adapter.ts'
import type { DoubaoSettings } from '../src/doubao-config.ts'

/** What the (mocked) settings file currently holds. */
const stored = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))

vi.mock('../src/doubao-store.ts', () => ({
  readStoredSettings: () => stored.value,
  writeStoredSetting: vi.fn(),
  withStoredSettings: (config?: Partial<DoubaoSettings>): DoubaoSettings => ({
    enabledModelIds: stored.value.enabledModelIds ?? config?.enabledModelIds ?? [],
    toolEmulation: stored.value.toolEmulation ?? config?.toolEmulation ?? false,
    profileDir: stored.value.profileDir ?? config?.profileDir ?? '',
  }),
}))

// Never bind a real loopback port in a unit test.
vi.mock('../src/doubao-shim.ts', () => ({
  createDoubaoShim: vi.fn(() => ({
    baseUrlSync: () => 'http://127.0.0.1:9',
    baseUrl: async () => 'http://127.0.0.1:9',
    token: () => 'test-token',
    close: async () => {},
  })),
}))

// Capture what `apply` hands the adapter instead of constructing one.
vi.mock('../src/doubao-adapter.ts', () => ({
  createDoubaoAdapter: vi.fn(() => ({
    adapter: {},
    invalidate: vi.fn(),
    setEnabledModelIds: vi.fn(),
  })),
}))

/** Minimal structural context: just enough for `apply` to register against. */
function makeCtx(): Parameters<typeof apply>[0] {
  return {
    llm: {
      registerAdapter: vi.fn(() => vi.fn()),
      registerConfigurableProviders: vi.fn(() => vi.fn()),
      registerModelDiscovery: vi.fn(() => vi.fn()),
    },
    // Skip the nested inject children (settings / webServer / configEditor):
    // routes and presentation are not under test here.
    inject: vi.fn(),
    on: vi.fn(),
    effect: vi.fn(),
    logger: { error: vi.fn(), warn: vi.fn() },
  } as unknown as Parameters<typeof apply>[0]
}

/** The options the adapter was constructed with, or a failure if it never ran. */
function adapterOptions(): { enabledModelIds?: string[] | undefined } {
  expect(createDoubaoAdapter).toHaveBeenCalledTimes(1)
  return vi.mocked(createDoubaoAdapter).mock.calls[0][0]
}

const LOADER_DEFAULT: DoubaoSettings = { enabledModelIds: [], toolEmulation: false, profileDir: '' }

beforeEach(() => {
  stored.value = {}
  vi.mocked(createDoubaoAdapter).mockClear()
})

describe('apply → adapter initial enabledModelIds', () => {
  it('starts from the stored selection, not the Loader config', () => {
    stored.value = { enabledModelIds: ['0', 'seed-lite-7b'], toolEmulation: false, profileDir: '' }

    apply(makeCtx(), LOADER_DEFAULT)

    expect(adapterOptions().enabledModelIds).toEqual(['0', 'seed-lite-7b'])
  })

  it('prefers a stored selection over a disagreeing Loader config', () => {
    stored.value = { enabledModelIds: ['3'], toolEmulation: false, profileDir: '' }

    apply(makeCtx(), { ...LOADER_DEFAULT, enabledModelIds: ['0'] })

    expect(adapterOptions().enabledModelIds).toEqual(['3'])
  })

  it('still serves the whole catalog when nothing was ever saved', () => {
    apply(makeCtx(), LOADER_DEFAULT)

    expect(adapterOptions().enabledModelIds).toBeUndefined()
  })
})
