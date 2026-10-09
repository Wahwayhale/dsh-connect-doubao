#!/usr/bin/env node
/**
 * `dsh-connect-doubao` — thin alias that forwards to the smoke probe so both
 * the plugin bin name and the probe bin name behave identically.
 */
import { main } from './cli-probe.ts'

main().then(
  (code) => { process.exitCode = code },
  (error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exitCode = 1
  },
)