// Extract a single file's bytes out of an Electron .asar archive.
import { openSync, readSync, closeSync } from 'node:fs'

const [, , archive, filePath] = process.argv

const fd = openSync(archive, 'r')
const pre = Buffer.alloc(16)
readSync(fd, pre, 0, 16, 0)
// asar header: [u32 payloadLen][u32 headerSize][u32 headerPayloadLen][u32 jsonLen]
const headerSize = pre.readUInt32LE(4)
const dataStart = 8 + headerSize
const buf = Buffer.alloc(headerSize)
readSync(fd, buf, 0, headerSize, 8)
const header = JSON.parse(buf.toString('utf8'))

let node = { files: header.files }
for (const seg of filePath.split('/')) {
  node = node?.files?.[seg]
  if (!node) throw new Error(`not found: ${filePath}`)
}
if (node.files) throw new Error(`${filePath} is a directory`)

const data = Buffer.alloc(node.size)
readSync(fd, data, 0, node.size, dataStart + Number(node.offset))
closeSync(fd)
process.stdout.write(data)