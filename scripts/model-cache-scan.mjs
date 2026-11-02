// 精确解析豆包客户端 IndexedDB 缓存里的 (model_item_key, name) 配对。
//
// 缓存值是 V8 structured clone：
//   字符串 = 标签 + LEB128 长度 + 数据
//     0x22 (')  → Latin-1，长度是字节数
//     0x63 ('c') → UTF-16LE，长度是字符数（中文名走这条）
//   对象属性名同样是上面这种字符串，所以 "name" 之前会有 0x22 0x04。
//
// 之前两次宽松扫描全部 0 命中，就是因为把长度字节当成可打印字符跳过了 ——
// 必须按 varint 读长度再切片，不能靠"跳过控制字节"猜。
import { readFileSync, readdirSync } from 'node:fs'

const DB = process.env.DSH_DOUBAO_CACHE_DIR ||
  process.env.LOCALAPPDATA + '/Doubao/User Data/Default/IndexedDB/chrome_doubao-launcher_0.indexeddb.leveldb'

/** 读 LEB128 varint，返回 [值, 下一个字节的位置]。 */
function varint(buf, at) {
  let result = 0, shift = 128n === 0 ? 0 : 0, pos = at, bytes = 0
  for (;;) {
    if (pos >= buf.length) return undefined
    const byte = buf[pos]
    result |= (byte & 0x7f) << (7 * bytes)
    pos++
    bytes++
    if ((byte & 0x80) === 0) break
    if (bytes > 4) return undefined
  }
  return [result >>> 0, pos]
}

/** 在 at 处解析一个字符串，返回 [值, 下一个字节的位置]。 */
function readV8String(buf, at) {
  const tag = buf[at]
  const lenAt = at + 1
  const v = varint(buf, lenAt)
  if (v === undefined) return undefined
  const [length, dataAt] = v
  if (tag === 0x22) {
    const end = dataAt + length
    if (end > buf.length) return undefined
    return [buf.subarray(dataAt, end).toString('latin1'), end]
  }
  if (tag === 0x63) {
    // 实测这里的长度字段是**字节数**而非字符数（按字符数会正好读多一倍，
    // 名字尾巴会吃掉后续字段的字节：「豆包 2.1 Turbo」后面跟一串乱码）。
    const end = dataAt + length
    if (end > buf.length) return undefined
    return [buf.subarray(dataAt, end).toString('utf16le'), end]
  }
  return undefined
}

/** 从 at 起在 window 内找属性名 `name` 并解出它的字符串值。 */
function findNameValue(buf, from, to) {
  for (let i = from; i < to - 6; i++) {
    if (buf[i] !== 0x22) continue
    const v = varint(buf, i + 1)
    if (v === undefined) continue
    const [len, dataAt] = v
    if (len !== 4 || dataAt + 4 > buf.length) continue
    if (buf.subarray(dataAt, dataAt + 4).toString('latin1') !== 'name') continue
    const s = readV8String(buf, dataAt + 4)
    if (s === undefined) continue
    const [value, next] = s
    if (next > to) continue
    return value
  }
  return undefined
}

const KEY = Buffer.from('model_item_key')
const out = new Map()
let scanned = 0

for (const f of readdirSync(DB)) {
  if (!/\.(log|ldb)$/.test(f)) continue
  let buf
  try { buf = readFileSync(DB + '/' + f) } catch { continue }
  let at = -1
  while ((at = buf.indexOf(KEY, at + 1)) !== -1) {
    scanned++
    const s = readV8String(buf, at + KEY.length)
    if (s === undefined) continue
    const [key, afterKey] = s
    if (!/^[\w-]{1,24}$/.test(key)) continue
    const name = findNameValue(buf, afterKey, Math.min(buf.length, afterKey + 220))
    if (!name || name.length < 2) continue
    if (!/[\u4e00-\u9fa5A-Za-z]/.test(name)) continue
    if (!out.has(key)) out.set(key, { key, name, file: f })
  }
}

console.log(`扫到 ${scanned} 处 model_item_key，解析出 ${out.size} 个候选：`)
for (const { key, name, file } of [...out.values()]) {
  console.log(`  ${key.padEnd(14)} ${JSON.stringify(name)}   (${file})`)
}
