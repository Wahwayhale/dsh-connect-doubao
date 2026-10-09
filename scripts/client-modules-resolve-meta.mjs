/**
 * Print `resolveMeta`: the function that turns a Loader entry into package
 * metadata (and decides whether it is a client package at all).
 */
import { readFileSync } from 'node:fs'

const FILE = 'E:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
const s = readFileSync(FILE, 'utf8')

const i = s.indexOf('resolveMeta(')
console.log('=== resolveMeta @ ' + i + ' ===')
console.log(s.slice(Math.max(0, i - 400), i + 3000))