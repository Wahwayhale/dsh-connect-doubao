// Decisive check: does the doubao shim bind a loopback port inside the
// running dsh web server? The shim is created inside plugin.apply(), so a
// bound port proves apply() ran in the real host. No credentials are printed.
import { connect } from 'node:net'

const candidates = []
for (let port = 45000; port < 65535; port += 1) candidates.push(port)

// Probe the ports this process owns via its own handle table is not possible
// cross-process, so instead ask the OS: enumerate listening ports owned by any
// node/Electron process started after our boot window.
import { execFileSync } from 'node:child_process'
const raw = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
const listening = new Map()
for (const line of raw.split('\n')) {
  const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line)
  if (!m) continue
  const port = Number(m[2])
  listening.set(port, m[3])
}
console.log('listening TCP ports on this host:')
for (const [port, pid] of [...listening.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${port}  pid=${pid}`)
}