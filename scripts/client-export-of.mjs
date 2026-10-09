/**
 * Print `clientExportOf`: how the host picks the "./client" export, and whether
 * it accepts a plain string or requires a conditions object.
 */
import { readFileSync } from 'node:fs'

const FILE = 'E:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
const s = readFileSync(FILE, 'utf8')

const i = s.indexOf('clientExportOf')
// The definition, not the call site: find `function clientExportOf`.
const def = s.indexOf('function clientExportOf')
console.log('=== definition @ ' + def + ' ===')
console.log(s.slice(Math.max(0, def - 1800), def + 1800))