import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stateHooks: Array<{ value: unknown; setter: (next: unknown) => void }> = []
let stateCursor = 0
let lastSetState: ((next: unknown) => void) | undefined

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useState: (initial: unknown) => {
      const idx = stateCursor++
      if (stateHooks[idx] === undefined) {
        const slot = {
          value: typeof initial === 'function' ? (initial as () => unknown)() : initial,
          setter: (next: unknown) => {
            slot.value = typeof next === 'function'
              ? (next as (prev: unknown) => unknown)(slot.value)
              : next
          },
        }
        stateHooks[idx] = slot
      }
      lastSetState = stateHooks[idx]!.setter
      return [stateHooks[idx]!.value, stateHooks[idx]!.setter]
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (initial: unknown) => ({ current: initial }),
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  }
})

vi.mock('react-dom', () => ({
  createPortal: (children: unknown) => children,
}))

import { DOUBAO_CATALOG_PATH, type DoubaoCatalogView } from '../src/client/contract.ts'
import {
  findCatalogModelEntry,
  isDoubaoProviderId,
  normalizeDoubaoModelId,
  recordObservedTriggerModel,
  refreshDoubaoCatalog,
  resetCatalogStoreForTests,
  resolveClientText,
  setDoubaoCatalogSnapshot,
} from '../src/client/DoubaoCatalogStore.ts'
import {
  DoubaoComposerRateControl,
  DoubaoModelOptionLabel,
  type ModelSelectionProjection,
} from '../src/client/DoubaoRateControls.tsx'
import { apply, en, translator, zh } from '../src/client/index.ts'

const tZh = translator(zh)
const tEn = translator(en)

const SAMPLE_CATALOG: DoubaoCatalogView = {
  ok: true,
  fetchedAt: 1_700_000_000_000,
  source: 'fixture',
  models: [
    {
      id: '5',
      name: 'Doubao Seed 2.1 Pro',
      badge: '工作任务',
      rate: { text: '0.65x', kind: 'ratio' },
      reasoningLevels: [{ id: 'low', name: '低', verified: true }],
    },
    {
      id: 'seed-lite-7b',
      name: 'Doubao Seed 2.1 Lite',
      badge: null,
      rate: { text: '限时优惠 0.01x', kind: 'promo' },
      reasoningLevels: [],
    },
    {
      id: 'doubao-image-gen',
      name: '豆包 生图',
      badge: '生图',
      rate: null,
      reasoningLevels: [],
    },
  ],
}

/** Collect all rendered text, elements, and props recursively from a React element tree. */
function inspectTree(node: unknown): {
  texts: string[]
  elements: Array<{ type: unknown; props: Record<string, unknown> }>
} {
  const texts: string[] = []
  const elements: Array<{ type: unknown; props: Record<string, unknown> }> = []
  const walk = (item: unknown): void => {
    if (item === null || item === undefined || typeof item === 'boolean') return
    if (typeof item === 'string' || typeof item === 'number') {
      texts.push(String(item))
      return
    }
    if (Array.isArray(item)) {
      for (const child of item) walk(child)
      return
    }
    if (typeof item === 'object' && 'props' in item) {
      const el = item as { type: unknown; props: Record<string, unknown> }
      if (typeof el.type === 'function') {
        const rendered = (el.type as (props: Record<string, unknown>) => unknown)(el.props)
        walk(rendered)
        return
      }
      elements.push(el)
      if ('children' in el.props) walk(el.props.children)
    }
  }
  walk(node)
  return { texts, elements }
}

function resetHookState(): void {
  stateHooks.length = 0
  stateCursor = 0
  lastSetState = undefined
}

beforeEach(() => {
  resetHookState()
  resetCatalogStoreForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetCatalogStoreForTests()
})

describe('DoubaoCatalogStore helpers', () => {
  it('normalizes doubao provider/model ids and finds catalog entries', () => {
    expect(isDoubaoProviderId('doubao')).toBe(true)
    expect(isDoubaoProviderId('Doubao-Connector')).toBe(true)
    expect(isDoubaoProviderId('openai')).toBe(false)
    expect(normalizeDoubaoModelId('doubao/seed-lite-7b')).toBe('seed-lite-7b')
    expect(findCatalogModelEntry(SAMPLE_CATALOG, 'doubao/5')?.rate?.text).toBe('0.65x')
    expect(findCatalogModelEntry(SAMPLE_CATALOG, 'seed-lite-7b')?.rate?.kind).toBe('promo')
  })

  it('resolves LocalizedText using host callback or language fallback', () => {
    expect(resolveClientText('Free')).toBe('Free')
    expect(resolveClientText({ en: 'Fast', zh: '极速' })).toMatch(/Fast|极速/)
    expect(resolveClientText({ en: 'Fast', zh: '极速' }, () => '极速')).toBe('极速')
  })

  it('fetches catalog snapshot from DOUBAO_CATALOG_PATH and deduplicates inflight requests', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(SAMPLE_CATALOG), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await Promise.all([refreshDoubaoCatalog(true), refreshDoubaoCatalog(true)])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(DOUBAO_CATALOG_PATH)

    // Subsequent non-forced refresh within cooldown skips network.
    await refreshDoubaoCatalog(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('DoubaoModelOptionLabel (conversation.input.model.label)', () => {
  it('renders multiplier & promo pills inside option and menu placements for Doubao models', () => {
    setDoubaoCatalogSnapshot(SAMPLE_CATALOG)

    const optionTree = inspectTree(
      DoubaoModelOptionLabel({
        provider: { id: 'doubao', name: '豆包' },
        model: { id: 'seed-lite-7b', name: 'Doubao Seed 2.1 Lite' },
        placement: 'option',
        selected: true,
        t: tZh,
      }),
    )
    expect(optionTree.texts.join(' ')).toContain('Doubao Seed 2.1 Lite')
    expect(optionTree.texts.join(' ')).toContain('限时优惠 0.01x')
    const promoEl = optionTree.elements.find((el) => el.props.className === 'dbq-picker-rate dbq-picker-rate-promo')
    expect(promoEl).toBeDefined()

    resetHookState()
    const menuTree = inspectTree(
      DoubaoModelOptionLabel({
        provider: { id: 'doubao', name: '豆包' },
        model: { id: '5', name: 'Doubao Seed 2.1 Pro' },
        placement: 'menu',
        selected: true,
        t: tZh,
      }),
    )
    expect(menuTree.texts.join(' ')).toContain('Doubao Seed 2.1 Pro')
    expect(menuTree.texts.join(' ')).toContain('0.65x')
    expect(menuTree.elements.some((el) => el.props.className === 'dbq-picker-rate')).toBe(true)
  })

  it('keeps trigger label compact without duplicating the toolbar pill', () => {
    setDoubaoCatalogSnapshot(SAMPLE_CATALOG)
    const triggerTree = inspectTree(
      DoubaoModelOptionLabel({
        provider: { id: 'doubao', name: '豆包' },
        model: { id: '5', name: 'Doubao Seed 2.1 Pro' },
        placement: 'trigger',
        selected: true,
        t: tZh,
      }),
    )
    expect(triggerTree.texts.join('')).toBe('Doubao Seed 2.1 Pro')
  })

  it('preserves non-Doubao model labels and localized badges cleanly', () => {
    setDoubaoCatalogSnapshot(SAMPLE_CATALOG)

    const plainTree = inspectTree(
      DoubaoModelOptionLabel({
        provider: { id: 'deepseek', name: 'DeepSeek' },
        model: { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        placement: 'option',
        selected: false,
        t: tEn,
      }),
    )
    expect(plainTree.texts.join('')).toBe('DeepSeek Chat')
    expect(plainTree.elements.some((el) => String(el.props.className ?? '').includes('dbq-picker-rate'))).toBe(false)

    resetHookState()
    const badgedTree = inspectTree(
      DoubaoModelOptionLabel({
        provider: { id: 'anthropic', name: 'Anthropic' },
        model: {
          id: 'claude',
          name: 'Claude',
          badge: { text: { en: 'New', zh: '新' }, tone: 'info' },
        },
        placement: 'option',
        selected: false,
        resolveText: (val) => (val as { zh: string }).zh,
        t: tZh,
      }),
    )
    expect(badgedTree.texts.join('')).toContain('Claude')
    expect(badgedTree.texts.join('')).toContain('新')
    const badgeEl = badgedTree.elements.find((el) => el.props.className === 'dbq-host-badge')
    expect(badgeEl?.props['data-tone']).toBe('info')
  })
})

describe('DoubaoComposerRateControl (conversation.input.right)', () => {
  it('stays hidden when the active session provider is not Doubao', () => {
    setDoubaoCatalogSnapshot(SAMPLE_CATALOG)
    const tree = inspectTree(
      DoubaoComposerRateControl({
        sessionId: 'sess-1',
        useProjection: () => ({ next: { provider: 'openai', model: 'gpt-4o' } }),
        t: tZh,
      }),
    )
    expect(tree.elements).toEqual([])
    expect(tree.texts).toEqual([])
  })

  it('shows active multiplier pill and opens popover listing all Doubao models', () => {
    setDoubaoCatalogSnapshot(SAMPLE_CATALOG)
    const projection: ModelSelectionProjection = {
      next: { provider: 'doubao', model: 'seed-lite-7b' },
    }
    const renderControl = () => {
      stateCursor = 0
      return inspectTree(
        DoubaoComposerRateControl({
          sessionId: 'sess-doubao',
          useProjection: () => projection,
          t: tZh,
        }),
      )
    }

    const closed = renderControl()
    expect(closed.texts.join(' ')).toContain('倍率 限时优惠 0.01x')
    expect(closed.elements.some((el) => el.props.className === 'dbq-rate-popover')).toBe(false)
    const triggerBtn = closed.elements.find((el) =>
      typeof el.props.className === 'string' && el.props.className.includes('dbq-rate-trigger'),
    )
    expect(triggerBtn?.props['aria-expanded']).toBe(false)

    // Click the trigger button to open the multiplier popover.
    ;(triggerBtn!.props.onClick as () => void)()
    const opened = renderControl()
    const popover = opened.elements.find((el) => el.props.className === 'dbq-rate-popover')
    expect(popover).toBeDefined()
    expect(opened.texts.join(' ')).toContain('豆包模型倍率')
    expect(opened.texts.join(' ')).toContain('Doubao Seed 2.1 Pro')
    expect(opened.texts.join(' ')).toContain('0.65x')
    expect(opened.texts.join(' ')).toContain('限时优惠 0.01x')
    expect(opened.texts.join(' ')).toContain('当前')
    expect(opened.texts.join(' ')).toContain(zh['models.rateNote'])

    const activeRow = opened.elements.find((el) => el.props['data-active'] === 'true')
    expect(activeRow).toBeDefined()
  })

  it('falls back to observed trigger selection when session projection is initially unset', () => {
    setDoubaoCatalogSnapshot(SAMPLE_CATALOG)
    recordObservedTriggerModel('sess-blank', { provider: 'doubao', model: '5' })

    const tree = inspectTree(
      DoubaoComposerRateControl({
        sessionId: 'sess-blank',
        useProjection: () => undefined,
        t: tEn,
      }),
    )
    expect(tree.texts.join(' ')).toContain('Rate 0.65x')
  })
})

describe('client apply(ctx) slot registrations', () => {
  it('registers model label and composer right rate control alongside settings card', () => {
    const injectedSlots: string[] = []
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []

    const fakeCtx = {
      effect: (fn: () => unknown) => fn(),
      get: () => undefined,
      locale: {
        register: () => () => {},
        bind: () => tZh,
        resolveText: (value: unknown) => typeof value === 'string' ? value : 'localized',
      },
      slots: {
        inject: (slotName: string, fn: () => unknown) => {
          injectedSlots.push(slotName)
          fn()
          return () => {}
        },
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
    }

    apply(fakeCtx as never)

    expect(injectedSlots).toContain('plugins.bundle.config')
    expect(injectedSlots).toContain('plugins.row.config')
    expect(injectedSlots).toContain('settings.section')
    expect(injectedSlots).toContain('conversation.input.model.label')
    expect(injectedSlots).toContain('conversation.input.right')

    const modelLabelReg = registrations.find((r) => r.options.name === 'conversation.input.model.label')
    expect(modelLabelReg?.options.priority).toBe(30)
    expect(modelLabelReg?.component).toBe(DoubaoModelOptionLabel)
    const labelInjected = (modelLabelReg?.options.inject as () => { t: unknown; resolveText?: unknown })()
    expect(typeof labelInjected.t).toBe('function')
    expect(typeof labelInjected.resolveText).toBe('function')

    const rateCtrlReg = registrations.find((r) => r.options.name === 'conversation.input.right')
    expect(rateCtrlReg?.options.id).toBe('doubao-rate')
    expect(rateCtrlReg?.options.order).toBe(90)
    expect(rateCtrlReg?.component).toBe(DoubaoComposerRateControl)
  })
})
