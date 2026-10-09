/**
 * How does `@deepseek-ai/dsh-client-modules` decide WHICH plugins get a client
 * entry? Print the code that reads each package's manifest fields.
 */
import { readFileSync } from 'node:fs'

const FILE = 'E:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
const s = readFileSync(FILE, 'utf8')

console.log(`file length: ${s.length}`)

for (const needle of ['dsh.client', 'platform', 'exports', 'package.json', 'inject']) {
  console.log(`\n${'='.repeat(70)}\n### occurrences of "${needle}": ${(s.match(new RegExp(needle.replace('.', '\\.'), 'g')) ?? []).length}`)
}

// Print a generous window around each `dsh.client` occurrence.
let idx = -1
let n = 0
while ((idx = s.indexOf('dsh.client', idx + 1)) !== -1 && n < 6) {
  n++
  console.log(`\n${'-'.repeat(60)}\n--- dsh.client occurrence ${n} (idx ${idx}) ---`)
  console.log(s.slice(Math.max(0, idx - 800), idx + 800))
}