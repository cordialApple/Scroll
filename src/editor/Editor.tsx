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
  blockText,
  blockHasText,
  blockViewOf,
  resolveBlockIndex,
  redirectSource,
  setBlockText,
  setBlockType,
  splitBlock,
  mergeIntoPrevious,
  insertImageAfter,
  AUTHOR_HUMAN,
  type BlockType,
  type BlockView,
  type NewImage,
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
import { Block } from './Block'
import { ImageBlock } from './ImageBlock'
import { getCaretOffset, setCaretOffset } from './caret'
import type { DictationTarget } from '../voice/dictation'

const OVERSCAN = 1200
const EVICT_MARGIN = 500
const EVICT_TRIGGER = 2000

export interface EditorApi {
  setBlockType(type: BlockType): void
  scrollToBlock(id: string): void
  insertImage(img: NewImage): void
  anchorId(): string
  heightsSize(): number
  dictationTarget(): DictationTarget | null
}

interface Props {
  doc: Y.Doc
  docId: string
  blocksKey?: string
  initialAnchor: Anchor | null
  onAnchorChange?: (a: Anchor) => void
}

export const Editor = forwardRef<EditorApi, Props>(function Editor(
  { doc, docId, blocksKey = 'blocks', initialAnchor, onAnchorChange },
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
  // Caret-hold: the viewport Y (container-relative) to keep the typing line at, captured when the caret
  // moves by pointer/arrow (NOT while typing). editInFlightRef timestamps the last local edit so caret
  // moves it causes are ignored. caretEditSeqRef tags the mutation seq of the last local caret edit.
  const caretHoldYRef = useRef<number | null>(null)
  const editInFlightRef = useRef(0)
  const caretEditSeqRef = useRef(-1)

  const src: HeightSource = useMemo(
    () => ({ measuredOf: (id) => heightsRef.current.get(id) }),
    [],
  )

  // order/estimates/indices, built sync on first render + doc change, synced via observeDeep below.
  // mutated in place — memos key on version/heightsVersion, not model identity
  const modelRef = useRef<DocModel | null>(null)
  const modelDocRef = useRef<Y.Doc | null>(null)
  const modelKeyRef = useRef<string>(blocksKey)
  if (modelRef.current === null || modelDocRef.current !== doc || modelKeyRef.current !== blocksKey) {
    lastTargetRef.current = null
    pendingFocusRef.current = null
    caretHoldYRef.current = null
    modelRef.current = buildDocModel(doc, src, blocksKey)
    modelDocRef.current = doc
    modelKeyRef.current = blocksKey
  }
  const model = modelRef.current

  useEffect(() => {
    const arr = blocks(doc, blocksKey)
    const cb = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      if (modelDocRef.current !== doc || modelKeyRef.current !== blocksKey) return
      applyEvents(modelRef.current!, doc, events, src, blocksKey)
      mutationSeqRef.current++
      if (import.meta.env.DEV && mutationSeqRef.current % 16 === 0) devDriftCheck(modelRef.current!, doc, src, blocksKey)
      forceRender()
    }
    arr.observeDeep(cb)
    return () => arr.unobserveDeep(cb)
  }, [doc, src, blocksKey])

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
    const arr = blocks(doc, blocksKey)
    const out: BlockView[] = []
    for (let i = renderWindow.start; i < renderWindow.end; i++) {
      const m = arr.get(i)
      if (m) out.push(blockViewOf(m))
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, blocksKey, renderWindow.start, renderWindow.end, version])

  const commitAnchor = useCallback(
    (a: Anchor) => {
      setAnchor(a)
      saveCamera(docId, a)
      onAnchorChange?.(a)
    },
    [docId, onAnchorChange],
  )

  // Tab switch: the new tab's block ids don't exist in the old anchor, so pin its first block to the top.
  // Skip the first mount so the initialAnchor camera restore is left untouched.
  const didMountRef = useRef(false)
  useLayoutEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    restorePendingRef.current = true
    setAnchor({ blockId: modelRef.current?.order[0] ?? '', offset: 0 })
  }, [blocksKey])

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
    const pendingMutation = mutationSeqRef.current !== correctedSeqRef.current
    // A caret edit is the local user's own typing/split/merge. Its reader IS the typist, so it holds the
    // CARET line steady (below, once focus lands) rather than the top-of-viewport block. Remote/agent
    // edits and the initial camera restore still pin the top anchor — the actual relative-anchoring
    // invariant ("nothing changes beneath you when someone edits ABOVE you").
    const isCaretEdit = pendingMutation && caretEditSeqRef.current === mutationSeqRef.current
    const holdCamera = restorePendingRef.current || (pendingMutation && !isCaretEdit)
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
    } else if (!isCaretEdit && !changed && performance.now() >= suppressUntilRef.current) {
      const top = topVisible(els, contTop)
      if (top && (top.blockId !== anchor.blockId || Math.abs(top.offset - anchor.offset) > 1)) {
        commitAnchor(top)
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

    // Caret-hold (after focus lands): keep the typing line at the Y the user is focused on, so it never
    // sinks to the bottom edge as the paragraph grows. Then follow the scroll with the render window so a
    // long burst can't push the caret out of the overscan band.
    if (isCaretEdit) {
      const caretY = caretTopRel(scroller)
      const holdY = caretHoldYRef.current
      if (caretY != null && holdY != null) {
        const correction = caretY - holdY
        if (Math.abs(correction) > 0.5) {
          suppressScroll()
          scroller.scrollTop += correction
        }
        const settled = Math.abs(correction) <= 1
        const top = topVisible(els, contTop)
        if (top && (top.blockId !== anchor.blockId || Math.abs(top.offset - anchor.offset) > 1)) {
          if (settled) commitAnchor(top)
          else setAnchor(top)
        }
        if (settled) correctedSeqRef.current = mutationSeqRef.current
      } else {
        correctedSeqRef.current = mutationSeqRef.current
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
          lastTargetRef.current = { blockId: node.dataset.blockId, caret: getCaretOffset(node), blocksKey }
          // Re-anchor the caret-hold target on pointer/arrow moves, but not on the selection changes that
          // typing itself produces (those are the caret advancing — we want to hold its pre-typing Y).
          if (performance.now() - editInFlightRef.current > 150) {
            const y = caretTopRel(scroller)
            if (y != null) caretHoldYRef.current = y
          }
          return
        }
        node = node.parentNode
      }
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [blocksKey])

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
  const onEdit = useCallback(
    (id: string, text: string) => {
      editInFlightRef.current = performance.now()
      setBlockText(doc, id, text, hintOf(id), AUTHOR_HUMAN, blocksKey)
      caretEditSeqRef.current = mutationSeqRef.current
    },
    [doc, hintOf, blocksKey],
  )
  // Split/merge are STRUCTURAL — they relocate/concatenate existing text without re-authoring it, so they do
  // NOT stamp 'human' (that would falsely relabel unchanged agent content). Authorship follows content: the
  // split tail inherits the source author (in splitBlock); the merge survivor keeps its own. Only onEdit
  // (actual typing) re-authors. (#72 PF2)
  const onSplit = useCallback(
    (id: string, caret: number) => {
      editInFlightRef.current = performance.now()
      const next = splitBlock(doc, id, caret, hintOf(id), blocksKey)
      if (next) {
        pendingFocusRef.current = { blockId: next, caret: 0 }
        caretEditSeqRef.current = mutationSeqRef.current
      }
    },
    [doc, hintOf, blocksKey],
  )
  const onMerge = useCallback(
    (id: string) => {
      editInFlightRef.current = performance.now()
      const idx = resolveBlockIndex(doc, id, hintOf(id), blocksKey)
      const prevM = idx > 0 ? blocks(doc, blocksKey).get(idx - 1) : null
      const prevLen = prevM && blockHasText(prevM) ? blockText(prevM).length : 0
      const prevId = mergeIntoPrevious(doc, id, idx, blocksKey)
      if (prevId) {
        pendingFocusRef.current = { blockId: prevId, caret: prevLen }
        caretEditSeqRef.current = mutationSeqRef.current
      }
    },
    [doc, hintOf, blocksKey],
  )
  // An <img>'s real height arrives on load OUTSIDE any Yjs mutation. Bumping mutationSeqRef (WITHOUT
  // tagging a caret edit) makes the next layout pass take the holdCamera branch; bumpHeights forces it,
  // so an above-camera image load re-measures + settles without shifting content beneath the reader.
  const onImageLoad = useCallback(() => {
    mutationSeqRef.current++
    bumpHeights()
  }, [])

  useImperativeHandle(
    apiRef,
    (): EditorApi => ({
      setBlockType: (type) => {
        const id = lastTargetRef.current?.blockId ?? effAnchor.blockId
        if (id) setBlockType(doc, id, type, hintOf(id), blocksKey)
      },
      scrollToBlock: (id) => {
        if (!id) return
        restorePendingRef.current = true
        commitAnchor({ blockId: id, offset: 0 })
      },
      insertImage: (img) => {
        const id = lastTargetRef.current?.blockId ?? effAnchor.blockId
        insertImageAfter(doc, id, img, id ? hintOf(id) : undefined, blocksKey)
      },
      anchorId: () => effAnchor.blockId,
      heightsSize: () => heightsRef.current.size,
      dictationTarget: () => {
        const node = window.getSelection()?.anchorNode
        const element = (node instanceof HTMLElement ? node : node?.parentElement)?.closest<HTMLElement>('[data-block-id]')
        if (element && scrollRef.current?.contains(element)) {
          lastTargetRef.current = { blockId: element.dataset.blockId!, caret: getCaretOffset(element), blocksKey }
        }
        const target = lastTargetRef.current
        return target?.blocksKey === blocksKey && resolveBlockIndex(doc, target.blockId, undefined, blocksKey) >= 0
          ? target
          : null
      },
    }),
    [doc, effAnchor.blockId, hintOf, blocksKey, commitAnchor],
  )

  return (
    <div className="canvas" ref={scrollRef} onScroll={onScroll}>
      <div className="sheet-wrap">
        <div className="sheet">
          <div style={{ height: layout.topSpacer }} aria-hidden />
          {rendered.map((v) =>
            v.type === 'image' ? (
              <ImageBlock key={v.id} view={v} doc={doc} blocksKey={blocksKey} onImageLoad={onImageLoad} />
            ) : (
              <Block key={v.id} view={v} onEdit={onEdit} onSplit={onSplit} onMerge={onMerge} />
            ),
          )}
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

function devDriftCheck(model: DocModel, doc: Y.Doc, src: HeightSource, key: string = 'blocks'): void {
  const fresh = buildDocModel(doc, src, key)
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

// The block crossing the container's top edge + how far its top sits above it — the top-of-viewport anchor.
function topVisible(els: NodeListOf<HTMLElement>, contTop: number): Anchor | null {
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
  return topId ? { blockId: topId, offset: Math.max(0, topOff) } : null
}

// Caret top relative to the scroll container, or null if the caret isn't inside it. Falls back to the
// caret block's box when the collapsed range has no geometry (e.g. an empty block).
function caretTopRel(scroller: HTMLElement): number | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  let n: Node | null = range.startContainer
  while (n && n !== scroller) n = n.parentNode
  if (n !== scroller) return null
  let rect = range.getBoundingClientRect()
  if (rect.height === 0 && rect.top === 0) {
    let el: HTMLElement | null =
      range.startContainer instanceof HTMLElement
        ? range.startContainer
        : range.startContainer.parentElement
    while (el && !el.dataset.blockId) el = el.parentElement
    if (!el) return null
    rect = el.getBoundingClientRect()
  }
  return rect.top - scroller.getBoundingClientRect().top
}
