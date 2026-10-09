/**
 * Find the EXACT predicate that decides whether a plugin contributes a client
 * entry: print the loader scan and roster generator in `dsh-client-modules`.
 */
import { readFileSync } from 'node:fs'

const FILE = 'E:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
const s = readFileSync(FILE, 'utf8')

// Print from the narrowing helper onward — the validation + filtering region.
const start = s.indexOf('function optionalStringArray')
console.log(s.slice(start, start + 7000))