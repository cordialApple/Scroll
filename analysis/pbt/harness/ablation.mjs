// Ablation study: does the SWEEP's 100%-by-10-cases result depend on generator + oracle strength?
// Reproduces two documented dev-time lessons from the transcripts:
//   - rule_equivalence_pbt_boundary_teeth: random offsets miss > vs >=; exact-boundary probes catch it.
//   - rule_uniform_generator_degeneracy_prefix_oracle: constant weights make prefix-sum equivalence vacuous.
// Plus a third axis the transcripts imply: order-of-execution faults need long op sequences.
import { readFileSync, writeFileSync } from 'node:fs'
import { transform } from 'esbuild'
import fc from 'fast-check'

const SRC = 'src/layout/orderIndex.ts'
const OUT = 'test-results/stryker-pbt/ablation.json'
const orig = readFileSync(SRC, 'utf8')
async function load(code) {
  const js = (await transform(code, { loader: 'ts', format: 'esm' })).code
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}
const pristine = await load(orig)
const buildArray = pristine.buildArrayOrderIndex

function makeMutArb(hArb) {
  return fc.oneof(
    fc.record({ k: fc.constant('insert'), sel: fc.nat(), h: hArb }),
    fc.record({ k: fc.constant('remove'), sel: fc.nat() }),
    fc.record({ k: fc.constant('setHeight'), sel: fc.nat(), h: hArb }),
  )
}
function assertEqual(treap, array, boundary) {
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
  // strong oracle: probe every prefix-sum boundary +-1 (where > vs >= surfaces).
  // weak oracle: only a few arbitrary offsets (the documented "random points miss it" failure mode).
  const probes = []
  if (boundary) {
    probes.push(-5, 0)
    for (let k = 0; k <= n; k++) { const p = array.prefixHeight(k); probes.push(p - 1, p, p + 1) }
    probes.push(array.totalHeight() + 500)
  } else {
    probes.push(0, 37, 128, 501, 2999)
  }
  for (const px of probes) {
    const a = treap.findByOffset(px), b = array.findByOffset(px)
    if (a.id !== b.id || a.offset !== b.offset) return false
  }
  return true
}
function makeProperty(buildTreap, cfg) {
  const hArb = cfg.constH != null ? fc.constant(cfg.constH) : fc.integer({ min: 1, max: 300 })
  return fc.property(
    fc.array(hArb, { maxLength: 25 }),
    fc.array(makeMutArb(hArb), { maxLength: cfg.opLen }),
    (baseHeights, muts) => {
      const order = baseHeights.map((_, i) => `b${i}`)
      const hmap = new Map(order.map((id, i) => [id, baseHeights[i]]))
      const heightOf = (id) => hmap.get(id) ?? 0
      const treap = buildTreap([...order], heightOf), array = buildArray([...order], heightOf)
      for (let mi = 0; mi < muts.length; mi++) {
        const m = muts[mi]
        if (m.k === 'insert') {
          const id = `x${mi}`, at = order.length === 0 ? 0 : m.sel % (order.length + 1)
          const afterId = at === 0 ? null : order[at - 1]
          order.splice(at, 0, id); hmap.set(id, m.h)
          treap.insertAfter(afterId, id, m.h); array.insertAfter(afterId, id, m.h)
        } else if (order.length > 0 && m.k === 'remove') {
          const id = order[m.sel % order.length]; order.splice(order.indexOf(id), 1)
          treap.remove(id); array.remove(id)
        } else if (order.length > 0 && m.k === 'setHeight') {
          const id = order[m.sel % order.length]; hmap.set(id, m.h)
          treap.setHeight(id, m.h); array.setHeight(id, m.h)
        }
        if (!assertEqual(treap, array, cfg.boundary)) return false
      }
      return true
    },
  )
}

const MUTANTS = [
  { id: 'A1', cls: 'index-off-by-one', find: `  n.size = 1 + tsize(n.left) + tsize(n.right)`, repl: `  n.size = tsize(n.left) + tsize(n.right)` },
  { id: 'A2', cls: 'index-off-by-one', find: `      if (cur === cur.parent.right) rank += tsize(cur.parent.left) + 1`, repl: `      if (cur === cur.parent.right) rank += tsize(cur.parent.left)` },
  { id: 'A3', cls: 'index-off-by-one', find: `        k -= ls + 1`, repl: `        k -= ls` },
  { id: 'A4', cls: 'index-off-by-one', find: `        need -= ls + 1`, repl: `        need -= ls` },
  { id: 'B1', cls: 'boundary-comparator', find: `      if (throughNode <= target) {`, repl: `      if (throughNode < target) {` },
  { id: 'B2', cls: 'boundary-comparator', find: `  if (k <= ls) {`, repl: `  if (k < ls) {` },
  { id: 'B3', cls: 'boundary-comparator', find: `      if (need <= ls) {`, repl: `      if (need < ls) {` },
  { id: 'B4', cls: 'boundary-comparator', find: `      if (k < ls) n = n.left`, repl: `      if (k <= ls) n = n.left` },
  { id: 'C1', cls: 'dropped-term', find: `  n.sumH = n.height + tsum(n.left) + tsum(n.right)`, repl: `  n.sumH = tsum(n.left) + tsum(n.right)` },
  { id: 'C2', cls: 'dropped-term', find: `        acc += tsum(n.left) + n.height`, repl: `        acc += tsum(n.left)` },
  { id: 'C3', cls: 'dropped-term', find: `      const throughNode = acc + tsum(n.left) + n.height`, repl: `      const throughNode = acc + tsum(n.left)` },
  { id: 'C4', cls: 'dropped-term', find: `      cur.sumH = cur.height + tsum(cur.left) + tsum(cur.right)`, repl: `      cur.sumH = tsum(cur.left) + tsum(cur.right)` },
  { id: 'D1', cls: 'exec-order-linkage', find: `    b.left = tmerge(a, b.left)`, repl: `    b.left = tmerge(b.left, a)` },
  { id: 'D2', cls: 'exec-order-linkage', find: `  a.right = tmerge(a.right, b)`, repl: `  a.right = tmerge(b, a.right)` },
  { id: 'D3', cls: 'exec-order-linkage', find: `    this.root = tmerge(tmerge(l, node), r)`, repl: `    this.root = tmerge(tmerge(node, l), r)` },
  { id: 'D4', cls: 'exec-order-linkage', find: `  if (n.right) n.right.parent = n`, repl: `  if (n.right) n.right.parent = null` },
  { id: 'E1', cls: 'split-rank-boundary', find: `  const [l, r] = tsplit(root.right, k - ls - 1)`, repl: `  const [l, r] = tsplit(root.right, k - ls)` },
  { id: 'E2', cls: 'split-rank-boundary', find: `    const [, r] = tsplit(rest, 1)`, repl: `    const [, r] = tsplit(rest, 0)` },
  { id: 'E3', cls: 'split-rank-boundary', find: `        pos += tsize(n.left) + 1`, repl: `        pos += tsize(n.left)` },
  { id: 'E4', cls: 'split-rank-boundary', find: `    const [l, r] = tsplit(this.root, at)`, repl: `    const [l, r] = tsplit(this.root, at - 1)` },
]

const CONFIGS = [
  { key: 'full', label: 'Full (strong gen + strong oracle)', cfg: { opLen: 40, boundary: true, constH: null } },
  { key: 'no-boundary', label: 'Weak oracle (no exact-boundary probes)', cfg: { opLen: 40, boundary: false, constH: null } },
  { key: 'const-weight', label: 'Weak generator (all heights equal)', cfg: { opLen: 40, boundary: true, constH: 10 } },
  { key: 'short-ops', label: 'Weak generator (op sequences ≤2)', cfg: { opLen: 2, boundary: true, constH: null } },
]
const BUDGETS = [10, 100, 1000]
const SEEDS = [1, 2, 3, 4, 5]

const CLASSES = [...new Set(MUTANTS.map((m) => m.cls))]
const results = { budgets: BUDGETS, seeds: SEEDS.length, configs: [] }
for (const C of CONFIGS) {
  const perMut = []
  for (const m of MUTANTS) {
    const mod = await load(orig.replace(m.find, m.repl))
    const prop = makeProperty(mod.buildOrderIndex, C.cfg)
    const pb = {}
    for (const b of BUDGETS) {
      let det = 0
      for (const s of SEEDS) { try { fc.assert(prop, { numRuns: b, seed: s }) } catch { det++ } }
      pb[b] = det / SEEDS.length
    }
    perMut.push({ id: m.id, cls: m.cls, pb })
  }
  const byClass = {}
  for (const cls of CLASSES) {
    const g = perMut.filter((r) => r.cls === cls)
    byClass[cls] = {}
    for (const b of BUDGETS) byClass[cls][b] = g.reduce((s, r) => s + r.pb[b], 0) / g.length
  }
  const overall = {}
  for (const b of BUDGETS) overall[b] = perMut.reduce((s, r) => s + r.pb[b], 0) / perMut.length
  results.configs.push({ key: C.key, label: C.label, byClass, overall, perMut })
  writeFileSync(OUT, JSON.stringify(results, null, 2))
  console.log(`\n[${C.key}] ${C.label}  overall @${BUDGETS.join('/')} = ${BUDGETS.map((b) => (overall[b] * 100).toFixed(0) + '%').join(' ')}`)
  for (const cls of CLASSES) console.log('   ', cls.padEnd(20), BUDGETS.map((b) => (byClass[cls][b] * 100).toFixed(0).padStart(3) + '%').join(' '))
}
console.log('\ndone ->', OUT)
