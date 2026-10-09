/**
 * What service name(s) does `@deepseek-ai/dsh-client-ui-settings` actually
 * provide on the CLIENT side, and what does workbuddy do about it?
 *
 * Read-only: reads the installed host copy and the reference repo.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'

const HOST = 'E:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/'
const LOCAL = 'C:/Users/35498/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-client-ui-settings/'

function listFiles(dir, depth = 0, out = []) {
  if (depth > 3) return out
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = dir + '/' + e.name
    if (e.isDirectory()) listFiles(full, depth + 1, out)
    else out.push(full)
  }
  return out
}

for (const [label, base] of [['host-asar', HOST], ['profile', LOCAL]]) {
  console.log(`\n================ ${label}: ${base} ================`)
  if (!existsSync(base)) {
    console.log('  (not present)')
    continue
  }
  try {
    const pkg = JSON.parse(readFileSync(base + 'package.json', 'utf8'))
    console.log(`  name=${pkg.name} version=${pkg.version}`)
    console.log(`  exports=${JSON.stringify(pkg.exports)}`)
  } catch (e) {
    console.log(`  package.json unreadable: ${e.code}`)
  }
  for (const f of listFiles(base)) {
    if (!/\.(js|mjs|ts)$/.test(f)) continue
    const size = readFileSync(f, 'utf8').length
    console.log(`  ${String(size).padStart(8)}  ${f.replace(base, '')}`)
  }
}

// The client subpath is what a plugin type-imports. Find the Service(...) calls.
console.log('\n================ service names in the client subpath ================')
for (const base of [HOST, LOCAL]) {
  for (const f of listFiles(base)) {
    if (!/client/i.test(f) || !/\.(js|mjs)$/.test(f)) continue
    const s = readFileSync(f, 'utf8')
    const services = [...new Set([...s.matchAll(/super\(\s*ctx\s*,\s*["'`]([^"'`]+)["'`]\s*\)/g)].map(m => m[1]))]
    const declares = [...new Set([...s.matchAll(/\binject\s*[:=]\s*\[([^\]]{0,200})\]/g)].map(m => m[1].trim()))]
    const configForms = (s.match(/configForms/g) ?? []).length
    console.log(`\n### ${f.replace(base, '')}`)
    console.log(`  provides services : ${JSON.stringify(services)}`)
    console.log(`  inject decls      : ${JSON.stringify(declares)}`)
    console.log(`  'configForms' hits: ${configForms}`)
  }
}