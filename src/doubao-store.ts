/**
 * The plugin's OWN settings file.
 *
 * Why this exists instead of the host settings service.
 *
 * The Loader hands `apply` a config object and the host can write it back with
 * `settings.mutate`, but on DSH 0.2.1 that whole path is closed to THIS plugin
 * for a reason we could not fix from the outside: the plugin's fiber never
 * reaches ACTIVE (it sits at state 1 = LOADING, next to `hmr`, `credentials` and
 * `skill-mcp-manager`), so `entry.fiber.runtime.Config` is never populated.
 * `ConfigEditor.entries()` keeps the row, `describe()` filters it out, and
 * `mutate()` fails with
 *
 *   No configurable plugin entry "dsh-connect-doubao"
 *
 * which the card surfaced as `保存失败：namespace … missing from describe()`.
 * The observable consequence is that EVERY settings write for this plugin has
 * always been dropped — including the ones a user made by hand — so the switch
 * could never persist, whatever the schema said.
 *
 * Rather than fight a lifecycle we do not control, the two switches live in a
 * file this plugin owns. That is strictly more reliable than the host path:
 * the write is synchronous, atomic (write-temp-then-rename), and the read does
 * not depend on any host service being up.
 *
 * Precedence: the file WINS over the config the Loader passes in, because the
 * file is the only place a write can land. A host config that disagrees is
 * ignored on purpose — trusting it would resurrect the silent-revert bug.
 *
 * @module dsh-connect-doubao/store
 */
import { readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ENABLED_MODEL_IDS_FIELD,
  TOOL_EMULATION_FIELD,
  enabledIdsOf,
  type DoubaoSettings,
} from './doubao-config.ts'

/** Absolute path of the settings file. Mirrors where the credential cache lives. */
export function settingsFilePath(): string {
  return join(homedir(), '.dsh', 'dsh-connect-doubao.settings.json')
}

/** The subset of a config blob this plugin can persist. */
function normalise(raw: unknown): Partial<DoubaoSettings> {
  const out: Partial<DoubaoSettings> = {}
  const ids = enabledIdsOf(raw)
  if (ids !== undefined) out.enabledModelIds = ids
  const tools = (raw as { toolEmulation?: unknown } | undefined)?.toolEmulation
  if (typeof tools === 'boolean') out.toolEmulation = tools
  return out
}

/**
 * Read the persisted settings, or `{}` when the file is missing or unusable.
 *
 * Never throws: a corrupt file must not stop the provider from registering, and
 * the caller treats "no file" and "bad file" identically — fall back to what
 * the Loader supplied.
 */
export function readStoredSettings(path: string = settingsFilePath()): Partial<DoubaoSettings> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  try {
    return normalise(JSON.parse(text) as unknown)
  } catch {
    return {}
  }
}

/**
 * Merge persisted settings over the Loader-supplied config.
 *
 * Only recognised keys are carried, so a hand-edited file cannot inject an
 * unknown field into the live config object.
 */
export function withStoredSettings(config: unknown, path: string = settingsFilePath()): DoubaoSettings {
  const base: DoubaoSettings = {
    enabledModelIds: enabledIdsOf(config) ?? [],
    toolEmulation: (config as { toolEmulation?: unknown } | undefined)?.toolEmulation === true,
  }
  const stored = readStoredSettings(path)
  return {
    enabledModelIds: stored.enabledModelIds ?? base.enabledModelIds,
    toolEmulation: stored.toolEmulation ?? base.toolEmulation,
  }
}

/**
 * Persist one field, atomically.
 *
 * Write-temp-then-rename rather than a direct write: a crash mid-write would
 * otherwise leave a truncated JSON file, and `readStoredSettings` would then
 * silently fall back to the Loader config — the exact "my setting vanished"
 * symptom this module exists to remove.
 */
export function writeStoredSetting(
  field: string,
  value: unknown,
  path: string = settingsFilePath(),
): void {
  if (field !== ENABLED_MODEL_IDS_FIELD && field !== TOOL_EMULATION_FIELD) {
    throw new Error(`field ${field} is not persistable`)
  }
  const next = { ...readStoredSettings(path) }
  if (field === ENABLED_MODEL_IDS_FIELD) {
    if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) {
      throw new Error(`invalid value for ${field}`)
    }
    next.enabledModelIds = value.filter((entry): entry is string => typeof entry === 'string')
  } else {
    if (typeof value !== 'boolean') throw new Error(`invalid value for ${field}`)
    next.toolEmulation = value
  }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid.toString()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
  } catch (error: unknown) {
    // A leftover temp file would accumulate on every failed save.
    try { unlinkSync(temp) } catch { /* already gone */ }
    throw error
  }
}
