/**
 * Print `resolveSource` and whatever reads the package manifest + export path —
 * the code path that decides a Loader entry is a client package.
 */
import { readFileSync } from 'node:fs'

const FILE = 'E:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
const s = readFileSync(FILE, 'utf8')

const i = s.indexOf('resolveSource(')
console.log(s.slice(Math.max(0, i - 200), i + 3200))