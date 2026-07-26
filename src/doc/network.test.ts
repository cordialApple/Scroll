import 'fake-indexeddb/auto'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { Hocuspocus } from '@hocuspocus/server'
import { HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { startScrollServer } from '../../server/hocuspocus'
import { openDoc, type DocHandle } from './persistence'
import { appendBlock, blockViews } from './model'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

// Bounded poll — Date/setTimeout are allowed in tests (only production/PBT code freezes entropy).
async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 15))
  }
}

const sockets: HocuspocusProviderWebsocket[] = []
function wsPeer(url: string): HocuspocusProviderWebsocket {
  const s = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket })
  sockets.push(s)
  return s
}

let server: Hocuspocus | null = null
const handles: DocHandle[] = []

afterEach(async () => {
  for (const h of handles.splice(0)) h.destroy()
  for (const s of sockets.splice(0)) s.destroy()
  if (server) {
    await server.destroy()
    server = null
  }
})

describe('P3.1 network provider seam', () => {
  it('two peers converge over a real socket (real transport, not the in-memory model)', async () => {
    const port = await freePort()
    server = await startScrollServer({ port })
    const url = `ws://127.0.0.1:${port}`
    const room = `room-${port}`

    const a = openDoc(`peerA-${port}`, { room, seed: true, websocketProvider: wsPeer(url) })
    const b = openDoc(`peerB-${port}`, { room, seed: false, websocketProvider: wsPeer(url) })
    handles.push(a, b)
    await Promise.all([a.whenSynced, b.whenSynced])

    appendBlock(a.doc, 'paragraph', 'hello from A')

    await waitFor(() => JSON.stringify(blockViews(b.doc)) === JSON.stringify(blockViews(a.doc)))
    expect(blockViews(b.doc)).toEqual(blockViews(a.doc))
    expect(blockViews(b.doc).some((v) => v.text === 'hello from A')).toBe(true)
  })

  it('boots offline: whenSynced resolves from local persistence when the server is unreachable', async () => {
    const dead = await freePort() // nothing is listening here
    const h = openDoc(`peerOffline-${dead}`, {
      room: `room-off-${dead}`,
      seed: true,
      websocketProvider: wsPeer(`ws://127.0.0.1:${dead}`),
    })
    handles.push(h)

    // Must resolve from the local indexeddb 'synced' — if boot awaited the network this would hang.
    await h.whenSynced
    expect(h.network).not.toBeNull()
    expect(blockViews(h.doc).length).toBeGreaterThan(0)
  }, 3000)

  it('destroy() closes the network transport (no leaked reconnect loop)', async () => {
    const port = await freePort()
    server = await startScrollServer({ port })
    const peer = wsPeer(`ws://127.0.0.1:${port}`)
    // Not pushed to `handles` — destroyed explicitly below; double-destroying via afterEach's sweep
    // triggers a stray reconnect that races the server's own teardown (visible now as a benign but
    // noisy Postgres-pool-closed log once the server actually has extensions to complain from).
    const h = openDoc(`peerClose-${port}`, { room: `room-${port}`, seed: true, websocketProvider: peer })
    await h.whenSynced
    await waitFor(() => peer.shouldConnect)

    h.destroy()

    // preserveConnection:false must let destroy() disconnect the socket; without the fix it stays true.
    expect(peer.shouldConnect).toBe(false)
  })
})
