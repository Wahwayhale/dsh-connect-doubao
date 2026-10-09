/**
 * Where does the host build the CLIENT BUNDLE MANIFEST (the
 * `plugins/<id>/client.js,...` list the shell loads)?
 *
 * Read-only inspection of the shipped host packages.
 */
import { readdirSync, readFileSync } from 'node:fs'

const BASE = 'E:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/'

function walk(dir, out = [], depth = 0) {
  if (depth > 4) return out
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = dir + '/' + e.name
    if (e.isDirectory()) walk(full, out, depth + 1)
    else if (/\.(js|mjs)$/.test(e.name)) out.push(full)
  }
  return out
}

// Candidate host packages that could own client-bundle discovery.
const candidates = [
  'dsh-host-plugin-inventory',
  'dsh-web-app',
  'dsh-cordis-host-runner',
  'dsh-client-modules',
  'dsh-web-frontend',
]

for (const name of candidates) {
  const files = walk(BASE + name)
  for (const file of files) {
    let s
    try {
      s = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // Look for the manifest shape: a client entry path per plugin.
    const hits = []
    for (const re of [/client\.js/g, /clientEntry/g, /\/client['"`]/g, /dsh\.client/g, /\bclient\b\s*:\s*\{/g]) {
      const n = (s.match(re) ?? []).length
      if (n > 0) hits.push(`${re.source}×${n}`)
    }
    if (hits.length === 0) continue
    console.log(`\n### ${file.replace(BASE, '')}  (${s.length} bytes)  ${hits.join(' ')}`)
    for (const needle of ['client.js', 'clientEntry', 'dsh.client']) {
      const i = s.indexOf(needle)
      if (i < 0) continue
      console.log(`\n--- around "${needle}" (idx ${i}) ---`)
      console.log(s.slice(Math.max(0, i - 700), i + 700))
      break
    }
  }
}