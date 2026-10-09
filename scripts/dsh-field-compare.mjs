/**
 * Three-way comparison of the `dsh` field across plugins that the host
 * successfully registers, versus ours.
 *
 * Reads the INSTALLED copies under the desktop profile where possible (those are
 * what the host actually resolved), and the source trees otherwise.
 *
 * Read-only. Touches nothing.
 */
import { readFileSync, existsSync } from 'node:fs'

const PROFILE = 'C:/Users/35498/.dsh/profiles/desktop/node_modules/'
const REPOS = 'E:/project/新建文件夹/repos/wb/'

const TARGETS = [
  ['workbuddy (installed)', PROFILE + 'dsh-connect-workbuddy/package.json'],
  ['trae (installed)', PROFILE + 'dsh-connect-trae/package.json'],
  ['doubao (installed)', PROFILE + 'dsh-connect-doubao/package.json'],
  ['workbuddy (source)', REPOS + 'dsh-connect-workbuddy-main/package.json'],
  ['doubao (source)', 'E:/project/新建文件夹/dsh-connect-doubao/package.json'],
]

function readDsh(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    return null
  }
}

const rows = []
for (const [label, path] of TARGETS) {
  const j = readDsh(path)
  rows.push({
    label,
    exists: existsSync(path),
    name: j?.name ?? null,
    dshPresent: j?.dsh !== undefined,
    client: j?.dsh?.client !== undefined,
    inject: j?.dsh?.client?.inject ?? null,
    platform: j?.dsh?.client?.platform ?? null,
    exportsClient: j?.exports?.['./client'] ?? null,
    filesHasLib: Array.isArray(j?.files) ? j.files.includes('lib') : null,
    main: j?.main ?? null,
    icon: j?.icon ?? null,
  })
}

console.log(JSON.stringify(rows, null, 2))

console.log('\n=== side-by-side ===')
for (const r of rows) {
  console.log(`\n## ${r.label}  (exists=${r.exists})`)
  console.log(`  name            : ${r.name}`)
  console.log(`  dsh field       : ${r.dshPresent}`)
  console.log(`  dsh.client      : ${r.client}`)
  console.log(`  client.platform : ${r.platform}`)
  console.log(`  client.inject   : ${JSON.stringify(r.inject)}`)
  console.log(`  exports./client : ${r.exportsClient}`)
  console.log(`  files includes lib: ${r.filesHasLib}`)
  console.log(`  main            : ${r.main}`)
  console.log(`  icon            : ${r.icon}`)
}

// Does the installed doubao package actually resolve ./client to a file?
console.log('\n=== installed doubao ./client resolution ===')
for (const p of [
  PROFILE + 'dsh-connect-doubao/lib/client.js',
  PROFILE + 'dsh-connect-workbuddy/lib/client.js',
]) {
  let ok = false
  let size = 0
  try {
    const s = readFileSync(p, 'utf8')
    ok = true
    size = s.length
  } catch { /* missing */ }
  console.log(`  ${existsSync(p) ? 'OK ' : 'MISS'} ${p}  bytes=${size}`)
}