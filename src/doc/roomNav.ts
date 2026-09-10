import { newDocId } from './ids'

// room + ws live in the query string (App reads location.search), so switching docs is a navigation,
// not a hash change — assign() reloads with the new room while preserving any ?ws override. isNew tags a
// freshly created room so App seeds it; opening an existing doc omits the flag so its content isn't polluted.
export function openDocRoom(room: string, isNew = false): void {
  const url = new URL(window.location.href)
  url.searchParams.set('room', room)
  if (isNew) url.searchParams.set('new', '1')
  url.hash = ''
  window.location.assign(url.toString())
}

export function createDocRoom(): void {
  openDocRoom(newDocId(), true)
}

const WS_KEY = 'scroll.lastWs'

export function rememberWs(ws?: string): void {
  if (!ws) return
  try {
    localStorage.setItem(WS_KEY, ws)
  } catch {
    /* storage unavailable — home falls back to ?ws or not-connected */
  }
}

function recallWs(): string | null {
  const fromUrl = new URL(window.location.href).searchParams.get('ws')
  if (fromUrl) return fromUrl
  try {
    return localStorage.getItem(WS_KEY)
  } catch {
    return null
  }
}

// Home = the doc picker, which needs a relay to list docs. Carry the current ?ws, else the last relay this
// browser used, so home works even from a room-only (pure-local) tab instead of stranding on "not connected".
export function goHome(): void {
  const ws = recallWs()
  const url = new URL(window.location.href)
  url.search = ''
  if (ws) url.searchParams.set('ws', ws)
  url.hash = '#/docs'
  window.location.assign(url.toString())
}
