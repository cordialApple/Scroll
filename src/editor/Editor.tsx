import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import type * as Y from 'yjs'
import {
  blocks,
  blockId,
  blockType,
  blockText,
  resolveBlockIndex,
  redirectSource,
  setBlockText,
  splitBlock,
  mergeIntoPrevious,
  type BlockView,
} from '../doc/model'
import { resolveEffectiveAnchor } from '../doc/anchor'
import { computeLayoutIndexed, windowForIndexed, type Anchor } from '../layout/layout'
import {
  buildDocModel,
  applyEvents,
  setMeasured,
  evictHeightsOutsideBand,
  type DocModel,
  type HeightSource,
} from './docModel'
import { saveCamera } from '../doc/camera'
import { insertAbove, deleteAbove } from '../dev/synthetic'
import { Block } from './Block'
import { getCaretOffset, setCaretOffset } from './caret'
import type { DictationTarget } from '../voice/dictation'

const OVERSCAN = 1200
const EVICT_MARGIN = 500
const EVICT_TRIGGER = 2000

export interface EditorApi {
  insertAbove(n: number): void
  deleteAbove(n: number): void
  mergeAnchorAway(): void
  anchorId(): string
  heightsSize(): number
  dictationTarget(): DictationTarget | null
}

interface Props {
  doc: Y.Doc
  docId: string
  initialAnchor: Anchor | null
  onAnchorChange?: (a: Anchor) => void
}

export const Editor = forwardRef<EditorApi, Props>(function Editor(
  { doc, docId, initialAnchor, onAnchorChange },
  apiRef,
) {
  const [version, forceRender] = useReducer((x) => x + 1, 0)
  const [heightsVersion, bumpHeights] = useReducer((x) => x + 1, 0)
  const [viewportH, setViewportH] = useState(900)
  const [anchor, setAnchor] = useState<Anchor>(
    initialAnchor ?? { blockId: '', offset: 0 },
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const heightsRef = useRef(new Map<string, number>())
  const suppressUntilRef = useRef(0)
  const pendingFocusRef = useRef<{ blockId: string; caret: number } | null>(null)
  const settleRef = useRef<{ key: string; passes: number }>({ key: '', passes: 0 })
  const lastTargetRef = useRef<DictationTarget | null>(null)
  const mutationSeqRef = useRef(0)
  const correctedSeqRef = useRef(0)
  const restorePendingRef = useRef(initialAnchor != null)

  const src: HeightSource = useMemo(
    () => ({ measuredOf: (id) => heightsRef.current.get(id) }),
    [],
  )

  // order/estimates/indices, built sync on first render + doc change, synced via observeDeep below.
  // mutated in place — memos key on version/heightsVersion, not model identity
  const modelRef = useRef<DocModel | null>(null)
  const modelDocRef = useRef<Y.Doc | null>(null)
  if (modelRef.current === null || modelDocRef.current !== doc) {
    modelRef.current = buildDocModel(doc, src)
    modelDocRef.current = doc
  }
  const model = modelRef.current

  useEffect(() => {
    const arr = blocks(doc)
    const cb = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      if (modelDocRef.current !== doc) return
      applyEvents(modelRef.current!, doc, events, src)
      mutationSeqRef.current++
      if (import.meta.env.DEV && mutationSeqRef.current % 16 === 0) devDriftCheck(modelRef.current!, doc, src)
      forceRender()
    }
    arr.observeDeep(cb)
    return () => arr.unobserveDeep(cb)
  }, [doc, src])

  const suppressScroll = useCallback(() => {
    suppressUntilRef.current = performance.now() + 250
  }, [])

  const order = model.order

  const effAnchor: Anchor = useMemo(
    () => resolveEffectiveAnchor(order, redirectSource(doc), anchor),
    [doc, order, anchor, version],
  )

  const renderWindow = useMemo(
    () => windowForIndexed(model.ixEst, effAnchor, viewportH, OVERSCAN),
    [model, effAnchor, viewportH, version],
  )

  const layout = useMemo(
    () => computeLayoutIndexed(model.ix, renderWindow, effAnchor),
    [model, renderWindow, effAnchor, version, heightsVersion],
  )

  const rendered: BlockView[] = useMemo(() => {
    const arr = blocks(doc)
    const out: BlockView[] = []
    for (let i = renderWindow.start; i < renderWindow.end; i++) {
      const m = arr.get(i)
      if (m) out.push({ id: blockId(m), type: blockType(m), text: blockText(m).toString() })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, renderWindow.start, renderWindow.end, version])

  const commitAnchor = useCallback(
    (a: Anchor) => {
      setAnchor(a)
      saveCamera(docId, a)
      onAnchorChange?.(a)
    },
    [docId, onAnchorChange],
  )

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return

    let changed = false
    const els = scroller.querySelectorAll<HTMLElement>('[data-block-id]')
    els.forEach((el) => {
      const id = el.dataset.blockId!
      const h = Math.round(el.offsetHeight)
      const prev = heightsRef.current.get(id)
      if (prev === undefined || Math.abs(prev - h) >= 1) {
        heightsRef.current.set(id, h)
        setMeasured(model, id, src)
        changed = true
      }
    })

    if (effAnchor.blockId !== anchor.blockId) setAnchor(effAnchor)

    const contTop = scroller.getBoundingClientRect().top
    const holdCamera =
      restorePendingRef.current || mutationSeqRef.current !== correctedSeqRef.current
    if (holdCamera) {
      const anchorEl = scroller.querySelector<HTMLElement>(
        `[data-block-id="${cssEscape(effAnchor.blockId)}"]`,
      )
      if (anchorEl) {
        const curDelta = anchorEl.getBoundingClientRect().top - contTop
        const correction = curDelta + effAnchor.offset
        if (Math.abs(correction) > 0.5) {
          suppressScroll()
          scroller.scrollTop += correction
        }
        if (Math.abs(correction) <= 1) {
          correctedSeqRef.current = mutationSeqRef.current
          restorePendingRef.current = false
        }
      } else {
        correctedSeqRef.current = mutationSeqRef.current
        restorePendingRef.current = false
      }
    } else if (!changed && performance.now() >= suppressUntilRef.current) {
      let topId = ''
      let topOff = 0
      els.forEach((el) => {
        const r = el.getBoundingClientRect()
        const rt = r.top - contTop
        if (rt <= 1 && rt + r.height > 1) {
          topId = el.dataset.blockId!
          topOff = -rt
        }
      })
      if (topId && (topId !== anchor.blockId || Math.abs(topOff - anchor.offset) > 1)) {
        commitAnchor({ blockId: topId, offset: Math.max(0, topOff) })
      }
    }

    const pf = pendingFocusRef.current
    if (pf) {
      const el = scroller.querySelector<HTMLElement>(`[data-block-id="${cssEscape(pf.blockId)}"]`)
      if (el) {
        el.focus()
        setCaretOffset(el, pf.caret)
        pendingFocusRef.current = null
      }
    }

    const key = `${version}:${renderWindow.start}:${renderWindow.end}`
    if (settleRef.current.key !== key) settleRef.current = { key, passes: 0 }
    if (changed && settleRef.current.passes < 4) {
      settleRef.current.passes++
      bumpHeights()
    } else if (!changed && heightsRef.current.size > evictTrigger()) {
      // settled: reclaim measured-height cache outside band. ix untouched — invisible (no spacer/camera change), no re-render needed
      evictHeightsOutsideBand(heightsRef.current, model.ix, renderWindow, effAnchor.blockId, evictMargin())
    }
  })

  // Track the caret block+offset so dictation has a target even after focus moves to the mic button.
  useEffect(() => {
    const onSel = () => {
      const scroller = scrollRef.current
      const sel = window.getSelection()
      if (!scroller || !sel || sel.rangeCount === 0) return
      let node: Node | null = sel.getRangeAt(0).startContainer
      while (node && node !== scroller) {
        if (node instanceof HTMLElement && node.dataset.blockId) {
          lastTargetRef.current = { blockId: node.dataset.blockId, caret: getCaretOffset(node) }
          return
        }
        node = node.parentNode
      }
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setViewportH(scroller.clientHeight || 900))
    ro.observe(scroller)
    setViewportH(scroller.clientHeight || 900)
    return () => ro.disconnect()
  }, [])

  const onScroll = useCallback(() => {
    if (performance.now() < suppressUntilRef.current) return
    const scroller = scrollRef.current
    if (!scroller) return
    const contTop = scroller.getBoundingClientRect().top
    let domId = ''
    let domOff = 0
    const els = scroller.querySelectorAll<HTMLElement>('[data-block-id]')
    for (const el of els) {
      const r = el.getBoundingClientRect()
      const rt = r.top - contTop
      if (rt <= 1 && rt + r.height > 1) {
        domId = el.dataset.blockId!
        domOff = -rt
        break
      }
    }
    let next: Anchor
    if (domId) {
      next = { blockId: domId, offset: Math.max(0, domOff) }
    } else {
      // fling into spacer: derive from ix (matches spacer geometry, eviction-independent) not heightsRef (diverges from ix once band eviction runs)
      const r = model.ix.findByOffset(scroller.scrollTop)
      next = { blockId: r.id, offset: r.offset }
    }
    if (next.blockId) commitAnchor(next)
  }, [commitAnchor, model])

  // O(log n) at-hint from the live index avoids indexOfBlock's O(n) scan on every keystroke/split/merge;
  // resolveBlockIndex re-verifies it, so a stale hint is corrected, never trusted blind.
  const hintOf = useCallback((id: string) => modelRef.current?.ix.indexOf(id), [])
  const onEdit = useCallback((id: string, text: string) => setBlockText(doc, id, text, hintOf(id)), [doc, hintOf])
  const onSplit = useCallback(
    (id: string, caret: number) => {
      const next = splitBlock(doc, id, caret, hintOf(id))
      if (next) pendingFocusRef.current = { blockId: next, caret: 0 }
    },
    [doc, hintOf],
  )
  const onMerge = useCallback(
    (id: string) => {
      const idx = resolveBlockIndex(doc, id, hintOf(id))
      const prevLen = idx > 0 ? blockText(blocks(doc).get(idx - 1)).length : 0
      const prevId = mergeIntoPrevious(doc, id, idx)
      if (prevId) pendingFocusRef.current = { blockId: prevId, caret: prevLen }
    },
    [doc, hintOf],
  )

  useImperativeHandle(
    apiRef,
    (): EditorApi => ({
      insertAbove: (n) =>
        effAnchor.blockId && insertAbove(doc, effAnchor.blockId, n, 3 + n, model.ix.indexOf(effAnchor.blockId)),
      deleteAbove: (n) =>
        effAnchor.blockId && deleteAbove(doc, effAnchor.blockId, n, model.ix.indexOf(effAnchor.blockId)),
      mergeAnchorAway: () => {
        const id = effAnchor.blockId
        const idx = model.ix.indexOf(id)
        if (idx > 0) mergeIntoPrevious(doc, id, idx)
      },
      anchorId: () => effAnchor.blockId,
      heightsSize: () => heightsRef.current.size,
      dictationTarget: () => lastTargetRef.current,
    }),
    [doc, effAnchor.blockId, model],
  )

  return (
    <div className="canvas" ref={scrollRef} onScroll={onScroll}>
      <div className="sheet-wrap">
        <div className="sheet">
          <div style={{ height: layout.topSpacer }} aria-hidden />
          {rendered.map((v) => (
            <Block key={v.id} view={v} onEdit={onEdit} onSplit={onSplit} onMerge={onMerge} />
          ))}
          <div style={{ height: layout.bottomSpacer }} aria-hidden />
        </div>
      </div>
    </div>
  )
})

function devNum(key: '__scrollEvictTrigger' | '__scrollEvictMargin'): number | undefined {
  if (!import.meta.env.DEV) return undefined
  const o = (window as unknown as Record<string, unknown>)[key]
  return typeof o === 'number' && o >= 0 ? o : undefined
}
function evictTrigger(): number {
  return devNum('__scrollEvictTrigger') ?? EVICT_TRIGGER
}
function evictMargin(): number {
  return devNum('__scrollEvictMargin') ?? EVICT_MARGIN
}

function devDriftCheck(model: DocModel, doc: Y.Doc, src: HeightSource): void {
  const fresh = buildDocModel(doc, src)
  // ixEst+order eviction-independent (estimate-only); ix.totalHeight NOT compared — band eviction leaves ix holding
  // measured heights a fresh rebuild would derive as estimates, divergence by design not drift
  if (
    JSON.stringify(model.order) !== JSON.stringify(fresh.order) ||
    model.ixEst.totalHeight() !== fresh.ixEst.totalHeight()
  ) {
    // eslint-disable-next-line no-console
    console.error('[scroll] docModel drift vs full rebuild', {
      incremental: model.order.length,
      fresh: fresh.order.length,
    })
  }
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s)
  return s.replace(/["\\]/g, '\\$&')
}
