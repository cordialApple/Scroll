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
  indexOfBlock,
  redirectSource,
  setBlockText,
  splitBlock,
  mergeIntoPrevious,
  type BlockView,
} from '../doc/model'
import { resolveEffectiveAnchor } from '../doc/anchor'
import { estimateHeight } from '../layout/estimate'
import {
  computeLayout,
  windowFor,
  deriveAnchor,
  type Anchor,
  type HeightModel,
} from '../layout/layout'
import { saveCamera } from '../doc/camera'
import { insertAbove, deleteAbove } from '../dev/synthetic'
import { Block } from './Block'
import { setCaretOffset } from './caret'

const OVERSCAN = 1200
const EMPTY_HEIGHTS: Map<string, number> = new Map()

export interface EditorApi {
  insertAbove(n: number): void
  deleteAbove(n: number): void
  mergeAnchorAway(): void
  anchorId(): string
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
  const mutationSeqRef = useRef(0)
  const correctedSeqRef = useRef(0)
  const restorePendingRef = useRef(initialAnchor != null)

  useEffect(() => {
    const arr = blocks(doc)
    const cb = () => {
      mutationSeqRef.current++
      forceRender()
    }
    arr.observeDeep(cb)
    return () => arr.unobserveDeep(cb)
  }, [doc])

  const suppressScroll = useCallback(() => {
    suppressUntilRef.current = performance.now() + 250
  }, [])

  const { order, estimates } = useMemo(() => {
    const arr = blocks(doc)
    const order: string[] = []
    const estimates = new Map<string, number>()
    for (let i = 0; i < arr.length; i++) {
      const m = arr.get(i)
      const id = blockId(m)
      order.push(id)
      estimates.set(id, estimateHeight({ type: blockType(m), textLength: blockText(m).length }))
    }
    return { order, estimates }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, version])

  const hm: HeightModel = useMemo(
    () => ({ measured: heightsRef.current, estimate: (id) => estimates.get(id) ?? 40 }),
    [estimates, heightsVersion],
  )

  const estimateHm: HeightModel = useMemo(
    () => ({ measured: EMPTY_HEIGHTS, estimate: (id) => estimates.get(id) ?? 40 }),
    [estimates],
  )

  const effAnchor: Anchor = useMemo(
    () => resolveEffectiveAnchor(order, redirectSource(doc), anchor),
    [doc, order, anchor],
  )

  const renderWindow = useMemo(
    () => windowFor(order, estimateHm, effAnchor, viewportH, OVERSCAN),
    [order, estimateHm, effAnchor, viewportH],
  )

  const layout = useMemo(
    () => computeLayout(order, hm, renderWindow, effAnchor),
    [order, hm, renderWindow, effAnchor],
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
    }
  })

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
    const next = domId
      ? { blockId: domId, offset: Math.max(0, domOff) }
      : deriveAnchor(scroller.scrollTop, order, hm)
    if (next.blockId) commitAnchor(next)
  }, [commitAnchor, order, hm])

  const onEdit = useCallback((id: string, text: string) => setBlockText(doc, id, text), [doc])
  const onSplit = useCallback(
    (id: string, caret: number) => {
      const next = splitBlock(doc, id, caret)
      if (next) pendingFocusRef.current = { blockId: next, caret: 0 }
    },
    [doc],
  )
  const onMerge = useCallback(
    (id: string) => {
      const arr = blocks(doc)
      const idx = indexOfBlock(doc, id)
      const prevLen = idx > 0 ? blockText(arr.get(idx - 1)).length : 0
      const prevId = mergeIntoPrevious(doc, id)
      if (prevId) pendingFocusRef.current = { blockId: prevId, caret: prevLen }
    },
    [doc],
  )

  useImperativeHandle(
    apiRef,
    (): EditorApi => ({
      insertAbove: (n) => effAnchor.blockId && insertAbove(doc, effAnchor.blockId, n, 3 + n),
      deleteAbove: (n) => effAnchor.blockId && deleteAbove(doc, effAnchor.blockId, n),
      mergeAnchorAway: () => {
        const id = effAnchor.blockId
        const idx = order.indexOf(id)
        if (idx > 0) mergeIntoPrevious(doc, id)
      },
      anchorId: () => effAnchor.blockId,
    }),
    [doc, effAnchor.blockId, order],
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

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s)
  return s.replace(/["\\]/g, '\\$&')
}
