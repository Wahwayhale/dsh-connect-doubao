/**
 * Reproduce the host's client-package scan for our plugin and for two that DO
 * appear in the shell's client bundle list, then diff the decisions.
 *
 * Mirrors `resolveMeta` in `@deepseek-ai/dsh-client-modules`:
 *   locatePkgJson -> parse dsh.client -> platform === 'web'
 *   -> clientExportOf(exports['./client']) -> statSync(clientPath)
 *
 * Read-only.
 */
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PKGS = [
  ['doubao', 'C:/Users/35498/.dsh/profiles/desktop/node_modules/dsh-connect-doubao'],
  ['workbuddy', 'C:/Users/35498/.dsh/profiles/desktop/node_modules/dsh-connect-workbuddy'],
  ['trae', 'C:/Users/35498/.dsh/profiles/desktop/node_modules/dsh-connect-trae'],
]

function clientExportOf(pkgName, exportsField) {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = exportsField['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = client.default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`exports["./client"] must be a string or an object with a string default (${pkgName})`)
}

for (const [label, dir] of PKGS) {
  console.log(`\n================ ${label} ================`)
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) {
    console.log('  package.json MISSING')
    continue
  }
  const real = realpathSync(dir)
  console.log(`  dir      : ${dir}`)
  console.log(`  realpath : ${real}`)

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  console.log(`  name     : ${pkg.name}`)

  const dsh = pkg.dsh
  const decl = dsh !== null && typeof dsh === 'object' ? dsh.client : undefined
  console.log(`  dsh.client present : ${decl !== undefined}`)
  console.log(`  platform           : ${decl?.platform}`)
  console.log(`  platform === 'web' : ${decl?.platform === 'web'}`)
  console.log(`  inject             : ${JSON.stringify(decl?.inject)}`)

  let clientRel
  try {
    clientRel = clientExportOf(pkg.name, pkg.exports)
  } catch (e) {
    console.log(`  clientExportOf THREW: ${e.message}`)
    continue
  }
  console.log(`  exports['./client']: ${JSON.stringify(clientRel)}`)
  if (clientRel === undefined) {
    console.log('  VERDICT: not a client package (no ./client export)')
    continue
  }

  const clientPath = join(dirname(pkgPath), clientRel)
  console.log(`  clientPath         : ${clientPath}`)
  let size = -1
  try {
    size = statSync(clientPath).size
    console.log(`  clientPath EXISTS   : yes, ${size} bytes`)
  } catch (e) {
    console.log(`  clientPath MISSING  : ${e.code}`)
    console.log('  VERDICT: would throw MissingClientBundleError')
    continue
  }

  const head = readFileSync(clientPath, 'utf8').split('\n')[0] ?? ''
  console.log(`  first line         : ${head.slice(0, 80)}`)
  console.log(`  VERDICT: REGISTERED as a client package`)
}