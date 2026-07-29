// PBT effectiveness sweep on ONE stateful component: TreapOrderIndex (src/layout/orderIndex.ts).
// 5 fault classes x 4 mutants = 20. For each mutant, sweep numRuns across ~3 orders of magnitude,
// 10 seeds each, record detection rate. SUT = mutated treap; oracle = pristine array/Fenwick backing.
// Differential property ported verbatim from src/test/pbt/orderIndexTreap.pbt.test.ts.
import { readFileSync, writeFileSync } from 'node:fs'
import { transform } from 'esbuild'
import fc from 'fast-check'

const SRC = 'src/layout/orderIndex.ts'
const OUT = 'test-results/stryker-pbt/sweep.json'
const orig = readFileSync(SRC, 'utf8')

async function load(code) {
  const js = (await transform(code, { loader: 'ts', format: 'esm' })).code
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}

// ---- oracle (pristine array/Fenwick backing), loaded once ----
const pristine = await load(orig)
const buildArray = pristine.buildArrayOrderIndex

// ---- differential oracle, ported verbatim from orderIndexTreap.pbt.test.ts ----
const mutArb = fc.oneof(
  fc.record({ k: fc.constant('insert'), sel: fc.nat(), h: fc.integer({ min: 1, max: 300 }) }),
  fc.record({ k: fc.constant('remove'), sel: fc.nat() }),
  fc.record({ k: fc.constant('setHeight'), sel: fc.nat(), h: fc.integer({ min: 1, max: 300 }) }),
)
function assertEqual(treap, array) {
  if (treap.size() !== array.size()) return false
  if (JSON.stringify(treap.order()) !== JSON.stringify(array.order())) return false
  const n = array.size()
  for (let i = -1; i <= n; i++) if (treap.idAt(i) !== array.idAt(i)) return false
  for (let k = 0; k <= n; k++) if (treap.prefixHeight(k) !== array.prefixHeight(k)) return false
  if (treap.totalHeight() !== array.totalHeight()) return false
  for (const id of array.order()) {
    if (treap.indexOf(id) !== array.indexOf(id)) return false
    if (treap.heightBefore(id) !== array.heightBefore(id)) return false
  }
  const boundaries = [-5, 0]
  for (let k = 0; k <= n; k++) {
    const p = array.prefixHeight(k)
    boundaries.push(p - 1, p, p + 1)
  }
  boundaries.push(array.totalHeight() + 500)
  for (const px of boundaries) {
    const a = treap.findByOffset(px)
    const b = array.findByOffset(px)
    if (a.id !== b.id || a.offset !== b.offset) return false
  }
  return true
}
function makeProperty(buildTreap) {
  return fc.property(
    fc.array(fc.integer({ min: 1, max: 300 }), { maxLength: 25 }),
    fc.array(mutArb, { maxLength: 40 }),
    (baseHeights, muts) => {
      const order = baseHeights.map((_, i) => `b${i}`)
      const hmap = new Map(order.map((id, i) => [id, baseHeights[i]]))
      const heightOf = (id) => hmap.get(id) ?? 0
      const treap = buildTreap([...order], heightOf)
      const array = buildArray([...order], heightOf)
      for (let mi = 0; mi < muts.length; mi++) {
        const m = muts[mi]
        if (m.k === 'insert') {
          const id = `x${mi}`
          const at = order.length === 0 ? 0 : m.sel % (order.length + 1)
          const afterId = at === 0 ? null : order[at - 1]
          order.splice(at, 0, id); hmap.set(id, m.h)
          treap.insertAfter(afterId, id, m.h); array.insertAfter(afterId, id, m.h)
        } else if (order.length > 0 && m.k === 'remove') {
          const id = order[m.sel % order.length]
          order.splice(order.indexOf(id), 1)
          treap.remove(id); array.remove(id)
        } else if (order.length > 0 && m.k === 'setHeight') {
          const id = order[m.sel % order.length]
          hmap.set(id, m.h)
          treap.setHeight(id, m.h); array.setHeight(id, m.h)
        }
        if (!assertEqual(treap, array)) return false
      }
      return true
    },
  )
}

// ---- 20 mutants: 5 fault classes x 4, all in treap-specific code ----
const MUTANTS = [
  // A: index off-by-one (rank/size accounting)
  { id: 'A1', cls: 'index-off-by-one', find: `  n.size = 1 + tsize(n.left) + tsize(n.right)`, repl: `  n.size = tsize(n.left) + tsize(n.right)` },
  { id: 'A2', cls: 'index-off-by-one', find: `      if (cur === cur.parent.right) rank += tsize(cur.parent.left) + 1`, repl: `      if (cur === cur.parent.right) rank += tsize(cur.parent.left)` },
  { id: 'A3', cls: 'index-off-by-one', find: `        k -= ls + 1`, repl: `        k -= ls` },
  { id: 'A4', cls: 'index-off-by-one', find: `        need -= ls + 1`, repl: `        need -= ls` },
  // B: boundary comparator (< vs <=)
  { id: 'B1', cls: 'boundary-comparator', find: `      if (throughNode <= target) {`, repl: `      if (throughNode < target) {` },
  { id: 'B2', cls: 'boundary-comparator', find: `  if (k <= ls) {`, repl: `  if (k < ls) {` },
  { id: 'B3', cls: 'boundary-comparator', find: `      if (need <= ls) {`, repl: `      if (need < ls) {` },
  { id: 'B4', cls: 'boundary-comparator', find: `      if (k < ls) n = n.left`, repl: `      if (k <= ls) n = n.left` },
  // C: dropped height term (arithmetic)
  { id: 'C1', cls: 'dropped-term', find: `  n.sumH = n.height + tsum(n.left) + tsum(n.right)`, repl: `  n.sumH = tsum(n.left) + tsum(n.right)` },
  { id: 'C2', cls: 'dropped-term', find: `        acc += tsum(n.left) + n.height`, repl: `        acc += tsum(n.left)` },
  { id: 'C3', cls: 'dropped-term', find: `      const throughNode = acc + tsum(n.left) + n.height`, repl: `      const throughNode = acc + tsum(n.left)` },
  { id: 'C4', cls: 'dropped-term', find: `      cur.sumH = cur.height + tsum(cur.left) + tsum(cur.right)`, repl: `      cur.sumH = tsum(cur.left) + tsum(cur.right)` },
  // D: execution order / pointer linkage
  { id: 'D1', cls: 'exec-order-linkage', find: `    b.left = tmerge(a, b.left)`, repl: `    b.left = tmerge(b.left, a)` },
  { id: 'D2', cls: 'exec-order-linkage', find: `  a.right = tmerge(a.right, b)`, repl: `  a.right = tmerge(b, a.right)` },
  { id: 'D3', cls: 'exec-order-linkage', find: `    this.root = tmerge(tmerge(l, node), r)`, repl: `    this.root = tmerge(tmerge(node, l), r)` },
  { id: 'D4', cls: 'exec-order-linkage', find: `  if (n.right) n.right.parent = n`, repl: `  if (n.right) n.right.parent = null` },
  // E: split/merge rank boundary (structural)
  { id: 'E1', cls: 'split-rank-boundary', find: `  const [l, r] = tsplit(root.right, k - ls - 1)`, repl: `  const [l, r] = tsplit(root.right, k - ls)` },
  { id: 'E2', cls: 'split-rank-boundary', find: `    const [, r] = tsplit(rest, 1)`, repl: `    const [, r] = tsplit(rest, 0)` },
  { id: 'E3', cls: 'split-rank-boundary', find: `        pos += tsize(n.left) + 1`, repl: `        pos += tsize(n.left)` },
  { id: 'E4', cls: 'split-rank-boundary', find: `    const [l, r] = tsplit(this.root, at)`, repl: `    const [l, r] = tsplit(this.root, at - 1)` },
]

const BUDGETS = [1, 3, 10, 30, 100, 300, 1000, 3000]
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

// control: pristine treap must never be detected (validates harness isn't rigged)
function sweepDetection(buildTreap) {
  const prop = makeProperty(buildTreap)
  const perBudget = {}
  for (const b of BUDGETS) {
    let det = 0
    for (const s of SEEDS) {
      try { fc.assert(prop, { numRuns: b, seed: s }) } catch { det++ }
    }
    perBudget[b] = det / SEEDS.length
  }
  return perBudget
}

const results = { control: sweepDetection(pristine.buildOrderIndex), budgets: BUDGETS, seeds: SEEDS.length, mutants: [] }
console.log('CONTROL (want all 0):', BUDGETS.map((b) => results.control[b]).join(' '))

for (const m of MUTANTS) {
  const occ = orig.split(m.find).length - 1
  if (occ !== 1) { results.mutants.push({ ...m, error: `find matched ${occ}x` }); console.log(m.id, 'SKIP find x' + occ); continue }
  const mod = await load(orig.replace(m.find, m.repl))
  const perBudget = sweepDetection(mod.buildOrderIndex)
  const firstFull = BUDGETS.find((b) => perBudget[b] === 1) ?? null
  results.mutants.push({ id: m.id, cls: m.cls, perBudget, firstFullDetectBudget: firstFull })
  writeFileSync(OUT, JSON.stringify(results, null, 2))
  console.log(m.id, m.cls.padEnd(20), BUDGETS.map((b) => perBudget[b].toFixed(1)).join(' '), '| 100% @', firstFull)
}

// aggregate detection rate vs budget (mean over 20 mutants x 10 seeds)
const agg = {}, byClass = {}
for (const b of BUDGETS) {
  const real = results.mutants.filter((r) => !r.error)
  agg[b] = real.reduce((s, r) => s + r.perBudget[b], 0) / real.length
  for (const cls of [...new Set(real.map((r) => r.cls))]) {
    const g = real.filter((r) => r.cls === cls)
    ;(byClass[cls] ??= {})[b] = g.reduce((s, r) => s + r.perBudget[b], 0) / g.length
  }
}
results.aggregate = agg
results.byClass = byClass
writeFileSync(OUT, JSON.stringify(results, null, 2))
console.log('\nAGGREGATE detection vs budget:')
console.log(BUDGETS.join('\t'))
console.log(BUDGETS.map((b) => (agg[b] * 100).toFixed(0) + '%').join('\t'))
