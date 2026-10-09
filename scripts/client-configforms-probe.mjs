/**
 * Decisive test for 疑点 A: does `softGet('configForms')` actually WORK when the
 * service IS present?
 *
 * Drives the SHIPPED client bundle with a stub Cordis client ctx in three
 * configurations:
 *   1. configForms absent      -> expect: card registers read-only ({t} only)
 *   2. configForms present     -> expect: settingsScope is bound and passed in
 *   3. configForms present but namespaces empty (mirror not ready)
 *
 * If (2) yields a card that RECEIVES settingsScope, then the soft probe is
 * working and there is nothing to fix. This is the evidence that decides
 * whether hard-injecting `configForms` is warranted.
 *
 * Read-only.
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

function run(label, { configForms }) {
  const registered = []
  let localeRegistrations = 0

  const settingsScope = {
    getSnapshot: () => ({ status: 'ok', value: { enabledModelIds: ['doubao-seed'] }, writable: true }),
    subscribe: () => () => {},
    set: async () => true,
  }

  const ctx = {
    slots: {
      inject(names, apply) { apply() },
      register(opts, component) {
        const injected = opts.inject()
        registered.push({
          name: opts.name,
          key: opts.key,
          component: component?.name,
          hasSettingsScope: injected?.settingsScope !== undefined,
        })
        return () => {}
      },
    },
    locale: {
      register() { localeRegistrations++; return () => {} },
      bind: () => (k) => k,
    },
    effect(fn) { fn() },
    get(name) { return name === 'configForms' ? configForms : undefined },
  }

  const sandbox = {
    console,
    window: {
      __ModuleLoader__: {
        load(spec) {
          return spec.factory(n => (n === 'react' ? reactStub : jsxStub))
        },
      },
    },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox

  let error = null
  try {
    const mod = vm.runInNewContext(source, sandbox, { filename: 'client.js' })
    void mod
  } catch (e) { error = e }
  // Run apply separately so we can inspect the captured registrations.
  try {
    const factoryResult = (() => {
      let captured = null
      const s2 = { ...sandbox, window: { __ModuleLoader__: { load(spec) { captured = spec.factory(n => (n === 'react' ? reactStub : jsxStub)); return captured } } } }
      s2.globalThis = s2
      vm.runInNewContext(source, s2, { filename: 'client.js' })
      return captured
    })()
    factoryResult.apply(ctx)
  } catch (e) { error = e }

  console.log(`\n=== ${label} ===`)
  if (error) console.log(`  ERROR: ${error.message}`)
  console.log(`  locale registrations: ${localeRegistrations}`)
  for (const r of registered) {
    console.log(`  ${r.name}  key=${r.key}  component=${r.component}  settingsScope=${r.hasSettingsScope}`)
  }
  return registered
}

// 1. absent
const a = run('1. configForms ABSENT (current behaviour)', { configForms: undefined })

// 2. present, namespaces include our entry
const forms2 = {
  describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'dsh-connect-doubao' }] } }) }),
  get: () => ({
    getSnapshot: () => ({ status: 'ok', value: { enabledModelIds: ['doubao-seed'] }, writable: true }),
    subscribe: () => () => {},
    set: async () => true,
  }),
}
const b = run('2. configForms PRESENT, namespace matched', { configForms: forms2 })

// 3. present but mirror not populated yet
const forms3 = {
  describe: () => ({ getSnapshot: () => ({ view: {} }) }),
  get: () => ({
    getSnapshot: () => ({ status: 'ok', value: {}, writable: true }),
    subscribe: () => () => {},
    set: async () => true,
  }),
}
const c = run('3. configForms PRESENT, namespaces empty (mirror not ready)', { configForms: forms3 })

console.log('\n=== VERDICT ===')
console.log(`absent  -> slots=${a.length}  settingsScopeBound=${a.every(r => !r.hasSettingsScope)}`)
console.log(`present -> slots=${b.length}  settingsScopeBound=${b.every(r => r.hasSettingsScope)}`)
console.log(`noNs    -> slots=${c.length}  settingsScopeBound=${c.every(r => r.hasSettingsScope)}`)
console.log(
  b.length === 2 && b.every(r => r.hasSettingsScope)
    ? '\n=> softGet WORKS when the service is present. 疑点 A is not a bug.'
    : '\n=> softGet does NOT bind settingsScope. 疑点 A would be a real bug.',
)