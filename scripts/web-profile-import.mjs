// Reproduce the host's plugin load from INSIDE the web profile's own
// resolution scope, to see the exact failure the loader hits.
import { pathToFileURL } from 'node:url'

const PLUGIN = pathToFileURL('C:/Users/35498/.dsh/profiles/web/node_modules/dsh-connect-doubao/lib/index.js').href
console.log(`electron ${process.versions.electron ?? '(none)'} node ${process.versions.node}`)
console.log(`loading ${PLUGIN}`)

try {
  const mod = await import(PLUGIN)
  console.log(`IMPORT OK; plugin = ${JSON.stringify(Object.keys(mod.plugin ?? {}))}`)
  console.log(`plugin.name = ${mod.plugin?.name}`)
} catch (e) {
  console.log(`IMPORT FAILED`)
  console.log(`  code: ${e.code}`)
  console.log(`  message: ${String(e.message).split('\n')[0]}`)
  if (e.stack) console.log(`  stack:\n${e.stack.split('\n').slice(0, 8).join('\n')}`)
}