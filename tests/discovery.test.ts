/**
 * The client-cache parser.
 *
 * The cache is V8 structured clone, and getting the encoding wrong is silent:
 * the first two attempts (skip-control-bytes heuristics) returned ZERO entries
 * on a cache that demonstrably contained them. So the encoding is pinned here
 * with synthetic bytes that mirror what was observed on disk, rather than by
 * reading the live cache — which belongs to another app and changes under us.
 */
import { describe, expect, it } from 'vitest'
import { parseCacheBuffer, TASK_MODE_PREFIX } from '../src/doubao-discovery.ts'

/** LEB128, as V8 serialization writes it. */
function varint(value: number): Buffer {
  const bytes: number[] = []
  let n = value
  for (;;) {
    let byte = n & 0x7f
    n >>>= 7
    if (n !== 0) byte |= 0x80
    bytes.push(byte)
    if (n === 0) break
  }
  return Buffer.from(bytes)
}

/** A one-byte (Latin-1) string: tag 0x22, byte length, payload. */
function strLatin1(value: string): Buffer {
  const payload = Buffer.from(value, 'latin1')
  return Buffer.concat([Buffer.from([0x22]), varint(payload.length), payload])
}

/**
 * A two-byte string: tag 0x63, then the BYTE count (measured: the cache writes
 * bytes here, not characters — treating it as characters reads exactly twice too
 * far and the name swallows the following field).
 */
function strUtf16(value: string): Buffer {
  const payload = Buffer.from(value, 'utf16le')
  return Buffer.concat([Buffer.from([0x63]), varint(payload.length), payload])
}

/** One `model_item_key: <key> … name: <name>` pair, with filler between. */
function entry(key: string, name: string, wide = true): Buffer {
  return Buffer.concat([
    Buffer.from('model_item_key'),
    strLatin1(key),
    Buffer.from([0x00, 0x7b, 0x00, 0x01]),          // 其它字段的占位字节
    strLatin1('name'),
    wide ? strUtf16(name) : strLatin1(name),
  ])
}

describe('parseCacheBuffer', () => {
  it('reads a UTF-16 model name without swallowing the next field', () => {
    const out = parseCacheBuffer(entry('5', '工作任务 Pro'))
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('5')
    expect(out[0].name).toBe('工作任务 Pro')
  })

  it('classifies a 工作任务-prefixed model as not offerable', () => {
    const out = parseCacheBuffer(entry('3', '豆包 2.1 Turbo'))
    expect(out[0].taskOnly).toBe(false)
    expect(parseCacheBuffer(entry('9', `${TASK_MODE_PREFIX} Auto`))[0].taskOnly).toBe(true)
  })

  it('also accepts a Latin-1 (ASCII) name', () => {
    // 0x22 carries one-byte strings; CJK names always arrive as 0x63. An ASCII
    // model label like "Auto" is the real-world case for this branch.
    const out = parseCacheBuffer(entry('9', 'Auto', false))
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('Auto')
  })

  it('reads several pairs from one buffer and keeps first-seen per key', () => {
    const buf = Buffer.concat([
      entry('0', '快速'),
      Buffer.from('junk junk junk'),
      entry('3', '豆包 2.1 Turbo'),
      entry('0', '重复的名字'),
    ])
    const out = parseCacheBuffer(buf)
    expect(out.map((e) => e.key)).toEqual(['0', '3'])
    expect(out[0].name).toBe('快速')
  })

  it('returns nothing for a buffer with no pairs, and never throws', () => {
    expect(parseCacheBuffer(Buffer.from(''))).toEqual([])
    expect(parseCacheBuffer(Buffer.from('model_item_key'))).toEqual([])
    expect(parseCacheBuffer(Buffer.alloc(64, 0xff))).toEqual([])
  })

  it('rejects a key that is not model-key shaped', () => {
    // An empty value (exactly what a message with no model carries) must not
    // produce an entry — a naive parser matches these and returns the NEXT
    // field's name as the model name.
    const buf = Buffer.concat([
      Buffer.from('model_item_key'),
      strLatin1(''),
      strLatin1('name'),
      strUtf16('豆包 2.1 Turbo'),
    ])
    expect(parseCacheBuffer(buf)).toEqual([])
  })

  it('rejects names that are really field names or URLs', () => {
    expect(parseCacheBuffer(entry('7', 'icon_url'))).toEqual([])
    expect(parseCacheBuffer(entry('7', 'https://example.com/x'))).toEqual([])
    expect(parseCacheBuffer(entry('7', '12345'))).toEqual([])
  })

  it('accepts the long person-* slugs Doubao added for third-party models', () => {
    // Regression: the key bound used to be 24 characters, which silently dropped
    // every `person-*` entry — the picker kept showing five legacy models while the
    // client already listed a dozen. Measured lengths: 21, 27, 32, 33, 37.
    const slugs = [
      'person-kimi-k3-261111',
      'person-kimi-k3-1-pro-261111',
      'person-glm-5-3-flash-261111',
      'person-deepseek-v4-pro-ga-260813',
      'person-deepseek-v4-1-flash-261017',
      'person-kimi-k3-1-pro-highspeed-261111',
    ]
    for (const slug of slugs) {
      expect(parseCacheBuffer(entry(slug, 'GLM 5.3'))[0]?.key).toBe(slug)
    }
  })

  it('still rejects a key that is not slug-shaped at all', () => {
    expect(parseCacheBuffer(entry('has space here', '豆包 快速'))).toEqual([])
    expect(parseCacheBuffer(entry('a'.repeat(65), '豆包 快速'))).toEqual([])
  })
})
