/**
 * Which slot names do the plugins that DO appear in the settings left-hand nav
 * register? Grep their SHIPPED client bundles for slot registrations.
 *
 * Read-only over the desktop profile's node_modules.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'

const NM = 'C:/Users/35498/.dsh/profiles/desktop/node_modules/'

// Plugins the user reports appearing in the settings nav.
const CANDIDATES = [
  'dsh-expert-team',
  '@yangdcm/dsh-expert-team',
  'dsh-better-sidebar',
  'dsh-connect-workbuddy',
  'dsh-connect-trae',
  'dsh-workbuddy-xdpool',
  '@wlv-zedd/dsh-chatgpt-web',
  '@opencode2dsh/dsh-plugin',
]

function findClientBundle(pkgDir) {
  // Mirrors the host's clientExportOf(): exports['./client'] -> join(dirname, rel)
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgDir + '/package.json', 'utf8'))
  } catch {
    return null
  }
  const rel = pkg?.exports?.['./client']
  const relPath = typeof rel === 'string' ? rel : (typeof rel === 'object' ? rel?.default : undefined)
  if (typeof relPath !== 'string') return null
  const path = pkgDir + '/' + relPath.replace(/^\.\//, '')
  return existsSync(path) ? path : null
}

// Slot names look like dotted identifiers registered via ctx.slots.register({name}).
const SLOT_RE = /slots\s*\.\s*(?:inject\s*\(\s*)?register\s*\(\s*\{[^}]*?name\s*:\s*["'`]([A-Za-z0-9_.:-]+)["'`]/g
const NAME_RE = /["'`]([a-z][a-z0-9]*(?:\.[a-z0-9-]+){1,4})["'`]/g

for (const name of CANDIDATES) {
  const dir = NM + name
  if (!existsSync(dir)) {
    console.log(`\n### ${name}  — NOT INSTALLED`)
    continue
  }
  const bundle = findClientBundle(dir)
  if (bundle === null) {
    console.log(`\n### ${name}  — no exports['./client']`)
    continue
  }
  const s = readFileSync(bundle, 'utf8')
  console.log(`\n### ${name}`)
  console.log(`    bundle: ${bundle.replace(NM, '')}  (${s.length} bytes)`)

  const explicit = [...new Set([...s.matchAll(SLOT_RE)].map(m => m[1]))]
  if (explicit.length) console.log('    slots.register({name: …}) →', JSON.stringify(explicit))

  // Broader: any dotted token that looks like a slot name.
  const dotted = [...new Set([...s.matchAll(NAME_RE)].map(m => m[1]))]
    .filter(x => !x.startsWith('dsh-connect-') && !x.startsWith('@deepseek-ai/'))
    .sort()
  console.log('    dotted tokens →', JSON.stringify(dotted))
}