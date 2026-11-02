/**
 * Discover the model list from the Doubao client's own cache.
 *
 * WHY THIS EXISTS. The catalog used to be a hardcoded list, so every time
 * Doubao shipped a model the plugin went stale until it was updated by hand.
 * The desktop app already receives that list from the server and persists it in
 * its IndexedDB (`menuConfV2`), so the honest source of truth is right there on
 * disk — read it instead of guessing.
 *
 * WHAT THE CACHE ACTUALLY CONTAINS. Values are V8 structured clones, not JSON:
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
  DOUBAO_IMAGE_MODEL_ID,
  DOUBAO_IMAGE_MODEL_NAME,
  type DoubaoModelInfo,
} from './doubao-catalog.ts'

/** How long a discovery result is reused before re-reading the cache. */
export const DISCOVERY_TTL_MS = 10 * 60 * 1000

/**
 * Names produced by the client for models that only exist inside 「工作任务」.
 *
 * The app prefixes them itself (「工作任务 Pro」, 「工作任务 Auto」), which is a
 * gift: the mode a model belongs to is legible straight out of the cache, so
 * the plugin can hide exactly the entries that would fail with 710010702.
 */
export const TASK_MODE_PREFIX = '工作任务'

/** IndexedDB store that holds the app's server-pushed config. */
const CACHE_DB_DIRS = ['chrome_doubao-launcher_0.indexeddb.leveldb']

export interface DiscoveredEntry {
  key: string
  name: string
  /** True when the client's own name marks it as a 工作任务-only model. */
  taskOnly: boolean
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

function looksLikeModelKey(value: string): boolean {
  return /^[\w-]{1,24}$/.test(value)
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
 * All (key, name) pairs the client currently knows, task-only ones included.
 *
 * Exported for the diagnostics path — it is the raw view, useful when a model
 * shows up in the app but not in DSH and the question is "did we not see it, or
 * did we see it and classify it away".
 */
export function discoverAllCachedModels(): DiscoveredEntry[] {
  const merged = new Map<string, DiscoveredEntry>()
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
  const usable = all.filter((entry) => !entry.taskOnly && entry.key !== DOUBAO_IMAGE_MODEL_ID)
  if (usable.length === 0) return undefined
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
    .map((entry) => ({ id: entry.key, name: entry.name, reasoning: true }))
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
