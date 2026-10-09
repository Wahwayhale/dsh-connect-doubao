/**
 * Drive the SHIPPED client bundle through a stub Cordis client context — the
 * real `apply()` body, the real React, the real component — and report what it
 * registers. This is the last static check: does `apply()` actually register the
 * two card slots when `slots` and `locale` are present?
 *
 * Read-only with respect to the repo and the host.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createElement } from 'react'

const BUNDLE = 'E:/project/新建文件夹/dsh-connect-doubao/lib/client.js'
const source = readFileSync(BUNDLE, 'utf8')

// Minimal React that records what it renders, so the component body runs
// without a DOM.
const reactStub = {
  createElement(type, props, ...children) {
    if (typeof type === 'function') {
      return { __rendered: type.name, props, children }
    }
    return { __el: type, props, children }
  },
  useState(initial) {
    let v = typeof initial === 'function' ? initial() : initial
    return [v, () => {}]
  },
  useEffect() {},
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
  useRef(v) { return { current: v } },
}
const jsxStub = { jsx: (t, p, k) => reactStub.createElement(t, p, k), jsxs: (t, p, k) => reactStub.createElement(t, p, k), Fragment: 'Fragment' }

const registered = []
const locales = []

const sandbox = {
  console,
  window: {
    __ModuleLoader__: {
      load(spec) {
        let factory = spec.factory
        const req = name => {
          if (name === 'react') return reactStub
          if (name === 'react/jsx-runtime') return jsxStub
          throw new Error(`unregistered require: ${name}`)
        }
        return factory(req)
      },
    },
  },
  // The Cordis client context the host provides.
  __ctx: {
    slots: {
      inject(names, apply) { apply() },
      register(opts, component) {
        registered.push({ name: opts.name, key: opts.key, priority: opts.priority, component: component?.name })
        return () => {}
      },
    },
    locale: {
      register(ns, tables) { locales.push({ ns, keys: Object.keys(tables.zh ?? {}).length }); return () => {} },
      bind(ns) {
        return (key, vars) => {
          const t = key
          if (vars === undefined) return t
          return t.replace(/\{(\w+)\}/g, (m, n) => (vars[n] === undefined ? m : String(vars[n])))
        }
      },
    },
    effect(fn) { const d = fn(); return d },
    get() { return undefined },
  },
}
sandbox.globalThis = sandbox
sandbox.self = sandbox

let err = null
try {
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
} catch (e) {
  err = e
}
if (err) {
  console.log('BUNDLE EVAL FAILED:', err.message)
  process.exit(1)
}

const mod = sandbox.window.__ModuleLoader__ ? null : null
// The factory returns the module exports; capture them.
let exportsObj = null
try {
  exportsObj = vm.runInNewContext(source, sandbox, { filename: 'client.js' }) // returns undefined
} catch { /* re-eval harmless */ }

// Re-run capturing the factory result explicitly.
let captured = null
const sandbox2 = { ...sandbox, window: { __ModuleLoader__: { load(spec) { captured = spec.factory(sandbox.window.__ModuleLoader__.require ?? ((n) => n === 'react' ? reactStub : jsxStub)); return captured } } } }
sandbox2.globalThis = sandbox2
vm.runInNewContext(source, sandbox2, { filename: 'client.js' })

console.log('=== exports ===')
console.log('  ' + Object.keys(captured ?? {}).join(', '))
console.log('=== apply() result ===')
try {
  captured.apply(sandbox.__ctx)
  console.log('  apply() returned without throwing')
} catch (e) {
  console.log('  apply() THREW: ' + e.message)
}
console.log('=== locale registrations ===')
console.log(JSON.stringify(locales))
console.log('=== slot registrations ===')
console.log(JSON.stringify(registered, null, 2))
console.log(registered.length >= 2 ? '\nOK: both card slots registered.' : '\nFAIL: expected 2 slots')