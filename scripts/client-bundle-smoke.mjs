/**
 * Runtime smoke check for the built client bundle — NO browser, NO profile.
 *
 * Evaluates `lib/client.js` the way the desktop shell does: as a classic
 * `<script>` body, with a fake `window.__ModuleLoader__` and a `require` that
 * only knows the modules the shell registers.
 *
 * This catches the failure modes the static test cannot:
 *  - a top-level ESM `import` (the 2026-10-09 crash) — a SyntaxError here,
 *  - a `require` of something the shell never registers — a hard failure,
 *  - an inlined package referencing `process` — a ReferenceError,
 *  - a bundle that never calls the loader at all.
 *
 * It also asserts the loader received the right plugin id and a factory.
 *
 * Deliberately does NOT execute the factory body: the real component needs a
 * DOM, and evaluating it here would test React rather than the packaging.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'lib', 'client.js')
const source = readFileSync(file, 'utf8')

// What the shell's rM() registers — anything else must not be required.
const registered = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

let loadCall = null
const sandbox = {
  // Browser-ish globals. NOTE: no `process` — that is the point.
  window: {
    __ModuleLoader__: {
      load(spec) {
        loadCall = spec
        return spec
      },
    },
  },
  console,
  // A require that only knows registered modules, like the shell's.
  require(spec) {
    if (!registered.has(spec)) throw new Error(`shell does not register "${spec}"`)
    return new Proxy({}, { get: () => () => undefined })
  },
  module: undefined,
  exports: undefined,
}
sandbox.globalThis = sandbox
sandbox.self = sandbox

let evaluateError = null
try {
  // Script (NOT module) semantics: this is the load path that failed.
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
} catch (error) {
  evaluateError = error
}

console.log('=== client bundle runtime smoke check ===')
console.log(`file: ${file} (${source.length} bytes)`)

if (evaluateError !== null) {
  console.log(`EVALUATION FAILED: ${evaluateError.constructor.name}: ${evaluateError.message}`)
  console.log('This is the 2026-10-09 failure mode (Cannot use import statement outside a module).')
  process.exit(1)
}

if (loadCall === null) {
  console.log('FAILED: the bundle evaluated but never called window.__ModuleLoader__.load()')
  process.exit(1)
}

console.log(`loader called with id="${loadCall.id}"`)
console.log(`factory is a function: ${typeof loadCall.factory === 'function'}`)

if (loadCall.id !== 'dsh-connect-doubao') {
  console.log(`FAILED: wrong plugin id "${loadCall.id}"`)
  process.exit(1)
}
if (typeof loadCall.factory !== 'function') {
  console.log('FAILED: no factory function')
  process.exit(1)
}

// The factory must run and return an exports object. This is the whole reason
// the banner/footer pair exists.
let factoryError = null
let exportsObject = null
try {
  exportsObject = loadCall.factory(sandbox.require)
} catch (error) {
  factoryError = error
}
if (factoryError !== null) {
  console.log(`FACTORY FAILED: ${factoryError.constructor.name}: ${factoryError.message}`)
  process.exit(1)
}

const exported = Object.keys(exportsObject ?? {})
console.log(`factory returned exports: ${JSON.stringify(exported)}`)
if (!exported.includes('apply')) {
  console.log('FAILED: the module does not export apply() — the shell would load it as a no-op')
  process.exit(1)
}

console.log('OK: bundle evaluates as a classic script, registers with the loader, and exports apply().')