/**
 * Discover the model list from the Doubao client's own cache.
 *
 * WHY THIS EXISTS. The catalog used to be a hardcoded list, so every time
 * Doubao shipped a model the plugin went stale until it was updated by hand.
 * The desktop app already receives that list from the server and persists it in
 * its IndexedDB (`menuConfV2`), so the honest source of truth is right there on
 * disk — read it instead of guessing.
 *
 * WHERE THE LIST COMES FROM, in priority order:
 *
 *   1. `Default/Preferences` -> `saman.local_storage_for_web['frontend-request-cache']`
 *      -> `_DesktopActionBarBriefListRequestCacheDataV1.data.modeSelectData`
 *      -> `menuConfV2.model_list.item_list[]`. Plain JSON, rewritten every time
 *      the app refreshes its menu. This is the PRIMARY source.
 *   2. The launcher / chat IndexedDB stores below, for installs whose
 *      Preferences has not been written yet. Older and usually stale, so it
 *      only fills gaps the Preferences list does not cover.
 *
 * WHAT THE INDEXEDDB CACHE CONTAINS. Values are V8 structured clones, not JSON:
 *
 *   string = tag + LEB128 length + payload
 *     0x22  Latin-1 payload, length is the byte count
 *     0x63  UTF-16LE payload, length is the BYTE count (measured: treating it as
 *           a character count reads exactly twice too far and the name swallows
 *           the following field's bytes)
 *
 * So parsing means reading the varint and slicing — skipping "control bytes and
 * hoping" produces zero hits, which is what the first two attempts did.
 *
 * VALIDATION. A discovered entry is only trusted when it looks like a model:
 * a short key matching `[\w-]+` and a name containing CJK or letters. Anything
 * else is dropped, and if nothing survives, {@link discoverModels} returns
 * undefined so the caller falls back to the static catalog. A malformed cache
 * must never empty the user's model picker.
 *
 * @module dsh-connect-doubao/discovery
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { findDoubaoUserDataDir } from './doubao-auth.ts'
import {
  DOUBAO_MODELS,
  DOUBAO_UNAVAILABLE_MODELS,
  DOUBAO_IMAGE_MODEL_ID,
  DOUBAO_IMAGE_MODEL_NAME,
  isTaskModel,
  supportsReasoning,
  type DoubaoModelInfo,
} from './doubao-catalog.ts'

/** How long a discovery result is reused before re-reading the cache. */
export const DISCOVERY_TTL_MS = 10 * 60 * 1000

/**
 * Names produced by the client for models that only exist inside 「工作任务」.
 *
 * The app prefixes them itself (「工作任务 Pro」, 「工作任务 Auto」), which is a
 * gift: the mode a model belongs to is legible straight out of the cache.
 *
 * The prefix no longer means "hidden": since 0.4.1 these entries are offered
 * with `taskMode: true` and are answered by the `tool_local` responder, so they
 * complete instead of failing with 710010702. Only entries listed in
 * `DOUBAO_UNAVAILABLE_MODELS` are withheld.
 */
export const TASK_MODE_PREFIX = '工作任务'

/**
 * IndexedDB stores that may hold the app's server-pushed config.
 *
 * `launcher` is the historical source and stops being written once the app has
 * completed a few launches (measured: its last write was 2026-09-17 while the
 * menu already listed a dozen models). `chat` is the store the running window
 * keeps current. Both are scanned and merged per key, so listing both can only
 * ever add models, never change an existing one.
 */
const CACHE_DB_DIRS = [
  'chrome_doubao-chat_0.indexeddb.leveldb',
  'chrome_doubao-launcher_0.indexeddb.leveldb',
]

export interface DiscoveredEntry {
  key: string
  name: string
  /** True when the client's own name marks it as a 工作任务-only model. */
  taskOnly: boolean
  /**
   * The mode the app files this model under: '1' = 对话, '3' = 工作任务.
   *
   * Only the Preferences source carries it, so it is optional. It matters: the
   * third-party models (DeepSeek / Kimi / GLM) arrive with a plain product name
   * and no 「工作任务」 prefix, so `taskOnly` alone would route them as ordinary
   * chat turns when the app itself runs them in task mode.
   */
  mode?: string
  /**
   * The menu's status tag: either a billing multiplier ("0.65x") or a campaign
   * label ("限时优惠 0.01x"). Only the Preferences source carries it.
   */
  rate?: { text: string; kind: 'ratio' | 'promo' }
  /**
   * The thinking levels this model offers, in the menu's own order.
   *
   * Only the Preferences source carries it, and it is PER MODEL: GLM publishes
   * 低/高/最高 while 2.1 Lite publishes 低/中/高, so a shared list is wrong for at
   * least one of them.
   */
  reasoningOptions?: Array<{ level: number; name: string }>
}

/** Read a LEB128 varint. Returns [value, nextOffset] or undefined. */
function readVarint(buf: Buffer, at: number): [number, number] | undefined {
  let result = 0
  let pos = at
  let bytes = 0
  for (;;) {
    if (pos >= buf.length) return undefined
    const byte: number | undefined = buf[pos]
    if (byte === undefined) return undefined
    result |= (byte & 0x7f) << (7 * bytes)
    pos += 1
    bytes += 1
    if ((byte & 0x80) === 0) break
    if (bytes > 4) return undefined
  }
  return [result >>> 0, pos]
}

/** Read a structured-clone string at `at`. Returns [value, nextOffset]. */
function readV8String(buf: Buffer, at: number): [string, number] | undefined {
  const tag = buf[at]
  const sized = readVarint(buf, at + 1)
  if (sized === undefined) return undefined
  const [length, dataAt] = sized
  const end = dataAt + length
  if (length <= 0 || end > buf.length) return undefined
  if (tag === 0x22) return [buf.subarray(dataAt, end).toString('latin1'), end]
  if (tag === 0x63) return [buf.subarray(dataAt, end).toString('utf16le'), end]
  return undefined
}

/** Find the `name` property following `from` and decode its value. */
function readNameAfter(buf: Buffer, from: number, to: number): string | undefined {
  for (let i = from; i < to - 6; i++) {
    if (buf[i] !== 0x22) continue
    const sized = readVarint(buf, i + 1)
    if (sized === undefined) continue
    const [length, dataAt] = sized
    if (length !== 4 || dataAt + 4 > buf.length) continue
    if (buf.subarray(dataAt, dataAt + 4).toString('latin1') !== 'name') continue
    const value = readV8String(buf, dataAt + 4)
    if (value === undefined) return undefined
    const [name, next] = value
    if (next > to) return undefined
    return name
  }
  return undefined
}

/**
 * A Doubao `model_item_key`: `0`/`3`/`5`/`9`, `seed-lite-7b`, or a third-party
 * slug such as `person-kimi-k3-1-pro-highspeed-261111` (37 characters).
 *
 * The bound used to be 24, which silently dropped every `person-*` model Doubao
 * added later: the picker kept showing five legacy entries while the client
 * already listed twelve. Keys are validated for SHAPE, not for length — the
 * server is the only authority on which keys exist.
 */
function looksLikeModelKey(value: string): boolean {
  return /^[\w.-]{1,64}$/.test(value)
}

function looksLikeModelName(value: string): boolean {
  if (value.length < 2 || value.length > 40) return false
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(value)) return false
  // Reject leftovers that are really field names or URLs bleeding through.
  return !/^[a-z_]+$/.test(value) && !value.includes('http')
}

/**
 * Parse one LevelDB value buffer for (key, name) pairs.
 *
 * Exported so the encoding can be unit-tested with synthetic bytes: the real
 * cache belongs to another app and moves whenever it updates, and a parser that
 * can only be exercised against it cannot be trusted to keep working.
 */
export function parseCacheBuffer(buf: Buffer): DiscoveredEntry[] {
  const out = new Map<string, DiscoveredEntry>()
  const KEY = Buffer.from('model_item_key')
  let at = -1
  while ((at = buf.indexOf(KEY, at + 1)) !== -1) {
    const keyRead = readV8String(buf, at + KEY.length)
    if (keyRead === undefined) continue
    const [key, afterKey] = keyRead
    if (!looksLikeModelKey(key)) continue
    const name = readNameAfter(buf, afterKey, Math.min(buf.length, afterKey + 220))
    if (name === undefined || !looksLikeModelName(name)) continue
    if (!out.has(key)) {
      out.set(key, { key, name, taskOnly: name.startsWith(TASK_MODE_PREFIX) })
    }
  }
  return [...out.values()]
}

/** Scan one LevelDB directory for (key, name) pairs. */
function scanDir(dir: string): Map<string, DiscoveredEntry> {
  const found = new Map<string, DiscoveredEntry>()
  let files: string[]
  try { files = readdirSync(dir) } catch { return found }
  for (const file of files) {
    if (!/\.(log|ldb)$/.test(file)) continue
    let buf: Buffer
    try { buf = readFileSync(join(dir, file)) } catch { continue }
    for (const entry of parseCacheBuffer(buf)) {
      if (!found.has(entry.key)) found.set(entry.key, entry)
    }
  }
  return found
}

/** Locate the launcher cache directory inside the Doubao profile. */
export function discoveryCacheDirs(): string[] {
  const userData = findDoubaoUserDataDir()
  if (userData === undefined) return []
  return CACHE_DB_DIRS
    .map((dir) => join(userData, 'Default', 'IndexedDB', dir))
    .filter((dir) => existsSync(dir))
}

/**
 * The model menu as the app last persisted it in its own Preferences file.
 *
 * This is the source that stays current: the IndexedDB stores are written by
 * whichever app window happens to be running and go stale, while Preferences is
 * rewritten every time the menu is refreshed. Shape, verbatim:
 *
 *   { saman: { local_storage_for_web: { 'frontend-request-cache': '<json>' } } }
 *     -> { _DesktopActionBarBriefListRequestCacheDataV1: { data: { modeSelectData:
 *          { menuConfV2: { model_list: { item_list: [ { model_item_key, name, … } ] } } } } } }
 *
 * Never throws: a missing/partial/rewritten Preferences just yields no entries
 * and the IndexedDB path (then the static catalog) takes over.
 */
/**
 * The menu tag as a rate, or undefined when there is none.
 *
 * Two shapes arrive in the same field: a plain multiplier ("0.65x", "1.44x") and
 * a campaign label that CONTAINS one ("限时优惠 0.01x"). Both are shown verbatim;
 * `kind` only decides how the card styles it, never what it claims.
 */
function rateOf(tagList: unknown): { text: string; kind: 'ratio' | 'promo' } | undefined {
  if (!Array.isArray(tagList)) return undefined
  for (const tag of tagList as Array<{ text?: unknown }>) {
    const text = typeof tag?.text === 'string' ? tag.text.trim() : ''
    if (text === '') continue
    return { text, kind: /^[\d.]+x$/i.test(text) ? 'ratio' : 'promo' }
  }
  return undefined
}

/**
 * A model's own thinking levels, or undefined when the menu declares none.
 *
 * `option_list` is the client's per-model ladder and it is NOT uniform: GLM ships
 * 低/高/最高 (3/5/7) while 2.1 Lite ships 低/中/高 (3/4/5). Reading it here is what
 * stops the picker from offering a level that model has no answer for.
 */
function reasoningOptionsOf(config: unknown): Array<{ level: number; name: string }> | undefined {
  const options = (config as { option_list?: unknown } | null | undefined)?.option_list
  if (!Array.isArray(options)) return undefined
  const out: Array<{ level: number; name: string }> = []
  for (const option of options as Array<{ level?: unknown; name?: unknown }>) {
    const level = typeof option?.level === 'number' ? option.level : undefined
    const name = typeof option?.name === 'string' ? option.name : undefined
    if (level === undefined || name === undefined || name === '') continue
    if (out.some((known) => known.level === level)) continue
    out.push({ level, name })
  }
  return out.length === 0 ? undefined : out
}

export function readPreferencesEntries(): DiscoveredEntry[] {
  const userData = findDoubaoUserDataDir()
  if (userData === undefined) return []
  let raw: string
  try {
    raw = readFileSync(join(userData, 'Default', 'Preferences'), 'utf8')
  } catch {
    return []
  }
  let cache: unknown
  try {
    const prefs = JSON.parse(raw) as {
      saman?: { local_storage_for_web?: Record<string, unknown> }
    }
    const bucket = prefs.saman?.local_storage_for_web?.['frontend-request-cache']
    if (typeof bucket !== 'string') return []
    cache = JSON.parse(bucket)
  } catch {
    return []
  }
  // The cache key carries a schema version in its name; matching on the stable
  // stem keeps this working across a bump instead of silently reading nothing.
  const root = cache as Record<string, unknown> | null
  if (root === null || typeof root !== 'object') return []
  const cacheKey = Object.keys(root).find((key) => key.includes('BriefListRequestCache'))
  if (cacheKey === undefined) return []
  const entry = root[cacheKey] as
    | { data?: { modeSelectData?: { menuConfV2?: { model_list?: { item_list?: unknown } } } } }
    | undefined
  const items = entry?.data?.modeSelectData?.menuConfV2?.model_list?.item_list
  if (!Array.isArray(items)) return []
  const out: DiscoveredEntry[] = []
  for (const item of items as Array<{
    model_item_key?: unknown
    name?: unknown
    default_mode?: unknown
    tag_list?: unknown
    reasoning_effort_config?: unknown
  }>) {
    const key = typeof item?.model_item_key === 'string' ? item.model_item_key : undefined
    const name = typeof item?.name === 'string' ? item.name : undefined
    if (key === undefined || name === undefined) continue
    if (!looksLikeModelKey(key) || !looksLikeModelName(name)) continue
    if (out.some((known) => known.key === key)) continue
    const mode = typeof item.default_mode === 'string' ? item.default_mode : undefined
    const rate = rateOf(item.tag_list)
    const reasoningOptions = reasoningOptionsOf(item.reasoning_effort_config)
    out.push({
      key,
      name,
      taskOnly: name.startsWith(TASK_MODE_PREFIX) || mode === '3',
      ...(mode === undefined ? {} : { mode }),
      ...(rate === undefined ? {} : { rate }),
      ...(reasoningOptions === undefined ? {} : { reasoningOptions }),
    })
  }
  return out
}

/**
 * All (key, name) pairs the client currently knows, task-only ones included.
 *
 * Exported for the diagnostics path — it is the raw view, useful when a model
 * shows up in the app but not in DSH and the question is "did we not see it, or
 * did we see it and classify it away".
 */
export function discoverAllCachedModels(): DiscoveredEntry[] {
  const merged = new Map<string, DiscoveredEntry>()
  // Preferences first: when both sources know a key, its entry is the newer one.
  for (const entry of readPreferencesEntries()) {
    if (!merged.has(entry.key)) merged.set(entry.key, entry)
  }
  for (const dir of discoveryCacheDirs()) {
    for (const [key, entry] of scanDir(dir)) {
      if (!merged.has(key)) merged.set(key, entry)
    }
  }
  return [...merged.values()]
}

/**
 * The models DSH may offer: everything the client lists that is NOT task-only,
 * plus the image-generation alias.
 *
 * Returns undefined when the cache yielded nothing usable, so the caller keeps
 * the static catalog. Names are taken verbatim from the client, which is the
 * whole point: when Doubao renames or adds a chat model, it shows up here
 * without a plugin release.
 */
export function discoverModels(now = Date.now()): DoubaoModelInfo[] | undefined {
  const all = discoverAllCachedModels()
  const unavailableIds = new Set(DOUBAO_UNAVAILABLE_MODELS.map((m) => m.id))
  const usable = all.filter(
    (entry) => !unavailableIds.has(entry.key) && entry.key !== DOUBAO_IMAGE_MODEL_ID,
  )
  if (usable.length === 0) return undefined
  const seenKeys = new Set(usable.map((e) => e.key))
  const models: DoubaoModelInfo[] = usable
    // Stable order: numeric keys ascending, slugs after, so a rescan cannot
    // shuffle the picker between two identical states.
    .sort((a, b) => {
      const an = Number(a.key), bn = Number(b.key)
      const aNum = Number.isFinite(an), bNum = Number.isFinite(bn)
      if (aNum && bNum) return an - bn
      if (aNum) return -1
      if (bNum) return 1
      return a.key.localeCompare(b.key)
    })
    .map((entry) => {
      const staticMatch = DOUBAO_MODELS.find((m) => m.id === entry.key)
      const taskMode = entry.taskOnly || isTaskModel(entry.key)
      // A discovered task model has no static badge to inherit, and its name is a
      // plain product name (「GLM 5.3」, not 「工作任务 GLM 5.3」) — without this the
      // card would render it as an ordinary chat entry while it runs in task mode.
      const badge = staticMatch?.badge ?? (taskMode ? TASK_MODE_PREFIX : undefined)
      return {
        id: entry.key,
        name: staticMatch?.name ?? entry.name,
        ...(badge !== undefined ? { badge } : {}),
        // The menu dump flags every entry as reasoning-capable; whether it can
        // actually think is a measurement, not a menu property.
        reasoning: supportsReasoning(entry.key),
        ...(taskMode ? { taskMode: true } : {}),
        // Both come from the menu, and both are per-model: the multiplier the app
        // shows beside the name, and the ladder it offers for THIS model.
        ...(entry.rate !== undefined ? { rate: entry.rate } : {}),
        ...(entry.reasoningOptions !== undefined ? { reasoningOptions: entry.reasoningOptions } : {}),
      }
    })
  // Ensure static task-mode models (seed-lite-7b, 5, 9) are always present even
  // if the local IndexedDB only cached the chat-mode subset.
  for (const staticModel of DOUBAO_MODELS) {
    if (staticModel.id === DOUBAO_IMAGE_MODEL_ID) continue
    if (!seenKeys.has(staticModel.id)) {
      models.push({ ...staticModel })
    }
  }
  models.push({ id: DOUBAO_IMAGE_MODEL_ID, name: DOUBAO_IMAGE_MODEL_NAME, reasoning: true })
  void now
  return models
}

/** Fallback used whenever discovery is unavailable. */
export function staticModels(): DoubaoModelInfo[] {
  return [...DOUBAO_MODELS]
}

let memo: { at: number; models: DoubaoModelInfo[] } | undefined

/**
 * The catalog to use right now: discovered models when the cache yields them,
 * otherwise the static list, re-read at most once per {@link DISCOVERY_TTL_MS}.
 *
 * Every consumer (picker, adapter, card) goes through this one function so the
 * three views can never disagree about which models exist.
 */
export function liveModels(now = Date.now()): DoubaoModelInfo[] {
  if (memo !== undefined && now - memo.at < DISCOVERY_TTL_MS) return memo.models
  const models = discoverModels(now) ?? staticModels()
  memo = { at: now, models }
  return models
}

/** Forget the memo — used by the card's refresh and by tests. */
export function invalidateDiscovery(): void {
  memo = undefined
}
