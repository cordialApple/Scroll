export interface Anchor {
  blockId: string
  offset: number
}

export interface HeightModel {
  measured: Map<string, number>
  estimate: (blockId: string) => number
}

export interface Window {
  start: number
  end: number
}

export function heightOf(hm: HeightModel, id: string): number {
  const m = hm.measured.get(id)
  return m !== undefined ? m : hm.estimate(id)
}

export function sumHeights(order: string[], hm: HeightModel, from: number, to: number): number {
  let total = 0
  for (let i = from; i < to; i++) total += heightOf(hm, order[i])
  return total
}

export interface LayoutResult {
  topSpacer: number
  bottomSpacer: number
  anchorOffsetTop: number
  scrollTop: number
  contentHeight: number
}

export function computeLayout(
  order: string[],
  hm: HeightModel,
  window: Window,
  anchor: Anchor,
): LayoutResult {
  const start = clamp(window.start, 0, order.length)
  const end = clamp(window.end, start, order.length)
  const anchorIdx = Math.max(0, order.indexOf(anchor.blockId))

  const topSpacer = sumHeights(order, hm, 0, start)
  const windowHeight = sumHeights(order, hm, start, end)
  const bottomSpacer = sumHeights(order, hm, end, order.length)

  const anchorOffsetTop = sumHeights(order, hm, 0, anchorIdx)
  return {
    topSpacer,
    bottomSpacer,
    anchorOffsetTop,
    scrollTop: anchorOffsetTop + anchor.offset,
    contentHeight: topSpacer + windowHeight + bottomSpacer,
  }
}

export function deriveAnchor(
  scrollTop: number,
  order: string[],
  hm: HeightModel,
): Anchor {
  if (order.length === 0) return { blockId: '', offset: 0 }
  const target = Math.max(0, scrollTop)
  let cum = 0
  for (let i = 0; i < order.length; i++) {
    const h = heightOf(hm, order[i])
    if (cum + h > target || i === order.length - 1) {
      return { blockId: order[i], offset: target - cum }
    }
    cum += h
  }
  return { blockId: order[order.length - 1], offset: 0 }
}

export function windowFor(
  order: string[],
  hm: HeightModel,
  anchor: Anchor,
  viewportHeight: number,
  overscan: number,
): Window {
  const n = order.length
  const anchorIdx = Math.max(0, order.indexOf(anchor.blockId))
  let start = anchorIdx
  let above = 0
  while (start > 0 && above < viewportHeight + overscan) {
    start--
    above += heightOf(hm, order[start])
  }
  let end = anchorIdx + 1
  let below = anchor.offset < 0 ? -anchor.offset : 0
  while (end < n && below < viewportHeight * 2 + overscan) {
    below += heightOf(hm, order[end])
    end++
  }
  return { start, end }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
