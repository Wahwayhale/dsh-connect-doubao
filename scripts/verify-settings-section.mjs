/**
 * Verify the SHIPPED client bundle registers `settings.section` with the exact
 * descriptor the host projects into its settings nav (`id` / `order` / `label`),
 * and that our card component is the one attached.
 *
 * Read-only over lib/client.js.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const BUNDLE = 'E:/project/新建文件夹/dsh-connect-doubao/lib/client.js'
const source = readFileSync(BUNDLE, 'utf8')

const reactStub = {
  createElement: (type, props, ...children) => ({ __el: typeof type === 'function' ? type.name : type, props, children }),
  useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
}
const jsxStub = { jsx: reactStub.createElement, jsxs: reactStub.createElement, Fragment: 'Fragment' }

const registered = []
const locales = []
/** Resolver produced by ctx.locale.bind, fed by the real zh table. */
let bound = (k) => k

const ctx = {
  slots: {
    // The host DECLARES the slot; ctx.slots.inject then runs the callback.
    inject(name, apply) { apply() },
    register(opts, component) {
      const injected = typeof opts.inject === 'function' ? opts.inject() : undefined
      registered.push({
        name: opts.name,
        id: opts.id,
        order: opts.order,
        label: typeof opts.label === 'function' ? opts.label() : undefined,
        hasLabelFn: typeof opts.label === 'function',
        component: component?.name,
        settingsScope: injected?.settingsScope !== undefined,
      })
      return () => {}
    },
  },
  locale: {
    register(ns, tables) {
      locales.push({ ns, zhKeys: Object.keys(tables.zh ?? {}).length })
      // Realistic bind: resolve the key against the registered zh table, so a
      // label assertion actually proves the locale entry exists and is correct.
      bound = (k) => tables.zh?.[k] ?? k
      return () => {}
    },
    bind: () => (k) => bound(k),
  },
  effect(fn) { fn() },
  get() { return undefined },
}

let captured = null
const sandbox = {
  console,
  window: {
    __ModuleLoader__: {
      load(spec) {
        captured = spec.factory(n => (n === 'react' ? reactStub : jsxStub))
        return captured
      },
    },
  },
}
sandbox.globalThis = sandbox
sandbox.self = sandbox

vm.runInNewContext(source, sandbox, { filename: 'client.js' })
captured.apply(ctx)

console.log('=== locale ===')
console.log(JSON.stringify(locales))
console.log('\n=== slot registrations ===')
for (const r of registered) console.log(JSON.stringify(r))

const section = registered.find(r => r.name === 'settings.section')
console.log('\n=== settings.section assertions ===')
const checks = [
  ['registered', section !== undefined],
  ['uses `id` (not `key`)', typeof section?.id === 'string'],
  ['id is the plugin id', section?.id === 'dsh-connect-doubao'],
  ['uses `order` (not `priority`)', typeof section?.order === 'number'],
  ['label is a function (locale-resolved)', section?.hasLabelFn === true],
  ['label resolves to 豆包', section?.label === '豆包'],
  ['component is DoubaoQuotaCard', section?.component === 'DoubaoQuotaCard'],
]
let ok = true
for (const [name, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (!pass) ok = false
}
console.log(ok ? '\nOK: settings.section descriptor matches the host contract.' : '\nFAIL')
process.exit(ok ? 0 : 1)