/**
 * Does the HOST declare the `settings.section` slot? Per 专家团's comment,
 * `ctx.slots.inject('settings.section', …)` waits for the host's DECLARATION of
 * that slot — if the host never declares it, the contribution never attaches.
 *
 * Read-only: reads the shipped host client bundles.
 */
import { readFileSync, readdirSync } from 'node:fs'

const ASAR = 'E:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/'

function walk(dir, depth = 0, out = []) {
  if (depth > 4) return out
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = dir + '/' + e.name
    if (e.isDirectory()) walk(full, depth + 1, out)
    else if (/\.js$/.test(e.name)) out.push(full)
  }
  return out
}

const needles = ['settings.section', 'settings.plugin.item', 'settings.section.declare', 'declareSlot', 'slots.declare']
const hits = new Map()

for (const pkg of ['dsh-client-ui-settings', 'dsh-client-ui-slots', 'dsh-client-ui-settings-general', 'dsh-client-ui-settings-plugins', 'dsh-client-ui-layout']) {
  for (const file of walk(ASAR + pkg)) {
    // Only the client face declares/uses slots.
    if (!/client/i.test(file) && !/general/i.test(file)) continue
    let s
    try {
      s = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const n of needles) {
      const count = (s.match(new RegExp(n.replace(/\./g, '\\.'), 'g')) ?? []).length
      if (count > 0) {
        if (!hits.has(file)) hits.set(file, { pkg, counts: {} })
        hits.get(file).counts[n] = count
      }
    }
  }
}

console.log('=== files mentioning settings.section (or friends) ===')
for (const [file, info] of hits) {
  console.log(`\n${info.pkg}: ${file.replace(ASAR, '')}`)
  console.log('  ' + JSON.stringify(info.counts))
}

// Print the declaration site for settings.section in the client face.
for (const [file] of hits) {
  const s = readFileSync(file, 'utf8')
  const i = s.indexOf("'settings.section'")
  const j = s.indexOf('"settings.section"')
  const at = i >= 0 ? i : j
  if (at < 0) continue
  console.log(`\n--- declaration context in ${file.replace(ASAR, '')} ---`)
  console.log(s.slice(Math.max(0, at - 1200), at + 900))
  break
}