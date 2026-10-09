/**
 * Extract the shell's `rM()` static-module registry verbatim.
 *
 * The DSH web shell calls `__ModuleLoader__.create({ ..., staticModules: rM() })`.
 * Whatever `rM()` returns is the complete set of specifiers a plugin bundle may
 * `require` without inlining them — so it defines the legal CLIENT_EXTERNALS.
 */
import { readFileSync } from 'node:fs'

const FILE = 'E:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-5SrrfWpU.js'
const s = readFileSync(FILE, 'utf8')

// Find `function rM(` / `rM=()=>` and print its whole body.
for (const re of [/function rM\s*\(/, /\brM\s*=\s*(?:function|\(\s*\)\s*=>)/]) {
  const m = re.exec(s)
  if (!m) continue
  const start = m.index
  // Brace/paren matching from the first bracket after the name.
  const openIdx = s.indexOf('{', start) >= 0 ? s.indexOf('{', start) : s.indexOf('(', start)
  const opener = s[openIdx]
  const closer = opener === '{' ? '}' : ')'
  let depth = 0
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === opener) depth++
    else if (s[i] === closer) {
      depth--
      if (depth === 0) {
        console.log('=== rM() body ===')
        console.log(s.slice(start, i + 1))
        process.exit(0)
      }
    }
  }
}
console.log('rM() definition not found; searching for known registry members instead')
for (const needle of ['react-dom/client', 'dsh-client-ui-slots', '__ModuleLoader__']) {
  const i = s.indexOf(needle)
  console.log(`\n--- around "${needle}" (idx ${i}) ---`)
  if (i >= 0) console.log(s.slice(Math.max(0, i - 700), i + 700))
}