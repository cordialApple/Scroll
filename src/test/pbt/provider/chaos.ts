import { WebSocket } from 'ws'

// Socket-level chaos, one controller per peer. It wraps the real `ws` transport the Hocuspocus provider
// drives, so loss/reconnect happen on the actual wire — not a modelled network. The provider builds a
// fresh polyfill instance on every (re)connect, so the controller tracks the live set rather than one
// socket, and its knobs (drop/dupe) survive reconnects.
export class ChaosController {
  private live = new Set<WebSocket>()
  drop = false
  dupe = false

  register(ws: WebSocket): void {
    this.live.add(ws)
    ws.addEventListener('close', () => this.live.delete(ws))
  }

  // Hard TCP reset (no clean close frame) — models an abrupt network cut and makes the provider
  // reconnect and re-run the sync handshake, which is where drop-then-reconnect recovery is exercised.
  cut(): void {
    for (const ws of this.live) {
      try {
        ws.terminate()
      } catch {
        // socket already dead — nothing to cut
      }
    }
  }

  polyfill(): typeof WebSocket {
    const ctrl = this
    return class ChaosSocket extends WebSocket {
      constructor(url: string) {
        super(url)
        ctrl.register(this)
        // Cutting/destroying a socket mid-handshake makes ws emit 'error' ("closed before the connection
        // was established") AFTER the provider has already removed its own listeners — with no handler
        // Node escalates it to an uncaught exception. These teardown errors are expected under chaos;
        // a permanent no-op handler keeps them from failing the run. 'close'-driven reconnect is intact.
        this.on('error', () => {})
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send(data: any, ...rest: any[]): void {
        if (ctrl.drop) return // frame lost on the wire; the sender still believes it sent
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        super.send(data, ...(rest as [any]))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (ctrl.dupe) super.send(data, ...(rest as [any]))
      }
    } as unknown as typeof WebSocket
  }
}
