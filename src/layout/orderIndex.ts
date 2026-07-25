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

// Fenwick (BIT) over per-position heights: point update + prefix O(log n); findLE (largest prefix ≤ target) = O(log n) core of findByOffset
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

// Array+Fenwick backing: setHeight O(log n), but structural insert/remove rebuild the Fenwick O(n). Was
// the first-cut default; now retained as the differential oracle for TreapOrderIndex (which supersedes it
// as the live backing with O(log n) structural ops). Kept because it's the simplest correct reference.
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

// Treap backing: implicit (position-keyed) order-statistics treap balanced by a hash-derived priority,
// so structural insertAfter/remove are O(log n) instead of ArrayOrderIndex's O(n) rebuild. Every method
// is behaviour-identical to ArrayOrderIndex (a differential PBT pins them equal). Priorities come from an
// FNV-1a hash of the id, not Math.random — deterministic (survives the PBT entropy freeze) and balanced
// in expectation since ids are unique. Split/merge by rank only, no rotations. Parent pointers let
// indexOf walk up to a rank and setHeight repair sumH upward, both O(log n).
class TNode {
  size = 1
  sumH: number
  left: TNode | null = null
  right: TNode | null = null
  parent: TNode | null = null
  constructor(
    readonly id: string,
    public height: number,
    readonly prio: number,
  ) {
    this.sumH = height
  }
}

function tsize(n: TNode | null): number {
  return n === null ? 0 : n.size
}
function tsum(n: TNode | null): number {
  return n === null ? 0 : n.sumH
}
function tpull(n: TNode): void {
  n.size = 1 + tsize(n.left) + tsize(n.right)
  n.sumH = n.height + tsum(n.left) + tsum(n.right)
  if (n.left) n.left.parent = n
  if (n.right) n.right.parent = n
}

function tmerge(a: TNode | null, b: TNode | null): TNode | null {
  if (a === null) return b
  if (b === null) return a
  if (a.prio < b.prio) {
    b.left = tmerge(a, b.left)
    tpull(b)
    return b
  }
  a.right = tmerge(a.right, b)
  tpull(a)
  return a
}

// Split `root` into the first `k` nodes (by rank) and the rest.
function tsplit(root: TNode | null, k: number): [TNode | null, TNode | null] {
  if (root === null) return [null, null]
  const ls = tsize(root.left)
  if (k <= ls) {
    const [l, r] = tsplit(root.left, k)
    root.left = r
    tpull(root)
    if (l) l.parent = null
    return [l, root]
  }
  const [l, r] = tsplit(root.right, k - ls - 1)
  root.right = l
  tpull(root)
  if (r) r.parent = null
  return [root, r]
}

// FNV-1a followed by a murmur3 fmix32 avalanche — the finalizer decorrelates the near-sequential block
// ids so priorities distribute uniformly and the treap balances to ~log2(n), not a hash-clustered path.
function fnv1a(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 16
  h = Math.imul(h, 2246822507)
  h ^= h >>> 13
  h = Math.imul(h, 3266489909)
  h ^= h >>> 16
  return h >>> 0
}

class TreapOrderIndex implements OrderIndex {
  private root: TNode | null = null
  private nodes = new Map<string, TNode>()

  static build(order: string[], heightOf: (id: string) => number): TreapOrderIndex {
    const ix = new TreapOrderIndex()
    for (const id of order) {
      const node = new TNode(id, heightOf(id), fnv1a(id))
      ix.root = tmerge(ix.root, node)
      ix.nodes.set(id, node)
    }
    if (ix.root) ix.root.parent = null
    return ix
  }

  size(): number {
    return tsize(this.root)
  }
  indexOf(id: string): number {
    const n = this.nodes.get(id)
    if (n === undefined) return -1
    let rank = tsize(n.left)
    let cur: TNode = n
    while (cur.parent !== null) {
      if (cur === cur.parent.right) rank += tsize(cur.parent.left) + 1
      cur = cur.parent
    }
    return rank
  }
  idAt(index: number): string | undefined {
    if (index < 0 || index >= this.size()) return undefined
    let n = this.root
    let k = index
    while (n !== null) {
      const ls = tsize(n.left)
      if (k < ls) n = n.left
      else if (k === ls) return n.id
      else {
        k -= ls + 1
        n = n.right
      }
    }
    return undefined
  }
  prefixHeight(count: number): number {
    let need = Math.max(0, Math.min(count, this.size()))
    let acc = 0
    let n = this.root
    while (n !== null && need > 0) {
      const ls = tsize(n.left)
      if (need <= ls) {
        n = n.left
      } else {
        acc += tsum(n.left) + n.height
        need -= ls + 1
        n = n.right
      }
    }
    return acc
  }
  heightBefore(id: string): number {
    const i = this.indexOf(id)
    return i < 0 ? 0 : this.prefixHeight(i)
  }
  totalHeight(): number {
    return tsum(this.root)
  }
  findByOffset(px: number): { id: string; offset: number } {
    if (this.root === null) return { id: '', offset: 0 }
    const target = Math.max(0, px)
    // findLE: largest count `pos` whose prefixHeight(pos) <= target (matches Fenwick.findLE / deriveAnchor).
    let n: TNode | null = this.root
    let pos = 0
    let acc = 0
    while (n !== null) {
      const throughNode = acc + tsum(n.left) + n.height
      if (throughNode <= target) {
        acc = throughNode
        pos += tsize(n.left) + 1
        n = n.right
      } else {
        n = n.left
      }
    }
    const idx = Math.min(pos, this.size() - 1)
    return { id: this.idAt(idx)!, offset: target - this.prefixHeight(idx) }
  }
  insertAfter(afterId: string | null, id: string, height: number): void {
    const at =
      afterId === null ? 0 : (this.nodes.has(afterId) ? this.indexOf(afterId) : this.size() - 1) + 1
    const node = new TNode(id, height, fnv1a(id))
    const [l, r] = tsplit(this.root, at)
    this.root = tmerge(tmerge(l, node), r)
    if (this.root) this.root.parent = null
    this.nodes.set(id, node)
  }
  remove(id: string): void {
    const n = this.nodes.get(id)
    if (n === undefined) return
    const at = this.indexOf(id)
    const [l, rest] = tsplit(this.root, at)
    const [, r] = tsplit(rest, 1)
    this.root = tmerge(l, r)
    if (this.root) this.root.parent = null
    this.nodes.delete(id)
  }
  setHeight(id: string, height: number): void {
    const n = this.nodes.get(id)
    if (n === undefined) return
    n.height = height
    let cur: TNode | null = n
    while (cur !== null) {
      cur.sumH = cur.height + tsum(cur.left) + tsum(cur.right)
      cur = cur.parent
    }
  }
  order(): string[] {
    const out: string[] = []
    const walk = (n: TNode | null): void => {
      if (n === null) return
      walk(n.left)
      out.push(n.id)
      walk(n.right)
    }
    walk(this.root)
    return out
  }
  // test-only: max root-to-leaf depth, for the balance (O(log n)) sanity check.
  depth(): number {
    const d = (n: TNode | null): number => (n === null ? 0 : 1 + Math.max(d(n.left), d(n.right)))
    return d(this.root)
  }
}

export function buildOrderIndex(order: string[], heightOf: (id: string) => number): OrderIndex {
  return TreapOrderIndex.build(order, heightOf)
}

// The array/Fenwick backing, retained as the differential oracle for the treap's PBT.
export function buildArrayOrderIndex(order: string[], heightOf: (id: string) => number): OrderIndex {
  return ArrayOrderIndex.build(order, heightOf)
}

export { TreapOrderIndex }
