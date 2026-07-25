import * as Y from 'yjs'
import { blocks, blockId, blockType, blockText } from '../doc/model'
import { estimateHeight } from '../layout/estimate'
import { buildOrderIndex, type OrderIndex } from '../layout/orderIndex'

// Incrementally-maintained mirror of the doc's block order + per-block estimate, plus two order
// indices: `ix` holds effective heights (measured ?? estimate) for computeLayoutIndexed; `ixEst`
// holds estimate-only heights for windowForIndexed, so the render window stays estimate-stable and
// does not shift as DOM measurements arrive (preserving the pre-Stage-4 windowing behavior).
export interface DocModel {
  order: string[]
  estimates: Map<string, number>
  ix: OrderIndex
  ixEst: OrderIndex
}

export interface HeightSource {
  measuredOf: (id: string) => number | undefined
}

function estimateFor(m: Y.Map<unknown>): number {
  return estimateHeight({ type: blockType(m), textLength: blockText(m).length })
}

function effective(id: string, est: number, src: HeightSource): number {
  return src.measuredOf(id) ?? est
}

export function buildDocModel(doc: Y.Doc, src: HeightSource): DocModel {
  const arr = blocks(doc)
  const order: string[] = []
  const estimates = new Map<string, number>()
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i)
    const id = blockId(m)
    order.push(id)
    estimates.set(id, estimateFor(m))
  }
  const ix = buildOrderIndex(order, (id) => effective(id, estimates.get(id) ?? 40, src))
  const ixEst = buildOrderIndex(order, (id) => estimates.get(id) ?? 40)
  return { order, estimates, ix, ixEst }
}

// Apply one observeDeep batch incrementally. Structural (array) events are processed before text
// events so a text edit on a block deleted in the same transaction is correctly skipped.
export function applyEvents(
  model: DocModel,
  doc: Y.Doc,
  events: Y.YEvent<Y.AbstractType<unknown>>[],
  src: HeightSource,
): void {
  const arr = blocks(doc)
  for (const ev of events) if (ev.target === arr) applyArrayDelta(model, ev as Y.YArrayEvent<Y.Map<unknown>>, src)
  for (const ev of events) if (ev.target !== arr) applyTextChange(model, ev, src)
}

function applyArrayDelta(model: DocModel, ev: Y.YArrayEvent<Y.Map<unknown>>, src: HeightSource): void {
  let cursor = 0
  for (const d of ev.changes.delta) {
    if (d.retain !== undefined) {
      cursor += d.retain
    } else if (d.delete !== undefined) {
      for (let k = 0; k < d.delete; k++) {
        const id = model.order[cursor]
        model.order.splice(cursor, 1)
        model.estimates.delete(id)
        model.ix.remove(id)
        model.ixEst.remove(id)
      }
    } else if (d.insert !== undefined) {
      for (const m of d.insert as Y.Map<unknown>[]) {
        const id = blockId(m)
        const est = estimateFor(m)
        const afterId = cursor > 0 ? model.order[cursor - 1] : null
        model.order.splice(cursor, 0, id)
        model.estimates.set(id, est)
        model.ix.insertAfter(afterId, id, effective(id, est, src))
        model.ixEst.insertAfter(afterId, id, est)
        cursor++
      }
    }
  }
}

function applyTextChange(model: DocModel, ev: Y.YEvent<Y.AbstractType<unknown>>, src: HeightSource): void {
  const parent = ev.target.parent
  if (!(parent instanceof Y.Map)) return
  const id = blockId(parent as Y.Map<unknown>)
  if (model.ix.indexOf(id) < 0) return
  const est = estimateFor(parent as Y.Map<unknown>)
  model.estimates.set(id, est)
  model.ix.setHeight(id, effective(id, est, src))
  model.ixEst.setHeight(id, est)
}

// Called by the owner when a block's measured height changes (DOM measurement), re-syncing only the
// effective index — estimates and ixEst are untouched, keeping the window estimate-stable.
export function setMeasured(model: DocModel, id: string, src: HeightSource): void {
  if (model.ix.indexOf(id) < 0) return
  model.ix.setHeight(id, effective(id, model.estimates.get(id) ?? 40, src))
}

export interface Band {
  start: number
  end: number
}

// Bound the measured-height cache to O(band): drop entries for blocks outside
// [window.start - margin, window.end + margin] (or no longer in the doc), never the anchor. `ix` is
// deliberately NOT touched — the evicted block keeps its last effective height, so spacers are
// unchanged and the camera cannot jump; on re-entry the block re-measures, and an off-screen edit
// naturally reverts it to the estimate via applyTextChange (that path is already anti-jump-corrected).
// Returns the number of entries evicted.
export function evictHeightsOutsideBand(
  heights: Map<string, number>,
  ix: OrderIndex,
  window: Band,
  keepId: string,
  margin: number,
): number {
  const lo = window.start - margin
  const hi = window.end + margin
  let evicted = 0
  for (const id of [...heights.keys()]) {
    if (id === keepId) continue
    const idx = ix.indexOf(id)
    if (idx < 0 || idx < lo || idx >= hi) {
      heights.delete(id)
      evicted++
    }
  }
  return evicted
}
