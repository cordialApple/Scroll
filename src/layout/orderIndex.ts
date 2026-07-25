export interface OrderIndex {
  size(): number
  indexOf(id: string): number
  idAt(index: number): string | undefined
  prefixHeight(count: number): number
  heightBefore(id: string): number
  totalHeight(): number
  findByOffset(px: number): { id: string; offset: number }
  insertAfter(afterId: string | null, id: string, height: number): void
  remove(id: string): void
  setHeight(id: string, height: number): void
  order(): string[]
}

// Fenwick (binary indexed tree) over per-position heights. Point update + prefix are O(log n);
// findLE (largest prefix count whose sum ≤ target) is the O(log n) core of findByOffset.
class Fenwick {
  private t: number[]
  constructor(private n: number) {
    this.t = new Array(n + 1).fill(0)
  }
  static from(vals: number[]): Fenwick {
    const f = new Fenwick(vals.length)
    for (let i = 0; i < vals.length; i++) f.add(i, vals[i])
    return f
  }
  add(i: number, delta: number): void {
    for (let k = i + 1; k <= this.n; k += k & -k) this.t[k] += delta
  }
  prefix(count: number): number {
    let s = 0
    for (let k = count; k > 0; k -= k & -k) s += this.t[k]
    return s
  }
  findLE(target: number): number {
    let pos = 0
    let rem = target
    let pw = 1
    while (pw << 1 <= this.n) pw <<= 1
    for (; pw > 0; pw >>= 1) {
      if (pos + pw <= this.n && this.t[pos + pw] <= rem) {
        pos += pw
        rem -= this.t[pos]
      }
    }
    return pos
  }
}

// First-cut backing: array of ids + parallel heights + a Fenwick. setHeight is O(log n); structural
// insert/remove rebuild the Fenwick in O(n) (text edits dominate keystrokes, structure rarely
// changes). The interface is stable, so this can become a treap later without touching consumers.
class ArrayOrderIndex implements OrderIndex {
  private ids: string[] = []
  private heights: number[] = []
  private pos = new Map<string, number>()
  private fen = new Fenwick(0)

  private rebuild(): void {
    this.pos = new Map(this.ids.map((id, i) => [id, i]))
    this.fen = Fenwick.from(this.heights)
  }

  static build(order: string[], heightOf: (id: string) => number): ArrayOrderIndex {
    const ix = new ArrayOrderIndex()
    ix.ids = [...order]
    ix.heights = order.map(heightOf)
    ix.rebuild()
    return ix
  }

  size(): number {
    return this.ids.length
  }
  indexOf(id: string): number {
    return this.pos.get(id) ?? -1
  }
  idAt(index: number): string | undefined {
    return this.ids[index]
  }
  prefixHeight(count: number): number {
    return this.fen.prefix(Math.max(0, Math.min(count, this.ids.length)))
  }
  heightBefore(id: string): number {
    const i = this.indexOf(id)
    return i < 0 ? 0 : this.fen.prefix(i)
  }
  totalHeight(): number {
    return this.fen.prefix(this.ids.length)
  }
  findByOffset(px: number): { id: string; offset: number } {
    if (this.ids.length === 0) return { id: '', offset: 0 }
    const target = Math.max(0, px)
    const idx = Math.min(this.fen.findLE(target), this.ids.length - 1)
    return { id: this.ids[idx], offset: target - this.fen.prefix(idx) }
  }
  insertAfter(afterId: string | null, id: string, height: number): void {
    const at = afterId === null ? 0 : (this.pos.get(afterId) ?? this.ids.length - 1) + 1
    this.ids.splice(at, 0, id)
    this.heights.splice(at, 0, height)
    this.rebuild()
  }
  remove(id: string): void {
    const i = this.pos.get(id)
    if (i === undefined) return
    this.ids.splice(i, 1)
    this.heights.splice(i, 1)
    this.rebuild()
  }
  setHeight(id: string, height: number): void {
    const i = this.pos.get(id)
    if (i === undefined) return
    this.fen.add(i, height - this.heights[i])
    this.heights[i] = height
  }
  order(): string[] {
    return [...this.ids]
  }
}

export function buildOrderIndex(order: string[], heightOf: (id: string) => number): OrderIndex {
  return ArrayOrderIndex.build(order, heightOf)
}
