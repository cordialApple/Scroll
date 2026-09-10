import { spawn } from 'node:child_process'

const WS_PORT = process.env.SCROLL_WS_PORT ?? '1234'

const specs = [
  { name: 'relay', cmd: 'vite-node', args: ['server/index.ts'] },
  { name: 'web', cmd: 'vite', args: [] },
]

const children = []
let shuttingDown = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) {
    try {
      c.kill()
    } catch {
      // already gone
    }
  }
  process.exit(code)
}

for (const { name, cmd, args } of specs) {
  const child = spawn(cmd, args, { stdio: 'inherit', shell: true, env: process.env })
  child.on('exit', (code) => {
    console.log(`[dev:all] ${name} exited (${code}) — shutting down`)
    shutdown(code ?? 0)
  })
  children.push(child)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log(`\n[dev:all] relay ws://127.0.0.1:${WS_PORT}  +  vite dev server starting…`)
console.log(`[dev:all] doc picker →  http://localhost:5173/?ws=ws://127.0.0.1:${WS_PORT}#/docs`)
console.log(`[dev:all] (if vite prints a different port above, use that one)\n`)
