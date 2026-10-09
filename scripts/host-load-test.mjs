// Load the built plugin the way the host does (Electron-as-node, so peer
// junctions resolve into the asar) and report whether apply() runs and the
// quota route registers. Prints NO credentials — counts and booleans only.
import { readFileSync } from 'node:fs'

import { pathToFileURL } from 'node:url'

const PLUGIN = pathToFileURL('E:/project/新建文件夹/dsh-connect-doubao/lib/index.js').href

console.log(`electron ${process.versions.electron ?? '(none)'} node ${process.versions.node}`)
for (const p of ['@earendil-works/pi-ai', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai']) {
  try {
    console.log(`resolve ${p} -> ${import.meta.resolve(p)}`)
  } catch (e) {
    console.log(`resolve ${p} -> FAILED ${e.code}`)
  }
}

let mod
try {
  mod = await import(PLUGIN)
  console.log(`\nimport OK; exports: ${Object.keys(mod).slice(0, 12).join(', ')}`)
} catch (e) {
  console.log(`\nimport FAILED: ${e.code ?? ''} ${e.message.split('\n')[0]}`)
  process.exit(1)
}

// Minimal stand-in for the Cordis context, enough to drive apply() and see
// whether the webServer injection actually fires.
const events = { adapters: [], providers: [], discovery: [], webServer: 0 }
const disposers = []
const ctx = {
  logger: { error: (m, e) => console.log(`  [logger.error] ${m}${e ? ` :: ${e?.message ?? e}` : ''}`),
            warn: (m) => console.log(`  [logger.warn] ${m}`),
            info: (m) => console.log(`  [logger.info] ${m}`) },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  inject: (names, fn) => {
    console.log(`  [ctx.inject] waiting for ${JSON.stringify(names)}`)
    // Cordis invokes the callback only once every named service is present.
    setTimeout(() => { console.log('  [ctx.inject] firing'); fn(webServerCtx) }, 50)
  },
  llm: {
    registerAdapter: (ids, a) => { events.adapters.push(ids); console.log(`  [llm.registerAdapter] ${ids.join(',')}`); return () => {} },
    registerConfigurableProviders: (e) => { events.providers.push(...e); console.log(`  [llm.registerConfigurableProviders] ${e.map((x) => x.provider).join(',')}`); return () => {} },
    registerModelDiscovery: (ns, fn) => { events.discovery.push(ns); console.log(`  [llm.registerModelDiscovery] ${ns}`); return () => {} },
  },
}

const webServerCtx = {
  webServer: {
    register: (route) => {
      console.log(`  [webServer.register] kind=${route.kind} path=${route.path}`)
      events.webServer++
      // Prove the handler is reachable and returns a quota view with no secrets.
      const fakeRes = {
        _status: 0, _body: '',
        writeHead(s) { this._status = s },
        end(b) { this._body = b ?? '' },
      }
      const fakeReq = { method: 'GET', url: route.path, headers: {} }
      return Promise.resolve(route.handler(fakeReq, fakeRes)).then(() => {
        const leaked = /sessionid|sid_tt|msToken|odin_tt|ttwid|passport_csrf/i.test(fakeRes._body)
        console.log(`  [route.handler] status=${fakeRes._status} bytes=${fakeRes._body.length} leaksSecrets=${leaked}`)
        try {
          const v = JSON.parse(fakeRes._body)
          console.log(`  [route.payload] ok=${v.ok} plan=${v.plan} exhausted=${v.exhausted} err=${v.error === null ? 'none' : 'set'}`)
          console.log(`  [route.payload] 5h=${JSON.stringify(v.windows?.fiveHour)}`)
          console.log(`  [route.payload] weekly=${JSON.stringify(v.windows?.weekly)}`)
        } catch { console.log(`  [route.payload] unparseable: ${fakeRes._body.slice(0, 200)}`) }
      }).then(() => () => {})
    },
  },
}

console.log('\n=== apply() ===')
try {
  mod.plugin.apply(ctx)
} catch (e) {
  console.log(`apply THREW: ${e.message}`)
}

setTimeout(() => {
  console.log('\n=== summary ===')
  console.log(`adapters=${JSON.stringify(events.adapters)} providers=${events.providers.length} discovery=${events.discovery.length} webServerRegistrations=${events.webServer}`)
  for (const d of disposers) { try { d() } catch {} }
  process.exit(events.webServer > 0 ? 0 : 3)
}, 20000)