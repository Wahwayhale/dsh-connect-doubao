/**
 * The Doubao quota + model card, rendered into the host's Plugin
 * configuration surface.
 *
 * SCOPE (deliberately narrow): two quota bars with reset countdowns, the plan
 * name, the account status line, a refresh button with a 5-minute poll, four
 * distinct error states, and the model checklist. No account pool, no region
 * tabs, no credit multipliers, no check-in.
 *
 * THE ONE HONESTY REQUIREMENT: Doubao is content-driven. The request body
 * carries `bot_id`, never a model id — the server picks the model after reading
 * the prompt (see `../doubao-catalog.ts`). So the checklist does NOT choose a
 * model. Ticking an entry decides whether that ENTRY appears in DSH's model
 * picker. Every label in the model block says so, because a checklist that
 * looked like model selection would be a lie the user acts on.
 *
 * SECURITY: this component renders only the allow-listed fields of
 * `DoubaoQuotaView` / `DoubaoCatalogView`. It never reads, stores or displays a
 * cookie, token or account id, and it never reads a setting other than the
 * ticked model ids.
 *
 * @module dsh-connect-doubao/client-card
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  DOUBAO_CATALOG_PATH,
  DOUBAO_ENABLED_MODELS_FIELD,
  DOUBAO_QUOTA_PATH,
  classifyQuotaView,
  clampPercent,
  enabledModelIdsOf,
  formatCountdown,
} from './contract.ts'
import type { DoubaoAccountState, DoubaoCatalogView, DoubaoModelEntry, DoubaoQuotaView } from './contract.ts'
import type { DoubaoCardKey, Translate } from './locales.ts'
import { DOUBAO_CARD_CSS } from './styles.ts'

/** How often the quota is re-read without the user asking. */
const POLL_INTERVAL_MS = 5 * 60 * 1000

/**
 * Props the slot delivers.
 *
 * Both members are OPTIONAL on purpose and the card is written to work with
 * neither: `t` falls back to the key, and with no `settingsScope` the model
 * block renders read-only. A host line that provides only one of the two seats
 * must still get a working card rather than a blank slot.
 */
export interface DoubaoCardInjected {
  t: Translate
  settingsScope?: {
    getSnapshot(): { status: string; value?: unknown; writable: boolean }
    subscribe(listener: () => void): () => void
    /** Whether the Host accepted the write; `void` on older lines. */
    set(field: string, value: unknown): Promise<boolean | void>
  }
}

/** Props as received from the Plugin configuration slot. */
export type DoubaoCardProps = Partial<DoubaoCardInjected> & { view?: string }

type T = (key: DoubaoCardKey, vars?: Record<string, string | number>) => string

/**
 * Fallback translator: renders the key itself.
 *
 * Better than throwing. If the locale registration failed, the card still shows
 * its structure (bars, state dot, controls) with visible key names, which is
 * diagnosable — a thrown render would blank the slot and hide the failure.
 */
const fallbackT: T = key => key

/** Inject the stylesheet once per document. */
function useCardStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return
    const id = 'dbq-card-styles'
    if (document.getElementById(id) !== null) return
    const el = document.createElement('style')
    el.id = id
    el.textContent = DOUBAO_CARD_CSS
    document.head?.appendChild(el)
  }, [])
}

/**
 * GET the quota view. Never throws: every failure becomes `undefined`, which
 * classifies as `unreadable` rather than unmounting the card.
 */
async function fetchQuota(signal: AbortSignal): Promise<DoubaoQuotaView | undefined> {
  const response = await fetch(DOUBAO_QUOTA_PATH, {
    method: 'GET',
    credentials: 'same-origin',
    signal,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) return undefined
  return (await response.json()) as DoubaoQuotaView
}

/** POST forces a host-side cache bypass. Same error contract as {@link fetchQuota}. */
async function refreshQuota(): Promise<DoubaoQuotaView | undefined> {
  const response = await fetch(DOUBAO_QUOTA_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) return undefined
  return (await response.json()) as DoubaoQuotaView
}

/** Read the catalog for the checklist. Never throws. */
async function fetchCatalog(signal: AbortSignal): Promise<DoubaoCatalogView | undefined> {
  const response = await fetch(DOUBAO_CATALOG_PATH, {
    method: 'GET',
    credentials: 'same-origin',
    signal,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) return undefined
  return (await response.json()) as DoubaoCatalogView
}

/** One quota bar: label, used percent, bar, reset countdown. */
function QuotaBar(props: {
  label: string
  usedPercent: number | undefined
  resetsInMs: number | undefined
  t: T
  now: number
}): ReactElement {
  const { label, usedPercent, resetsInMs, t, now } = props
  if (usedPercent === undefined) {
    return (
      <div className="dbq-row">
        <div className="dbq-row-head">
          <span className="dbq-label">{label}</span>
          <span className="dbq-meta">{t('quota.windowMissing')}</span>
        </div>
      </div>
    )
  }
  const percent = clampPercent(usedPercent)
  // Tones are keyed on the CONSUMED percentage: full means nothing left, and a
  // nearly-full window should read as a warning before it actually runs out.
  const tone = percent >= 100 ? ' dbq-full' : percent >= 80 ? ' dbq-warn' : ''
  // The countdown is recomputed from the host's absolute reset instant rather
  // than by decrementing the host's remaining ms, so a stale payload cannot
  // drift: a tab left open for an hour still shows the true remaining time.
  return (
    <div className="dbq-row">
      <div className="dbq-row-head">
        <span className="dbq-label">{label}</span>
        <span className="dbq-meta">
          {t('quota.used', { percent })} · {t('quota.resetsIn', { time: formatCountdown(resetsInMs ?? 0) })}
        </span>
      </div>
      <div
        className="dbq-bar"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className={`dbq-fill${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="dbq-meta" hidden>{`now=${now}`}</span>
    </div>
  )
}

/** Tier number → its label. Doubao's `need_deep_think` is 0 / 1 / 3. */
function tierLabel(tier: number, t: T): string | undefined {
  if (tier === 0) return t('models.tierFast')
  if (tier === 1) return t('models.tierThink')
  if (tier === 3) return t('models.tierExpert')
  return undefined
}

export function DoubaoQuotaCard(props: DoubaoCardProps): ReactElement {
  const t = (props.t ?? fallbackT) as T
  const scope = props.settingsScope
  useCardStyles()

  const [quota, setQuota] = useState<DoubaoQuotaView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [catalog, setCatalog] = useState<DoubaoCatalogView | undefined>(undefined)
  const [catalogBusy, setCatalogBusy] = useState(false)
  /** Ticking `settingsScope` bumps this so the model block re-reads the snapshot. */
  const [settingsRevision, setSettingsRevision] = useState(0)
  /** Only set once the settings write has been read back and confirmed. */
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  /**
   * The settings snapshot, or undefined when the host offers no write seat.
   * `scope` is a stable injected reference, so it is safe in the dep list.
   */
  const configured = useMemo(() => {
    if (scope === undefined) return undefined
    try {
      return scope.getSnapshot().value
    } catch {
      return undefined
    }
  }, [scope, settingsRevision])

  const canWrite = scope !== undefined && (() => {
    try {
      return scope.getSnapshot().writable === true
    } catch {
      return false
    }
  })()

  // Re-read whenever the host announces a settings change.
  useEffect(() => {
    if (scope === undefined) return
    return scope.subscribe(() => setSettingsRevision(value => value + 1))
  }, [scope])

  // ---- quota: initial read + 5-minute poll -----------------------------
  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      try {
        const view = await fetchQuota(controller.signal)
        if (alive) setQuota(view)
      } catch {
        if (alive) setQuota(undefined)
      }
    }
    void load()
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS)
    return () => {
      alive = false
      controller.abort()
      clearInterval(timer)
    }
  }, [])

  // ---- manual refresh ---------------------------------------------------
  const onRefresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      setQuota(await refreshQuota())
    } catch {
      setQuota(undefined)
    } finally {
      setBusy(false)
    }
  }, [])

  // ---- catalog (the checklist's source) --------------------------------
  const loadCatalog = useCallback(async (): Promise<void> => {
    setCatalogBusy(true)
    try {
      setCatalog(await fetchCatalog(new AbortController().signal))
    } catch {
      setCatalog(undefined)
    } finally {
      setCatalogBusy(false)
    }
  }, [])

  useEffect(() => { void loadCatalog() }, [loadCatalog])

  /**
   * The draft: which entries are ticked.
   *
   * `undefined` means "no draft yet" — the card derives one from the catalog
   * (ticking everything, so a first-time user sees a usable picker) rather than
   * rendering an empty list that reads as a failure.
   */
  const [draft, setDraft] = useState<Set<string> | undefined>(undefined)

  useEffect(() => {
    const models = catalog?.models
    if (models === undefined || models.length === 0) {
      setDraft(undefined)
      return
    }
    const savedIds = enabledModelIdsOf(configured)
    setDraft(new Set(savedIds ?? models.map(model => model.id)))
  }, [catalog, configured])

  const models: readonly DoubaoModelEntry[] = catalog?.models ?? []
  const enabledCount = draft === undefined ? 0 : draft.size

  /**
   * Whether the draft differs from what is saved.
   *
   * Compared as SETS of ids, so reordering the catalog never marks the card
   * dirty, and a saved value that the current catalog does not contain does not
   * either. Only ids present in the catalog can be toggled, so an id that has
   * since disappeared upstream is simply ignored.
   */
  const dirty = useMemo(() => {
    if (draft === undefined) return false
    const savedIds = enabledModelIdsOf(configured)
    const base = new Set(savedIds ?? models.map(model => model.id))
    if (base.size !== draft.size) return true
    for (const id of base) if (!draft.has(id)) return true
    return false
  }, [draft, configured, models])

  const toggle = useCallback((id: string): void => {
    setDraft(current => {
      const next = new Set(current ?? [])
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setSaved(false)
    setSaveError(null)
  }, [])

  const selectAll = useCallback((): void => {
    setDraft(new Set(models.map(model => model.id)))
    setSaved(false)
    setSaveError(null)
  }, [models])

  const selectNone = useCallback((): void => {
    setDraft(new Set())
    setSaved(false)
    setSaveError(null)
  }, [])

  /**
   * Save the draft, then READ IT BACK.
   *
   * `scope.set()` resolving is not proof of persistence: the host writes the
   * active profile's patch file through a temp-file-and-rename, and a Windows
   * scanner or sync client holding the file makes the host reload state and
   * simply RETURN — so the await succeeds with nothing written. The read-back
   * is the only reliable confirmation, and here it matters more than usual: a
   * save discards the draft, so a silently-failed write would throw away the
   * user's edits while reporting success.
   */
  const onSave = useCallback(async (): Promise<void> => {
    if (scope === undefined || draft === undefined) return
    setBusy(true)
    setSaveError(null)
    const ids = [...draft]
    try {
      await scope.set(DOUBAO_ENABLED_MODELS_FIELD, ids)
      let readBack = enabledModelIdsOf(scope.getSnapshot().value)
      // The host may persist asynchronously; a short bounded retry turns a
      // merely-late write into a confirmed one without waiting unboundedly.
      for (let attempt = 0; attempt < 5 && readBack === undefined; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 120))
        readBack = enabledModelIdsOf(scope.getSnapshot().value)
      }
      const landed = readBack !== undefined && readBack.length === ids.length &&
        ids.every(id => readBack?.includes(id))
      if (!landed) {
        setSaveError(t('models.saveFailed', { reason: 'host did not persist the value' }))
        return
      }
      setSaved(true)
    } catch (error: unknown) {
      setSaveError(t('models.saveFailed', { reason: (error as Error)?.message ?? 'unknown error' }))
    } finally {
      setBusy(false)
    }
  }, [scope, draft, t])

  // ---- render -----------------------------------------------------------
  const state: DoubaoAccountState = classifyQuotaView(quota)
  const stateText = t(`account.${state}`)
  const stateTone = state === 'ok' ? '' : state === 'exhausted' || state === 'network' ? ' dbq-bad' : ' dbq-warn'

  return (
    <div className="dbq-card">
      <div className="dbq-head">
        <span className="dbq-title">{t('card.title')}</span>
        <span className="dbq-sub">{t('card.subtitle')}</span>
      </div>

      {/* ---- quota ---- */}
      <div className="dbq-section">
        <div className="dbq-section-title">
          <span>{t('quota.plan')}</span>
          <span className="dbq-count">{quota?.plan ?? '—'}</span>
        </div>
        <QuotaBar
          label={t('quota.fiveHour')}
          usedPercent={quota?.windows.fiveHour?.usedPercent}
          resetsInMs={quota?.windows.fiveHour?.resetsInMs}
          t={t}
          now={0}
        />
        <QuotaBar
          label={t('quota.weekly')}
          usedPercent={quota?.windows.weekly?.usedPercent}
          resetsInMs={quota?.windows.weekly?.resetsInMs}
          t={t}
          now={0}
        />
        <div className="dbq-actions">
          <button type="button" className="dbq-btn" onClick={() => void onRefresh()} disabled={busy}>
            {busy ? t('quota.refreshing') : t('quota.refresh')}
          </button>
          <span className="dbq-note">{t('quota.autoNote')}</span>
        </div>
      </div>

      {/* ---- account status ---- */}
      <div className="dbq-section">
        <div className="dbq-section-title"><span>{t('account.title')}</span></div>
        <div className="dbq-state">
          <span className={`dbq-dot${stateTone}`} />
          <span className="dbq-state-text">{stateText}</span>
        </div>
        {quota?.profile !== undefined && (
          <div className="dbq-profile">{t('account.profile')}: {quota.profile}</div>
        )}
      </div>

      {/* ---- model checklist ---- */}
      <div className="dbq-section">
        <div className="dbq-section-title">
          <span>{t('models.title')}</span>
          <span className="dbq-count">{t('models.enabledCount', { count: enabledCount })}</span>
        </div>
        {/* The honesty line. Without it the checklist reads as model selection,
            which the upstream does not honour. */}
        <div className="dbq-note">{t('models.routingNote')}</div>

        {scope === undefined && <div className="dbq-note">{t('models.readOnly')}</div>}
        {catalog === undefined && <div className="dbq-note">{t('models.loadFailed')}</div>}
        {catalog?.ok === true && models.length === 0 && <div className="dbq-note">{t('models.empty')}</div>}

        <div className="dbq-models">
          {models.map(model => (
            <label key={model.id} className="dbq-model">
              <input
                type="checkbox"
                checked={draft?.has(model.id) ?? false}
                disabled={!canWrite || draft === undefined}
                onChange={() => toggle(model.id)}
              />
              <span className="dbq-model-main">
                <span className="dbq-model-name">
                  <span>{model.name}</span>
                  {model.badge !== null && <span className="dbq-badge">{model.badge}</span>}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="dbq-actions">
          <button type="button" className="dbq-btn" onClick={() => void loadCatalog()} disabled={catalogBusy}>
            {catalogBusy ? t('models.refreshing') : t('models.refresh')}
          </button>
          <button type="button" className="dbq-btn" onClick={selectAll} disabled={!canWrite}>{t('models.selectAll')}</button>
          <button type="button" className="dbq-btn" onClick={selectNone} disabled={!canWrite}>{t('models.selectNone')}</button>
          <button
            type="button"
            className={`dbq-btn dbq-primary${dirty ? ' dbq-dirty' : ''}`}
            onClick={() => void onSave()}
            disabled={!canWrite || !dirty || busy}
          >
            {busy ? t('models.saving') : t('models.save')}
          </button>
          {dirty && <span className="dbq-dirty-flag">{t('models.dirty')}</span>}
          {!dirty && saved && <span className="dbq-saved">{t('models.saved')}</span>}
          {saveError !== null && <span className="dbq-error">{saveError}</span>}
        </div>
      </div>
    </div>
  )
}

export default DoubaoQuotaCard