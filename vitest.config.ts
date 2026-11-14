import { defineConfig } from 'vitest/config'

// Scope the suite to this plugin's own tests. Without an explicit include,
// vitest walks the whole tree and picks up the locally cloned marketplace
// repo (awesome-dsh-plugin/, gitignored) whose node:test scripts and missing
// js-yaml dependency are not ours to run — they failed the release gate.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/lib/**', 'awesome-dsh-plugin/**', '.pr/**'],
  },
})
