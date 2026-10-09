import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-connect-doubao'

/**
 * Modules the browser half must NOT bundle.
 *
 * The shell registers these in its own `__ModuleLoader__` (see
 * `scripts/shell-registry-extract.mjs`, which prints the verbatim `rM()`
 * registry out of the shipped `dsh-web-frontend` bundle), so externalizing
 * turns each import into a `require` the page resolves itself.
 *
 * `react-dom` and `react-dom/client` are listed for the same reason as react,
 * and the reason is a documented production outage rather than a style choice:
 * bundling either one inlines its CJS build, and EVERY such build opens with
 *
 *   if (process.env.NODE_ENV !== "production") …
 *
 * which throws `ReferenceError: process is not defined` in a browser — at
 * module-evaluation time, so the ENTIRE client half fails to import and the
 * shell reports `web boot: 1 entry did not activate`.
 *
 * The card does not use `react-dom` today, so this entry is currently
 * preventative. It is kept (and pinned by `tests/client-bundle-format.test.mjs`)
 * because the failure mode is silent, total, and arrives the first time someone
 * reaches for `createPortal` or `createRoot`.
 *
 * The `@deepseek-ai/dsh-client-*` entries below are TYPE-ONLY imports in this
 * package (`import type {} from …`), so the build erases them and no `require`
 * is emitted. They are listed so the intent is explicit and so the regression
 * test can see that a future VALUE import of one of them would be caught.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-renderer/client',
] as const

/**
 * Two build targets, because the plugin ships two halves with DIFFERENT module
 * systems:
 *
 *  - `index` (esm, platform node) is the provider: shim, adapter, routes. Loaded
 *    by the host process through Node's ESM loader.
 *  - `client` (cjs, platform browser) is the settings card. Loaded by the shell
 *    with a `<script>` tag through its own `__ModuleLoader__`.
 *
 * The client half MUST be CommonJS. The shell does not add `type="module"` to a
 * plugin's client entry, so an ESM bundle throws at evaluation:
 *
 *   Uncaught SyntaxError: Cannot use import statement outside a module
 *     at dsh-app://app/plugins/dsh-connect-doubao/client.js:1
 *
 * which fails the entry and takes the whole web boot down with it
 * (`web boot: 1 entry did not activate`). The banner/footer/intro trio below is
 * the other half of that contract: it wraps the CJS body in the shell's
 * `__ModuleLoader__.load({ factory })` call and defines the `module`/`exports`
 * bindings a browser does not otherwise provide.
 *
 * The peer dependencies are never bundled — they are resolved from the Harness
 * at runtime.
 */
export default [
  {
    entry: {
      index: 'src/index.ts',
      bin: 'src/bin.ts',
      'cli-probe': 'src/cli-probe.ts',
      'cli-doctor': 'src/cli-doctor.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    deps: {
      neverBundle: [
        '@earendil-works/pi-ai',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-pi-ai',
        // The settings schema is built with schemastery at module load, so it
        // MUST be the host's instance: two copies would make the Loader's
        // `.validate()` call land on a different schema object.
        '@deepseek-ai/schemastery',
      ],
    },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    // CJS, not ESM — see the module note above. This one word is the whole
    // difference between "the card renders" and "the desktop GUI will not boot".
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    // `clean` off: the node build above owns lib/ and the two run in sequence.
    clean: false,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      // No hash: the shell resolves the client entry by the literal
      // `plugins/<id>/client.js` path.
      entryFileNames: 'client.js',
      // Wraps the CJS body in the loader call the shell expects…
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      // …and hands the exports back out of the factory.
      footer: 'return module.exports; } });',
      // A browser has no `module`/`exports`; define them inside the factory.
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]