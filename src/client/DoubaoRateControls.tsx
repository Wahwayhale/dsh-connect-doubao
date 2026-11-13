/**
 * Composer model-selector multiplier controls for Doubao models.
 *
 * Contributes to two DSH composer slots:
 *  - `conversation.input.model.label`: adds each model's billing multiplier /
 *    promo pill inside the model picker rows (`option` and `menu` placements)
 *    while preserving host badge/name rendering for all non-Doubao providers.
 *  - `conversation.input.right`: renders an interactive multiplier pill right
 *    beside the model selector trigger when a Doubao model is active, opening
 *    a portal popover with the full model multiplier table and refresh action.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DoubaoModelEntry, DoubaoRateTag } from './contract.ts'
import type { Translate } from './locales.ts'
import { DOUBAO_CARD_CSS } from './styles.ts'
import {
  findCatalogModelEntry,
  isDoubaoProviderId,
  recordObservedTriggerModel,
  refreshDoubaoCatalog,
  resolveClientText,
  useDoubaoCatalog,
  useObservedTriggerModel,
} from './DoubaoCatalogStore.ts'

export const STYLE_ELEMENT_ID = 'dsh-connect-doubao-styles'

/** Ensure plugin CSS is present in `<head>` even before Settings is opened. */
export function ensureDoubaoStyles(): void {
  if (typeof document === 'undefined' || !document.head) return
  let existing = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null
  if (existing === null) {
    existing = document.createElement('style')
    existing.id = STYLE_ELEMENT_ID
    document.head.appendChild(existing)
  }
  if (existing.textContent !== DOUBAO_CARD_CSS) {
    existing.textContent = DOUBAO_CARD_CSS
  }
}

export interface HostModelBadge {
  text: unknown
  tone?: string
}

export interface HostModelDescriptor {
  id: string
  name: string
  badge?: HostModelBadge
}

export interface ModelLabelSlotProps {
  provider: { id: string; name: string }
  model: HostModelDescriptor
  placement: 'trigger' | 'menu' | 'option'
  selected: boolean
  sessionId?: string | undefined
  t: Translate
  resolveText?: ((text: unknown) => string) | undefined
}

export interface ModelSelectionProjection {
  next?: { provider: string; model: string; reasoningEffort?: string } | undefined
  lastUsed?: { provider: string; model: string; reasoningEffort?: string } | undefined
}

export interface ComposerRightSlotProps {
  sessionId?: string | undefined
  useProjection?: ((key: 'modelSelection') => ModelSelectionProjection | undefined) | undefined
  t: Translate
}

function RatePill({ rate, tooltip }: { rate: DoubaoRateTag; tooltip?: string | undefined }) {
  return (
    <span
      className={rate.kind === 'promo' ? 'dbq-picker-rate dbq-picker-rate-promo' : 'dbq-picker-rate'}
      {...(tooltip !== undefined ? { title: tooltip } : {})}
    >
      {rate.text}
    </span>
  )
}

function HostBadge({
  badge,
  resolveText,
}: {
  badge: HostModelBadge
  resolveText?: ((text: unknown) => string) | undefined
}) {
  const label = resolveClientText(badge.text, resolveText)
  if (label === '') return null
  return (
    <span className="dbq-host-badge" data-tone={badge.tone ?? 'neutral'}>
      {label}
    </span>
  )
}

/**
 * Custom model label rendered inside DSH's `conversation.input.model.label`.
 *
 * Non-Doubao providers keep the exact host badge+name presentation so
 * replacing the single slot never alters other providers' appearance.
 */
export function DoubaoModelOptionLabel({
  provider,
  model,
  placement,
  sessionId,
  t,
  resolveText,
}: ModelLabelSlotProps) {
  const isDoubao = isDoubaoProviderId(provider.id)
  const catalog = useDoubaoCatalog()

  useEffect(() => {
    ensureDoubaoStyles()
  }, [])

  useEffect(() => {
    if (placement === 'trigger') {
      recordObservedTriggerModel(sessionId, { provider: provider.id, model: model.id })
    }
  }, [placement, sessionId, provider.id, model.id])

  if (!isDoubao) {
    if (model.badge === undefined) return <>{model.name}</>
    return (
      <span className="dbq-host-badged">
        {placement === 'trigger' ? (
          <>
            <HostBadge badge={model.badge} resolveText={resolveText} />{' '}
          </>
        ) : null}
        <span className="dbq-host-badged-text">{model.name}</span>
        {placement === 'trigger' ? null : (
          <>
            {' '}
            <HostBadge badge={model.badge} resolveText={resolveText} />
          </>
        )}
      </span>
    )
  }

  // Keep the composer trigger clean: `DoubaoComposerRateControl` right beside
  // it displays the active multiplier + opens the interactive comparison panel.
  if (placement === 'trigger') {
    return (
      <span className="dbq-picker-label">
        <span className="dbq-picker-name">{model.name}</span>
      </span>
    )
  }

  const entry = findCatalogModelEntry(catalog, model.id)
  const rate = entry?.rate ?? null

  return (
    <span className="dbq-picker-label" data-placement={placement}>
      <span className="dbq-picker-name">{model.name}</span>
      {model.badge !== undefined && <HostBadge badge={model.badge} resolveText={resolveText} />}
      {rate !== null && <RatePill rate={rate} tooltip={t('picker.rateTooltip')} />}
    </span>
  )
}

interface PopoverCoords {
  bottom: number
  right: number
}

function computePopoverCoords(anchor: HTMLElement | null): PopoverCoords {
  if (anchor === null || typeof window === 'undefined') {
    return { bottom: 64, right: 16 }
  }
  const rect = anchor.getBoundingClientRect()
  const right = Math.max(12, Math.round(window.innerWidth - rect.right))
  const bottom = Math.max(12, Math.round(window.innerHeight - rect.top + 8))
  return { bottom, right }
}

/**
 * Interactive multiplier control placed in `conversation.input.right`
 * directly adjacent to the dialog model selector button.
 */
export function DoubaoComposerRateControl({
  sessionId,
  useProjection,
  t,
}: ComposerRightSlotProps) {
  const projected = useProjection?.('modelSelection')
  const observed = useObservedTriggerModel(sessionId)
  const selection = projected?.next ?? projected?.lastUsed ?? observed
  const isDoubao = isDoubaoProviderId(selection?.provider)

  const catalog = useDoubaoCatalog()
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [coords, setCoords] = useState<PopoverCoords>({ bottom: 64, right: 16 })
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ensureDoubaoStyles()
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    setCoords(computePopoverCoords(rootRef.current))
    const reposition = () => setCoords(computePopoverCoords(rootRef.current))
    window.addEventListener('resize', reposition)
    return () => window.removeEventListener('resize', reposition)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null
      if (target === null) return
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!isDoubao) return null

  const activeModelId = selection?.model
  const activeEntry = findCatalogModelEntry(catalog, activeModelId)
  const activeRate = activeEntry?.rate ?? null
  const pillText = activeRate !== null
    ? t('picker.controlLabel', { rate: activeRate.text })
    : t('picker.controlUnknown')
  const ariaLabel = t('picker.controlAria', {
    rate: activeRate?.text ?? t('picker.rateUnavailable'),
  })

  const models: DoubaoModelEntry[] = catalog?.ok === true ? catalog.models : []

  const onRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshDoubaoCatalog(true)
    } finally {
      setRefreshing(false)
    }
  }

  const popover = open ? (
    <div
      ref={panelRef}
      className="dbq-rate-popover"
      role="dialog"
      aria-label={t('picker.popoverTitle')}
      style={{ bottom: `${coords.bottom}px`, right: `${coords.right}px` }}
      onMouseDown={(event) => {
        if (event.target instanceof Element && event.target.closest('button') !== null) {
          event.preventDefault()
        }
      }}
    >
      <div className="dbq-rate-popover-head">
        <span className="dbq-rate-popover-title">{t('picker.popoverTitle')}</span>
        <button
          type="button"
          className="dbq-rate-popover-refresh"
          onClick={() => void onRefresh()}
          disabled={refreshing}
        >
          {refreshing ? t('picker.refreshing') : t('picker.refresh')}
        </button>
      </div>

      {models.length === 0 ? (
        <div className="dbq-rate-popover-empty">{t('picker.empty')}</div>
      ) : (
        <div className="dbq-rate-popover-list">
          {models.map((entry) => {
            const current = activeEntry?.id === entry.id || entry.id === activeModelId
            return (
              <div
                key={entry.id}
                className={current ? 'dbq-rate-popover-row dbq-rate-popover-row-active' : 'dbq-rate-popover-row'}
                data-active={current ? 'true' : undefined}
              >
                <span className="dbq-rate-popover-model">
                  <span className="dbq-rate-popover-name">{entry.name}</span>
                  {entry.badge !== null && <span className="dbq-badge">{entry.badge}</span>}
                  {current && <span className="dbq-rate-current-tag">{t('picker.currentBadge')}</span>}
                </span>
                {entry.rate !== null ? (
                  <RatePill rate={entry.rate} />
                ) : (
                  <span className="dbq-rate-popover-missing">{t('picker.rateUnavailable')}</span>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="dbq-rate-popover-note">{t('models.rateNote')}</div>
    </div>
  ) : null

  return (
    <div ref={rootRef} className="dbq-rate-control">
      <button
        type="button"
        className={`dbq-rate-trigger${activeRate?.kind === 'promo' ? ' dbq-rate-trigger-promo' : ''}${open ? ' dbq-rate-trigger-open' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={ariaLabel}
        title={t('picker.rateTooltip')}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="dbq-rate-trigger-text">{pillText}</span>
        <span className="dbq-rate-trigger-caret" aria-hidden="true">▾</span>
      </button>
      {popover !== null && (typeof document !== 'undefined' && document.body
        ? createPortal(popover, document.body)
        : popover)}
    </div>
  )
}
