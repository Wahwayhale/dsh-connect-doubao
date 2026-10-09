// Read an Electron .asar archive's index without unpacking it.
//
// asar header framing (all uint32 LE):
//   [0..4)   size of the remaining header pickle payload
//   [4..8)   header pickle: [u32 jsonLen][json bytes padded to 4]
// The first number counts the 4-byte jsonLen plus the padded JSON, so
//   headerPickleSize = u32@4
//   json             = bytes[8, 8 + jsonLen)
//   dataStart        = 8 + headerPickleSize
// Offsets in the header JSON are relative to dataStart.
import { openSync, readSync, closeSync, statSync } from 'node:fs'

const target = process.argv[2]
const filter = process.argv[3] ? new RegExp(process.argv[3], 'i') : null

const archiveSize = statSync(target).size
const fd = openSync(target, 'r')
const pre = Buffer.alloc(16)
readSync(fd, pre, 0, 16, 0)
const headerPickleSize = pre.readUInt32LE(4)
const jsonLen = pre.readUInt32LE(8)

if (headerPickleSize <= 0 || headerPickleSize > archiveSize) {
  console.error(`implausible headerPickleSize=${headerPickleSize} (archive=${archiveSize})`)
  closeSync(fd)
  process.exit(1)
}

const buf = Buffer.alloc(jsonLen)
readSync(fd, buf, 0, jsonLen, 12)
let header
try {
  header = JSON.parse(buf.toString('utf8'))
} catch (err) {
  console.error(`header JSON parse failed (jsonLen=${jsonLen}): ${err.message}`)
  closeSync(fd)
  process.exit(1)
}
const dataStart = 12 + jsonLen

const files = []
function walk(node, prefix) {
  if (!node?.files) return
  for (const [name, child] of Object.entries(node.files)) {
    const p = prefix ? `${prefix}/${name}` : name
    if (child.files) walk(child, p)
    else files.push({ path: p, size: child.size, offset: Number(child.offset) })
  }
}
walk(header, '')

const matched = filter ? files.filter((f) => filter.test(f.path)) : files
console.log(`archive: ${target}`)
console.log(`header: jsonLen=${jsonLen} dataStart=${dataStart}`)
console.log(`total files: ${files.length}, matched: ${matched.length}`)
for (const f of matched.slice(0, 500)) console.log(`${String(f.size).padStart(10)}  ${f.path}`)
if (matched.length > 500) console.log(`... ${matched.length - 500} more`)

// Verify the framing by reading one file back and checking it looks like JSON.
const probe = files.find((f) => /package\.json$/.test(f.path))
if (probe) {
  const end = dataStart + probe.offset + probe.size
  const sane = end <= archiveSize && probe.size > 0 && probe.size < 5_000_000
  console.log(`\nself-check probe: ${probe.path} end=${end} archiveSize=${archiveSize} ${sane ? 'IN-BOUNDS' : 'OUT-OF-BOUNDS'}`)
  if (sane) {
    const d = Buffer.alloc(probe.size)
    readSync(fd, d, 0, probe.size, dataStart + probe.offset)
    try {
      JSON.parse(d.toString('utf8'))
      console.log('self-check: probe parsed as JSON -> framing OK')
    } catch {
      console.log('self-check: probe NOT valid JSON -> framing WRONG')
    }
  }
}
closeSync(fd)