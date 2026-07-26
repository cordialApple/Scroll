import type { PresenceUser } from './awareness'

const COLORS = ['#e0567a', '#3aa0ff', '#31b57a', '#d9843b', '#8b5cf6', '#159a9a', '#c2410c']

function pick<T>(arr: T[], n: number): T {
  return arr[Math.abs(n) % arr.length]
}

export function makePresenceUser(): PresenceUser {
  const id = Math.random().toString(36).slice(2, 8)
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0
  return { id, name: `peer ${id}`, color: pick(COLORS, h) }
}
