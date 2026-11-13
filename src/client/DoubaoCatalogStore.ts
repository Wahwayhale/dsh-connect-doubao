/**
 * Shared client-side store for the Doubao model catalog & active trigger mirror.
 *
 * Fetches `DOUBAO_CATALOG_PATH` lazily on mount, throttles background refreshes
 * on focus/visibility/interval, and exposes `useSyncExternalStore` hooks so
 * both the Settings checklist and dialog composer controls stay in sync.
 */
import { useSyncExternalStore } from 'react'
import {
  DOUBAO_CATALOG_PATH,
  type DoubaoCatalogView,
  type DoubaoModelEntry,
} from './contract.ts'

const REFRESH_INTERVAL_MS = 60_000
const MIN_FOCUS_REFRESH_GAP_MS = 15_000

const listeners = new Set<() => void>()
let catalogSnapshot: DoubaoCatalogView | undefined
let inflight: Promise<void> | undefined
let lastFetchedAt = 0
let intervalTimer: ReturnType<typeof setInterval> | undefined
let listenersAttached = false

/** Active Doubao selection reported by `conversation.input.model.label` (`placement: "trigger"`). */
export interface ObservedModelSelection {
  provider: string
  model: string
}

const triggerBySession = new Map<string, ObservedModelSelection>()
const triggerListeners = new Set<() => void>()

function emitCatalog(): void {
  for (const listener of listeners) listener()
}

function emitTrigger(): void {
  for (const listener of triggerListeners) listener()
}

export function isDoubaoProviderId(providerId: string | undefined): boolean {
  return typeof providerId === 'string' && /doubao/i.test(providerId)
}

export function normalizeDoubaoModelId(modelId: string | undefined): string | undefined {
  if (typeof modelId !== 'string') return undefined
  const trimmed = modelId.trim()
  if (trimmed === '') return undefined
  return trimmed.replace(/^doubao\//i, '')
}

export function findCatalogModelEntry(
  catalog: DoubaoCatalogView | undefined,
  modelId: string | undefined,
): DoubaoModelEntry | undefined {
  if (catalog === undefined || !catalog.ok) return undefined
  const normalized = normalizeDoubaoModelId(modelId)
  if (normalized === undefined) return undefined
  return catalog.models.find((entry) => entry.id === normalized || entry.id === modelId)
}

export function resolveClientText(
  value: unknown,
  hostResolveText?: (text: unknown) => string,
): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined || typeof value !== 'object') return ''
  if (hostResolveText !== undefined) {
    try {
      const resolved = hostResolveText(value)
      if (typeof resolved === 'string' && resolved !== '') return resolved
    } catch {
      /* fall through to local map resolution */
    }
  }
  const dict = value as Record<string, unknown>
  const lang = typeof navigator !== 'undefined' && typeof navigator.language === 'string'
    ? navigator.language.toLowerCase()
    : 'en'
  const candidates = lang.startsWith('zh')
    ? ['zh', 'zh-CN', 'zh-Hans', 'en']
    : [lang, lang.split('-')[0] ?? '', 'en', 'zh']
  for (const key of candidates) {
    if (key && typeof dict[key] === 'string' && dict[key] !== '') return dict[key]
  }
  for (const entry of Object.values(dict)) {
    if (typeof entry === 'string' && entry !== '') return entry
  }
  return ''
}

export async function refreshDoubaoCatalog(force = false): Promise<void> {
  if (typeof fetch !== 'function') return
  const now = Date.now()
  if (!force && now - lastFetchedAt < MIN_FOCUS_REFRESH_GAP_MS && catalogSnapshot !== undefined) {
    return
  }
  if (inflight !== undefined) return inflight
  inflight = (async () => {
    try {
      const response = await fetch(DOUBAO_CATALOG_PATH)
      if (!response.ok) return
      const parsed = (await response.json()) as DoubaoCatalogView
      catalogSnapshot = parsed
      lastFetchedAt = Date.now()
      emitCatalog()
    } catch {
      /* leave prior snapshot intact on transient errors */
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}

export function setDoubaoCatalogSnapshot(next: DoubaoCatalogView | undefined): void {
  catalogSnapshot = next
  lastFetchedAt = next === undefined ? 0 : Date.now()
  emitCatalog()
}

function handleWindowActive(): void {
  if (typeof document !== 'undefined' && document.hidden) return
  void refreshDoubaoCatalog(false)
}

function startPollingIfNeeded(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (intervalTimer === undefined) {
    intervalTimer = setInterval(() => {
      if (!document.hidden) void refreshDoubaoCatalog(false)
    }, REFRESH_INTERVAL_MS)
  }
  if (!listenersAttached) {
    listenersAttached = true
    window.addEventListener('focus', handleWindowActive)
    document.addEventListener('visibilitychange', handleWindowActive)
  }
}

function stopPollingIfUnused(): void {
  if (listeners.size > 0) return
  if (intervalTimer !== undefined) {
    clearInterval(intervalTimer)
    intervalTimer = undefined
  }
  if (listenersAttached && typeof window !== 'undefined' && typeof document !== 'undefined') {
    listenersAttached = false
    window.removeEventListener('focus', handleWindowActive)
    document.removeEventListener('visibilitychange', handleWindowActive)
  }
}

function subscribeCatalog(listener: () => void): () => void {
  listeners.add(listener)
  startPollingIfNeeded()
  if (catalogSnapshot === undefined) {
    void refreshDoubaoCatalog(true)
  }
  return () => {
    listeners.delete(listener)
    stopPollingIfUnused()
  }
}

function getCatalogSnapshot(): DoubaoCatalogView | undefined {
  return catalogSnapshot
}

export function useDoubaoCatalog(): DoubaoCatalogView | undefined {
  return useSyncExternalStore(subscribeCatalog, getCatalogSnapshot, getCatalogSnapshot)
}

export function recordObservedTriggerModel(
  sessionId: string | undefined,
  selection: ObservedModelSelection,
): void {
  const key = sessionId ?? '__default__'
  const prev = triggerBySession.get(key)
  if (prev?.provider === selection.provider && prev?.model === selection.model) return
  triggerBySession.set(key, selection)
  emitTrigger()
}

export function getObservedTriggerModel(
  sessionId: string | undefined,
): ObservedModelSelection | undefined {
  return triggerBySession.get(sessionId ?? '__default__')
}

export function resetCatalogStoreForTests(): void {
  catalogSnapshot = undefined
  lastFetchedAt = 0
  inflight = undefined
  triggerBySession.clear()
  if (intervalTimer !== undefined) {
    clearInterval(intervalTimer)
    intervalTimer = undefined
  }
}

export function useObservedTriggerModel(
  sessionId: string | undefined,
): ObservedModelSelection | undefined {
  return useSyncExternalStore(
    (listener) => {
      triggerListeners.add(listener)
      return () => {
        triggerListeners.delete(listener)
      }
    },
    () => getObservedTriggerModel(sessionId),
    () => getObservedTriggerModel(sessionId),
  )
}
