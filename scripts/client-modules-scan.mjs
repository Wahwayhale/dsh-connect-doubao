/**
 * How is a client package's clientPath resolved, and what makes the Loader scan
 * pick up an entry? Print the scan/reconcile implementation.
 */
import { readFileSync } from 'node:fs'

const FILE = 'E:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
const s = readFileSync(FILE, 'utf8')

for (const needle of ['MissingClientBundleError(', 'clientPath', 'resolve.exports', 'require.resolve', 'clientPath =']) {
  const i = s.indexOf(needle)
  console.log(`\n${'='.repeat(70)}\n### "${needle}" idx=${i}`)
  if (i >= 0) console.log(s.slice(Math.max(0, i - 1600), i + 1200))
}