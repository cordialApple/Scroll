export function newBlockId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `b_${crypto.randomUUID()}`
  }
  return `b_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

export function newEndpointId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().slice(0, 8)
  }
  return `${Math.random().toString(36).slice(2, 10)}`
}
