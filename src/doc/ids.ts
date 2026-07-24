export function newBlockId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `b_${crypto.randomUUID()}`
  }
  return `b_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}
