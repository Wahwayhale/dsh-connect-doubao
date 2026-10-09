/**
 * Browser half: the Doubao quota + model card inside Plugin configuration.
 *
 * Registration shape follows the reference connectors (`slots` / `locale`
 * injection, `name`/`key`/`priority` slot registration, and a per-slot try/catch
 * so an API change degrades to a console error instead of the host's red
 * "Failed to load plugins" banner).
 *
 * The `inject` list is deliberately ONLY the two services every host line
 * provides. Cordis' dependency gate is hard: naming a service this host does not
 * provide stops `apply` from ever running, so the settings surface is probed
 * softly through `ctx.get()` instead — see below.
 *
 * @module dsh-connect-doubao/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only side-effect imports: these modules augment Cordis' `LocaleNamespaceMap`
// and declare the `slots` / `locale` services. Whichever host line ships them
// supplies the augmentation; they are never imported at runtime.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DoubaoQuotaCard } from './DoubaoQuotaCard.tsx'
import type { DoubaoCardInjected } from './DoubaoQuotaCard.tsx'
import { NAMESPACE, en, zh, translator } from './locales.ts'
import type { DoubaoCardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Doubao plugin card copy. */
    'settings.doubao': DoubaoCardKey
  }
}

/** The client services this entry requires. Both exist on every host line. */
export type DoubaoClientContext = Context & {
  slots: Context['slots']
  locale: Context['locale']
}

/** Stable browser-plugin name. */
export const name = 'dsh-connect-doubao-client'

/** Only the universally available seats; see the module note on the gate. */
export const inject = ['slots', 'locale']

/**
 * Register the card copy and the card itself under Plugin configuration.
 *
 * Everything is inside try/catch at two levels: the whole body, and each slot
 * registration individually. A card that cannot render must never take down the
 * page — the host provider still serves models without it.
 */
export function apply(ctx: DoubaoClientContext): void {
  try {
    ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'dsh-connect-doubao: card copy')
    const t = ctx.locale.bind(NAMESPACE) as DoubaoCardInjected['t']

    /**
     * Soft service probe.
     *
     * Reading an undeclared service property THROWS ("cannot get property X
     * without inject") — `?.` guards null/undefined, not a throwing getter — so
     * the settings seat must be reached through `ctx.get()`, which returns
     * `undefined` for an absent service instead.
     */
    const softGet = (name: string): unknown =>
      (ctx as unknown as { get(name: string): unknown }).get(name)

    let settingsScope: DoubaoCardInjected['settingsScope'] | undefined
    const forms = softGet('configForms') as
      | {
          describe(): { getSnapshot(): { view?: { namespaces?: { ns: string }[] } } }
          get(ns: string): DoubaoCardInjected['settingsScope']
        }
      | undefined
    if (forms !== undefined) {
      // The namespace the Host actually serves is host-chosen: the profile patch
      // may mount this bundle as `dsh-connect-doubao` or, as the live Desktop
      // host does, as an include. ASK the mirror rather than guessing — the Host
      // resolves a provider's namespace by exact match, so a wrong guess binds
      // the card to a namespace nothing serves and the write path is dead.
      let ns = 'dsh-connect-doubao'
      try {
        const namespaces = forms.describe().getSnapshot().view?.namespaces ?? []
        const served = namespaces.find(entry => entry.ns === ns || /doubao/i.test(entry.ns))
        if (served !== undefined) ns = served.ns
      } catch {
        // Mirror not populated yet: the declared id is still correct.
      }
      settingsScope = forms.get(ns)
    }

    const registerCard = (slotName: string, key: string): void => {
      try {
        ctx.slots.inject(slotName as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; key: string; priority: number; inject: () => DoubaoCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: slotName,
          key,
          priority: 30,
          // `inject` supplies PROPS, it does not import anything. The card is
          // written to work with `t` alone, so a host without the settings seat
          // still renders a working read-only card.
          inject: () => settingsScope === undefined
            ? { t }
            : { t, settingsScope },
        }, DoubaoQuotaCard))
      } catch (error: unknown) {
        // Isolated per slot: a failed registration must not take the other down.
        console.error(`[dsh-connect-doubao] card slot "${slotName}" failed to register (host provider unaffected):`, error)
      }
    }

    registerCard('plugins.bundle.config', 'dsh-connect-doubao')
    registerCard('plugins.row.config', 'dsh-connect-doubao#dsh-connect-doubao')

    /**
     * Top-level entry in the SETTINGS LEFT-HAND NAV — the surface the user
     * asked for.
     *
     * WHY THIS SLOT, AND WHERE THE NAME CAME FROM
     * ------------------------------------------
     * `settings.section` is the host's own settings-nav row slot, declared by
     * `@deepseek-ai/dsh-client-ui-settings-general`, whose `SettingsRoot`
     * renders exactly what the user's screenshot shows:
     *
     *   nav list : [navIcon(row.id), <span className="navLabel">{row.label}</span>]
     *   content : renderSlot("settings.section", { close: onClose }, { only: active })
     *
     * `only: active` is the important half: the host mounts ONLY the section the
     * user clicked, so our card is not rendered until its row is selected.
     *
     * The descriptor fields are `id` / `order` / `label` / `inject` — NOT the
     * `key` / `priority` pair the `plugins.*` slots use. Transcribed from two
     * plugins that provably appear in that nav:
     *
     *   - `@yangdcm/dsh-expert-team` ("专家团"):
     *       ctx.slots.inject('settings.section', () => ctx.slots.register({
     *         name: 'settings.section', id: 'expert-team', order: 50,
     *         label: () => t('专家团', 'Expert team') }, wrap(SettingsSection)))
     *   - `dsh-better-sidebar` ("侧边卡片"): same shape, `order: 100`.
     *
     * `dsh-better-sidebar` also documents the host's limits: "DSH 0.1.x projects
     * only `id`, `order`, and `label` from a `settings.section` registration"
     * — there is no icon field, so the host draws a generic gear for plugin rows.
     *
     * `ctx.slots.inject` waits for the host's DECLARATION of the slot, so on a
     * host that does not ship the settings shell this simply never attaches and
     * everything else keeps working.
     *
     * `order: 40` places 豆包 above 专家团's 50 and below the shell's own sections,
     * matching the position the user asked for in the list.
     */
    const registerSettingsSection = (): void => {
      try {
        ctx.slots.inject('settings.section' as never, () => (ctx.slots as unknown as {
          register(
            options: {
              name: string
              id: string
              order: number
              label: () => string
              inject?: () => DoubaoCardInjected
            },
            component: unknown,
          ): () => void
        }).register({
          name: 'settings.section',
          id: 'dsh-connect-doubao',
          order: 40,
          label: () => t('card.navLabel'),
          inject: () => settingsScope === undefined
            ? { t }
            : { t, settingsScope },
        }, DoubaoQuotaCard))
      } catch (error: unknown) {
        console.error('[dsh-connect-doubao] settings.section failed to register (host provider unaffected):', error)
      }
    }

    registerSettingsSection()
  } catch (error: unknown) {
    // Degrade silently on the page; developers see the cause in the console.
    console.error('[dsh-connect-doubao] client card failed to load (host provider unaffected):', error)
  }
}

export { DoubaoQuotaCard } from './DoubaoQuotaCard.tsx'
export { en, zh, translator } from './locales.ts'