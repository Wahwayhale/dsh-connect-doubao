import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stateHooks: Array<{ value: unknown; setter: (next: unknown) => void }> = []
let stateCursor = 0
let effectQueue: Array<() => unknown> = []
const ranMountEffects = new Set<number>()
let effectCursor = 0

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
      return [stateHooks[idx]!.value, stateHooks[idx]!.setter]
    },
    useEffect: (fn: () => unknown, deps?: unknown[]) => {
      const idx = effectCursor++
      if (deps === undefined || deps.length > 0 || !ranMountEffects.has(idx)) {
        ranMountEffects.add(idx)
        effectQueue.push(fn)
      }
    },
    useCallback: <T>(fn: T) => fn,
    useMemo: <T>(fn: () => T) => fn(),
    useRef: (initial: unknown) => ({ current: initial }),
  }
})

vi.mock('react-dom', () => ({
  createPortal: (node: unknown) => node,
}))

import {
  DOUBAO_AUTH_PATH,
  DOUBAO_CATALOG_PATH,
  DOUBAO_QUOTA_PATH,
  DOUBAO_SAVE_PATH,
  DOUBAO_STATS_PATH,
  formatCompactTokens,
  type DoubaoStatsView,
} from '../src/client/contract.ts'
import { DoubaoQuotaCard } from '../src/client/DoubaoQuotaCard.tsx'
import { en, translator, zh } from '../src/client/index.ts'

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
    if (typeof item === 'object') {
      const el = item as { type?: unknown; props?: Record<string, unknown> }
      if (typeof el.type === 'function') {
        walk((el.type as (p: unknown) => unknown)(el.props ?? {}))
        return
      }
      if (el.type !== undefined && el.props !== undefined) {
        elements.push({ type: el.type, props: el.props })
      }
      if (el.props?.children !== undefined) walk(el.props.children)
    }
  }
  walk(node)
  return { texts, elements }
}

function renderCard(t: ReturnType<typeof translator>) {
  stateCursor = 0
  effectCursor = 0
  return inspectTree(DoubaoQuotaCard({ t: (key, vars) => t(key as never, vars) }))
}

beforeEach(() => {
  stateHooks.length = 0
  stateCursor = 0
  effectQueue = []
  ranMountEffects.clear()
  effectCursor = 0
  vi.stubGlobal('document', {
    head: { appendChild: () => {} },
    getElementById: () => ({ id: 'exists' }),
    createElement: () => ({}),
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
  })
})

const effectCleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of effectCleanups.splice(0)) {
    try { cleanup() } catch {}
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('DoubaoQuotaCard session stats & token usage rendering', () => {
  it('formats compact token counts consistently', () => {
    expect(formatCompactTokens(0)).toBe('0')
    expect(formatCompactTokens(842)).toBe('842')
    expect(formatCompactTokens(12_340)).toBe('12.3k')
    expect(formatCompactTokens(1_250_000)).toBe('1.25M')
  })

  it('loads stats from DOUBAO_STATS_PATH, renders zh/en metrics + upstream window, and resets via guarded POST', async () => {
    let currentStats: DoubaoStatsView = {
      ok: true,
      startedAt: 1000,
      updatedAt: 5000,
      activeConversations: 2,
      totals: {
        requests: 3,
        succeeded: 3,
        failed: 0,
        continuations: 1,
        promptTokens: 12_400,
        uncachedInputTokens: 8_400,
        cachedInputTokens: 4_000,
        completionTokens: 1_200,
        reasoningTokens: 450,
        totalTokens: 13_600,
        cacheHitRate: 0.32,
        avgTtftMs: 420,
        avgTps: 48.5,
        totalDurationMs: 6_000,
        decodeMs: 2_500,
        decodeTokens: 1_200,
      },
      byModel: [],
      sessions: [],
      lastTurn: {
        at: 5000,
        model: '5',
        stream: true,
        continuation: true,
        promptTokens: 5_000,
        uncachedInputTokens: 1_000,
        cachedInputTokens: 4_000,
        completionTokens: 500,
        reasoningTokens: 200,
        totalTokens: 5_500,
        ttftMs: 380,
        durationMs: 1_800,
        decodeMs: 1_000,
        tps: 50,
        upstreamContextWindow: {
          systemPrompt: 6_640,
          messages: 13_910,
          skills: 0,
          tools: 35_639,
          totalWindowSize: 256_000,
          totalUsed: 56_189,
        },
        upstreamFirstPacketMs: 2922,
        upstreamAckMs: 266,
      },
    }

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === DOUBAO_QUOTA_PATH) {
        return new Response(
          JSON.stringify({
            ok: true,
            profile: 'C:\\Users\\test',
            plan: '标准套餐',
            exhausted: false,
            windows: { fiveHour: null, weekly: null, incentive: [] },
            fetchedAt: 5000,
            error: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === DOUBAO_STATS_PATH) {
        if (init?.method === 'POST') {
          expect((init.headers as Record<string, string>)['x-dsh-doubao-write']).toBe('1')
          currentStats = {
            ...currentStats,
            activeConversations: 0,
            totals: {
              ...currentStats.totals,
              requests: 0,
              succeeded: 0,
              continuations: 0,
              promptTokens: 0,
              uncachedInputTokens: 0,
              cachedInputTokens: 0,
              completionTokens: 0,
              reasoningTokens: 0,
              totalTokens: 0,
              cacheHitRate: null,
              avgTtftMs: null,
              avgTps: null,
              decodeMs: 0,
              decodeTokens: 0,
            },
            lastTurn: null,
          }
        }
        return new Response(JSON.stringify(currentStats), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === DOUBAO_CATALOG_PATH) {
        return new Response(JSON.stringify({ ok: true, models: [], error: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === DOUBAO_SAVE_PATH) {
        return new Response(JSON.stringify({ ok: true, value: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === DOUBAO_AUTH_PATH) {
        return new Response(
          JSON.stringify({ ok: true, signedIn: true, expiresAt: null, daysLeft: null, detail: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const tZh = translator(zh)
    const tEn = translator(en)
    renderCard(tZh)

    for (const fn of effectQueue.splice(0)) {
      const cleanup = fn()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup as () => void)
    }
    await new Promise((r) => setTimeout(r, 20))

    const loadedZh = renderCard(tZh)
    const joinedZh = loadedZh.texts.join(' | ')
    expect(joinedZh).toContain('会话统计与 Token 用量')
    expect(joinedZh).toContain('活跃会话 2')
    expect(joinedZh).toContain('13.6k')
    expect(joinedZh).toContain('420ms')
    expect(joinedZh).toContain('48.5 tok/s')
    expect(joinedZh).toContain('56.2k / 256.0k')

    const loadedEn = renderCard(tEn)
    const joinedEn = loadedEn.texts.join(' | ')
    expect(joinedEn).toContain('Session stats & token usage')
    expect(joinedEn).toContain('2 active sessions')
    expect(joinedEn).toContain('Last upstream window')

    const resetBtn = loadedZh.elements.find(
      (el) => el.type === 'button' && String(el.props.children) === '清零统计',
    )
    expect(resetBtn).toBeDefined()
    ;(resetBtn!.props.onClick as () => void)()
    await new Promise((r) => setTimeout(r, 20))

    const afterReset = renderCard(tZh)
    expect(afterReset.texts.join(' | ')).toContain('暂无已完成的对话轮次')
    expect(afterReset.texts.join(' | ')).toContain('刷新统计')
    expect(
      fetchMock.mock.calls.some(([u, init]) => String(u) === DOUBAO_STATS_PATH && init?.method === 'POST'),
    ).toBe(true)
  })
})
