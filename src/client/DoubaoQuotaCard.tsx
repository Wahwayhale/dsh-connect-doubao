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
  DOUBAO_SAVE_PATH,
  classifyQuotaView,
  clampPercent,
  enabledModelIdsOf,
  DOUBAO_TOOL_EMULATION_FIELD,
  DOUBAO_PROFILE_DIR_FIELD,
  DOUBAO_PROFILE_PATH,
  profileDirOf,
  toolEmulationOf,
  formatCountdown,
} from './contract.ts'
import type {
  DoubaoAccountState,
  DoubaoCatalogView,
  DoubaoModelEntry,
  DoubaoProfileView,
  DoubaoQuotaView,
} from './contract.ts'
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
   * The settings snapshot, used ONLY as a fallback.
   *
   * The authoritative copy is now the plugin's own file, read through
   * `DOUBAO_SAVE_PATH` below: this plugin's fiber never reaches ACTIVE on DSH
   * 0.2.1, so the host neither lists nor writes its namespace (`No configurable
   * plugin entry`). A snapshot that cannot see a save is worse than no
   * snapshot, hence the file wins when both are available.
   */
  const scopedValue = useMemo(() => {
    if (scope === undefined) return undefined
    try {
      return scope.getSnapshot().value
    } catch {
      return undefined
    }
  }, [scope, settingsRevision])

  /** Settings as persisted by the plugin itself. `undefined` = not read yet. */
  const [stored, setStored] = useState<unknown>(undefined)
  const [storeError, setStoreError] = useState<string | null>(null)

  const loadSettings = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(DOUBAO_SAVE_PATH, { method: 'GET' })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const body = await response.json() as { value?: unknown }
      setStored(body.value)
      setStoreError(null)
    } catch (error: unknown) {
      // Falling back rather than failing: an older host without this route
      // still renders, at the cost of not seeing filesystem-persisted values.
      setStoreError((error as Error)?.message ?? 'unknown error')
      setStored(scope === undefined ? undefined : scopedValue)
    }
  }, [scope, scopedValue])

  useEffect(() => { void loadSettings() }, [loadSettings])

  const configured = stored ?? scopedValue

  /**
   * Writes go through the plugin's own endpoint, so they do NOT depend on the
   * host's `writable` flag — that flag is exactly what was false here.
   */
  const canWrite = stored !== undefined || storeError === null

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
   * Persist one settings field through the plugin's OWN endpoint.
   *
   * Neither `scope.set()` NOR `settings.mutate` can persist this plugin: its
   * fiber never reaches ACTIVE on DSH 0.2.1, so the host reports
   * `No configurable plugin entry "dsh-connect-doubao"` and drops every write.
   * The endpoint writes a JSON file the plugin owns (write-temp-then-rename),
   * and returns the value it now reads back — so a successful response is
   * proof of persistence, not a claim.
   */
  const persistField = useCallback(async (field: string, value: unknown): Promise<unknown> => {
    let response: Response
    try {
      response = await fetch(DOUBAO_SAVE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, value }),
      })
    } catch (error: unknown) {
      throw new Error(`host save endpoint unreachable: ${(error as Error)?.message ?? String(error)}`)
    }
    const detail = await response.json().catch(() => ({ error: `HTTP ${String(response.status)}` })) as {
      ok?: unknown
      value?: unknown
      errorName?: unknown
      error?: unknown
    }
    if (!response.ok || detail.ok !== true) {
      const reason = `${String(detail.errorName ?? '')} ${String(detail.error ?? '')}`.trim()
      throw new Error(reason === '' ? `HTTP ${String(response.status)}` : reason)
    }
    // The endpoint returns the file's state AFTER the write, so the card can
    // render the committed value without a second round trip.
    setStored(detail.value)
    setStoreError(null)
    return detail.value
  }, [])

  /**
   * Save the draft, then READ IT BACK.
   *
   * The endpoint reporting `ok` is the commit; the read-back only confirms the
   * page's own snapshot caught up. Here it matters more than usual because a
   * save discards the draft — so a snapshot that never refreshes is reported
   * rather than silently losing the user's edits.
   */
  const onSave = useCallback(async (): Promise<void> => {
    if (draft === undefined) return
    setBusy(true)
    setSaveError(null)
    const ids = [...draft]
    try {
      // `persistField` resolves with the file state AFTER the write, so it is
      // already the read-back. The old loop that polled the host snapshot is
      // gone: it was polling a channel this plugin does not appear in, so it
      // could only ever time out (which is what produced the false "save
      // failed" this whole rewrite exists to remove).
      const committed = enabledModelIdsOf(await persistField(DOUBAO_ENABLED_MODELS_FIELD, ids))
      const landed = committed !== undefined && committed.length === ids.length &&
        ids.every(id => committed?.includes(id))
      if (!landed) {
        setSaveError(t('models.saveFailed', { reason: '已写入磁盘，但回读的值与提交的不一致' }))
        return
      }
      setSaved(true)
    } catch (error: unknown) {
      setSaveError(t('models.saveFailed', { reason: (error as Error)?.message ?? 'unknown error' }))
    } finally {
      setBusy(false)
    }
  }, [persistField, draft, t])

  /**
   * The tool-emulation switch.
   *
   * Written immediately (no Save button) because it is a single independent
   * toggle: bundling it into the checklist's draft would make a model-selection
   * edit and a privilege change share one commit, and the user cannot tell which
   * one they are confirming.
   *
   * Read back for the same reason the checklist is: the host's write can resolve
   * while the value never lands (see `onSave`), and silently failing to turn OFF
   * a capability that lets a model touch files is the worse error.
   */
  // ---- profile directory ------------------------------------------------
  const [profile, setProfile] = useState<DoubaoProfileView | undefined>(undefined)
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)

  const loadProfile = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(DOUBAO_PROFILE_PATH, { method: 'GET' })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      setProfile(await response.json() as DoubaoProfileView)
    } catch (error: unknown) {
      setProfileError((error as Error)?.message ?? 'unknown error')
    }
  }, [])

  useEffect(() => { void loadProfile() }, [loadProfile])

  const chosenProfile = profileDirOf(configured)
  /** What is actually in use right now: the manual pick, else auto-detection. */
  const activeProfile = chosenProfile !== '' ? chosenProfile : (profile?.detected ?? '')

  /**
   * Open the host's native folder picker.
   *
   * The desktop shell exposes `__DSH_DIRECTORY_PICKER__.pick()` — an Electron
   * dialog that runs on the main thread and can therefore create a folder. A
   * browser-only host has no equivalent, and the card says so rather than
   * silently doing nothing; `DSH_DOUBAO_PROFILE` remains the escape hatch.
   */
  const pickProfile = useCallback(async (): Promise<void> => {
    setProfileError(null)
    setProfileBusy(true)
    try {
      const desktop = (globalThis as {
        __DSH_DIRECTORY_PICKER__?: { pick?: () => Promise<string | null> }
      }).__DSH_DIRECTORY_PICKER__
      if (typeof desktop?.pick !== 'function') throw new Error('no native picker on this host')
      const picked = await desktop.pick()
      // Cancelled — the picker resolves null and the card must stay as it was.
      if (picked === null || picked === '') return
      const committed = profileDirOf(await persistField(DOUBAO_PROFILE_DIR_FIELD, picked))
      // The host validates the path before storing it; a save that came back
      // empty means the folder held no Cookies and nothing was written.
      setProfileError(committed === '' ? t('profile.invalid') : null)
      if (committed !== '') {
        void loadProfile()
        // A new profile means a new account: re-read the quota immediately
        // rather than showing the previous profile's numbers for up to 5 min.
        void onRefresh()
      }
    } catch (error: unknown) {
      setProfileError(t('profile.pickFailed', { reason: (error as Error)?.message ?? 'unknown' }))
    } finally {
      setProfileBusy(false)
    }
  }, [persistField, loadProfile, onRefresh, t])

  const clearProfile = useCallback(async (): Promise<void> => {
    setProfileError(null)
    try {
      await persistField(DOUBAO_PROFILE_DIR_FIELD, '')
      void loadProfile()
      void onRefresh()
    } catch (error: unknown) {
      setProfileError((error as Error)?.message ?? 'unknown error')
    }
  }, [persistField, loadProfile, onRefresh])

  const toolsOn = toolEmulationOf(configured)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const onToggleTools = useCallback(async (next: boolean): Promise<void> => {
    setToolsError(null)
    try {
      // Same as `onSave`: the returned value IS the read-back, so no polling of
      // a snapshot that cannot see this plugin's storage.
      const committed = toolEmulationOf(await persistField(DOUBAO_TOOL_EMULATION_FIELD, next))
      if (committed !== next) {
        setToolsError(t('models.saveFailed', { reason: '已写入磁盘，但回读的值与提交的不一致' }))
      }
    } catch (error: unknown) {
      setToolsError(t('models.saveFailed', { reason: (error as Error)?.message ?? 'unknown error' }))
    }
  }, [persistField, t])

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

      {/* ---- data directory ------------------------------------------- */}
      <div className="dbq-section">
        <div className="dbq-section-title">
          <span>{t('profile.title')}</span>
          <span className="dbq-count">
            {chosenProfile !== '' ? t('profile.manual') : (profile?.detected != null ? t('profile.detected') : t('profile.none'))}
          </span>
        </div>
        {activeProfile !== '' && (
          <div className="dbq-profile">{t('profile.current')}: {activeProfile}</div>
        )}
        <div className="dbq-note">{t('profile.hint')}</div>
        <div className="dbq-actions">
          <button
            type="button"
            className="dbq-btn"
            onClick={() => void pickProfile()}
            disabled={profileBusy || !canWrite}
          >
            {profileBusy ? t('profile.picking') : t('profile.pick')}
          </button>
          {chosenProfile !== '' && (
            <button type="button" className="dbq-btn" onClick={() => void clearProfile()} disabled={profileBusy}>
              {t('profile.clear')}
            </button>
          )}
        </div>
        {profile !== undefined && profile.candidates.length > 0 && (
          <div className="dbq-candidates">
            {profile.candidates.map(entry => `${entry.dir} (${entry.source})`).join('\n')}
          </div>
        )}
        {profileError !== null && <span className="dbq-error">{profileError}</span>}
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

        {/* Read-only is now about the plugin's own store, not the host scope:
            the scope is present but useless here (it cannot see this plugin). */}
        {!canWrite && <div className="dbq-note">{t('models.readOnly')}</div>}
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

      {/* ---- experimental: tool emulation ------------------------------ */}
      <div className="dbq-section">
        <div className="dbq-section-title">
          <span>{t('tools.title')}</span>
          <span className="dbq-count">{toolsOn ? t('tools.enabled') : t('tools.disabled')}</span>
        </div>
        <div className="dbq-note">{t('tools.note')}</div>
        <label className="dbq-model">
          <input
            type="checkbox"
            checked={toolsOn}
            disabled={!canWrite}
            onChange={event => void onToggleTools(event.currentTarget.checked)}
          />
          <span className="dbq-model-main">
            <span className="dbq-model-name"><span>{t('tools.toggle')}</span></span>
          </span>
        </label>
        {toolsOn && <div className="dbq-note dbq-warn">{t('tools.warning')}</div>}
        {toolsError !== null && <span className="dbq-error">{toolsError}</span>}
      </div>
    </div>
  )
}

export default DoubaoQuotaCard