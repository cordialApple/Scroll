import * as Y from 'yjs'
import { newBlockId } from './ids'
import type { RedirectSource } from './redirects'

export type BlockType = 'paragraph' | 'heading' | 'quote' | 'image'
export type BlockAuthor = 'agent' | 'human'
export const AUTHOR_AGENT: BlockAuthor = 'agent'
export const AUTHOR_HUMAN: BlockAuthor = 'human'

export type MaskPreset = 'none' | 'rounded' | 'circle' | 'ellipse' | 'triangle' | 'hexagon'
export type ImagePosition = 'inline' | 'wrap-left' | 'wrap-right' | 'behind'
export interface ImageBorder {
  width: number
  color: string
  style: string
}
export interface ImageCrop {
  top: number
  right: number
  bottom: number
  left: number
}
export interface ImageView {
  src: string
  alt: string
  natW: number
  natH: number
  widthPct: number
  border: ImageBorder
  mask: MaskPreset
  crop: ImageCrop
  position: ImagePosition
}
export interface NewImage {
  src: string
  alt?: string
  natW?: number
  natH?: number
}
export interface ImagePatch {
  alt?: string
  widthPct?: number
  mask?: MaskPreset
  position?: ImagePosition
  border?: ImageBorder
  crop?: ImageCrop
  natW?: number
  natH?: number
}

export interface BlockView {
  id: string
  type: BlockType
  text: string
  author?: BlockAuthor
  image?: ImageView
}

const BLOCKS = 'blocks'
const REDIRECTS = 'redirects'

export function createDoc(): Y.Doc {
  return new Y.Doc({ gc: false })
}

export function blocks(doc: Y.Doc, key: string = BLOCKS): Y.Array<Y.Map<unknown>> {
  return doc.getArray<Y.Map<unknown>>(key)
}

export function redirects(doc: Y.Doc): Y.Map<string> {
  return doc.getMap<string>(REDIRECTS)
}

export function redirectSource(doc: Y.Doc): RedirectSource {
  const map = redirects(doc)
  return { get: (id) => map.get(id) }
}

export function makeBlock(type: BlockType, text: string): Y.Map<unknown> {
  const m = new Y.Map<unknown>()
  m.set('id', newBlockId())
  m.set('type', type)
  const t = new Y.Text()
  if (text) t.insert(0, text)
  m.set('text', t)
  return m
}

export function blockId(m: Y.Map<unknown>): string {
  return m.get('id') as string
}

export function blockType(m: Y.Map<unknown>): BlockType {
  return (m.get('type') as BlockType) ?? 'paragraph'
}

export function blockText(m: Y.Map<unknown>): Y.Text {
  return m.get('text') as Y.Text
}

// Image blocks carry no 'text' key; the text-path writers/readers use this to no-op rather than crash.
export function blockHasText(m: Y.Map<unknown>): boolean {
  return m.get('text') instanceof Y.Text
}

export function blockAuthor(m: Y.Map<unknown>): BlockAuthor | undefined {
  const v = m.get('lastAuthor')
  return v === AUTHOR_AGENT ? AUTHOR_AGENT : v === AUTHOR_HUMAN ? AUTHOR_HUMAN : undefined
}

export function blockOrder(doc: Y.Doc, key: string = BLOCKS): string[] {
  return blocks(doc, key).map(blockId)
}

export function blockKeys(doc: Y.Doc): string[] {
  return [...new Set([BLOCKS, ...doc.share.keys()])]
    .filter(key => key === BLOCKS || key.startsWith(`${BLOCKS}:`))
    .sort()
}

export function allBlockOrder(doc: Y.Doc): string[] {
  return blockKeys(doc).flatMap(key => blockOrder(doc, key))
}

export function indexOfBlock(doc: Y.Doc, id: string, key: string = BLOCKS): number {
  const arr = blocks(doc, key)
  for (let i = 0; i < arr.length; i++) {
    if (blockId(arr.get(i)) === id) return i
  }
  return -1
}

// at-hint from caller's OrderIndex trusted only if still points at id (O(1) check), else falls back to O(n) scan —
// result always == indexOfBlock regardless of staleness, hint is pure speed shortcut
export function resolveBlockIndex(doc: Y.Doc, id: string, at?: number, key: string = BLOCKS): number {
  if (at !== undefined) {
    const arr = blocks(doc, key)
    if (at >= 0 && at < arr.length && blockId(arr.get(at)) === id) return at
  }
  return indexOfBlock(doc, id, key)
}

export function blockViewOf(m: Y.Map<unknown>): BlockView {
  const type = blockType(m)
  const view: BlockView =
    type === 'image'
      ? { id: blockId(m), type, text: '', image: imageOf(m) }
      : { id: blockId(m), type, text: blockText(m).toString() }
  const author = blockAuthor(m)
  if (author) view.author = author
  return view
}

export function blockViews(doc: Y.Doc, key: string = BLOCKS): BlockView[] {
  return blocks(doc, key).map(blockViewOf)
}

export function setBlockText(
  doc: Y.Doc,
  id: string,
  text: string,
  at?: number,
  author?: BlockAuthor,
  key: string = BLOCKS,
): void {
  const idx = resolveBlockIndex(doc, id, at, key)
  if (idx < 0) return
  const m = blocks(doc, key).get(idx)
  if (!blockHasText(m)) return
  const t = blockText(m)
  doc.transact(() => {
    t.delete(0, t.length)
    if (text) t.insert(0, text)
    if (author && blockAuthor(m) !== author) m.set('lastAuthor', author)
  })
}

export function setBlockAuthor(doc: Y.Doc, id: string, author: BlockAuthor, at?: number, key: string = BLOCKS): void {
  const idx = resolveBlockIndex(doc, id, at, key)
  if (idx < 0) return
  const m = blocks(doc, key).get(idx)
  if (blockAuthor(m) === author) return
  doc.transact(() => m.set('lastAuthor', author))
}

export function setBlockType(doc: Y.Doc, id: string, type: BlockType, at?: number, key: string = BLOCKS): void {
  const idx = resolveBlockIndex(doc, id, at, key)
  if (idx < 0) return
  const m = blocks(doc, key).get(idx)
  if (!blockHasText(m) || type === 'image') return
  if (blockType(m) === type) return
  doc.transact(() => m.set('type', type))
}

export function blockTextString(doc: Y.Doc, id: string, at?: number, key: string = BLOCKS): string | null {
  const idx = resolveBlockIndex(doc, id, at, key)
  if (idx < 0) return null
  const m = blocks(doc, key).get(idx)
  return blockHasText(m) ? blockText(m).toString() : null
}

export function insertBlockText(
  doc: Y.Doc,
  id: string,
  offset: number,
  text: string,
  at?: number,
  key: string = BLOCKS,
): void {
  if (!text) return
  const idx = resolveBlockIndex(doc, id, at, key)
  if (idx < 0) return
  const bm = blocks(doc, key).get(idx)
  if (!blockHasText(bm)) return
  const t = blockText(bm)
  const pos = Math.max(0, Math.min(offset, t.length))
  doc.transact(() => t.insert(pos, text))
}

export function insertBlockAfter(
  doc: Y.Doc,
  id: string,
  type: BlockType,
  text: string,
  at?: number,
  key: string = BLOCKS,
): string {
  const idx = resolveBlockIndex(doc, id, at, key)
  const block = makeBlock(type, text)
  doc.transact(() => {
    blocks(doc, key).insert(idx < 0 ? blocks(doc, key).length : idx + 1, [block])
  })
  return blockId(block)
}

export function appendBlock(doc: Y.Doc, type: BlockType, text: string, key: string = BLOCKS): string {
  const block = makeBlock(type, text)
  doc.transact(() => {
    blocks(doc, key).push([block])
  })
  return blockId(block)
}

export function splitBlock(doc: Y.Doc, id: string, charOffset: number, at?: number, key: string = BLOCKS): string | null {
  const idx = resolveBlockIndex(doc, id, at, key)
  if (idx < 0) return null
  const arr = blocks(doc, key)
  const src = arr.get(idx)
  if (!blockHasText(src)) return null
  const t = blockText(src)
  const tail = t.toString().slice(charOffset)
  const next = makeBlock(blockType(src), tail)
  const author = blockAuthor(src)
  if (author) next.set('lastAuthor', author) // structural split moves content; the tail keeps its origin
  doc.transact(() => {
    if (t.length > charOffset) t.delete(charOffset, t.length - charOffset)
    arr.insert(idx + 1, [next])
  })
  return blockId(next)
}

export function mergeIntoPrevious(doc: Y.Doc, id: string, at?: number, key: string = BLOCKS): string | null {
  const idx = resolveBlockIndex(doc, id, at, key)
  if (idx <= 0) return null
  const arr = blocks(doc, key)
  const src = arr.get(idx)
  const prev = arr.get(idx - 1)
  if (!blockHasText(prev) || !blockHasText(src)) return null
  const prevId = blockId(prev)
  const prevText = blockText(prev)
  const moved = blockText(src).toString()
  doc.transact(() => {
    if (moved) prevText.insert(prevText.length, moved)
    arr.delete(idx, 1)
    redirects(doc).set(id, prevId)
  })
  return prevId
}

// ---- image blocks ----
function imgNum(m: Y.Map<unknown>, k: string, d: number): number {
  const v = m.get(k)
  return typeof v === 'number' ? v : d
}
function imgStr(m: Y.Map<unknown>, k: string, d: string): string {
  const v = m.get(k)
  return typeof v === 'string' ? v : d
}
export function imageOf(m: Y.Map<unknown>): ImageView {
  return {
    src: imgStr(m, 'src', ''),
    alt: imgStr(m, 'alt', ''),
    natW: imgNum(m, 'natW', 0),
    natH: imgNum(m, 'natH', 0),
    widthPct: imgNum(m, 'widthPct', 100),
    border: {
      width: imgNum(m, 'borderWidth', 0),
      color: imgStr(m, 'borderColor', '#000000'),
      style: imgStr(m, 'borderStyle', 'solid'),
    },
    mask: imgStr(m, 'mask', 'none') as MaskPreset,
    crop: {
      top: imgNum(m, 'cropTop', 0),
      right: imgNum(m, 'cropRight', 0),
      bottom: imgNum(m, 'cropBottom', 0),
      left: imgNum(m, 'cropLeft', 0),
    },
    position: imgStr(m, 'position', 'inline') as ImagePosition,
  }
}
export function makeImageBlock(p: NewImage): Y.Map<unknown> {
  const m = new Y.Map<unknown>()
  m.set('id', newBlockId())
  m.set('type', 'image')
  m.set('src', p.src)
  m.set('alt', p.alt ?? '')
  m.set('natW', p.natW ?? 0)
  m.set('natH', p.natH ?? 0)
  m.set('widthPct', 100)
  m.set('borderWidth', 0)
  m.set('borderColor', '#000000')
  m.set('borderStyle', 'solid')
  m.set('mask', 'none')
  m.set('cropTop', 0)
  m.set('cropRight', 0)
  m.set('cropBottom', 0)
  m.set('cropLeft', 0)
  m.set('position', 'inline')
  return m
}
export function insertImageAfter(doc: Y.Doc, id: string, img: NewImage, at?: number, key: string = BLOCKS): string {
  const idx = resolveBlockIndex(doc, id, at, key)
  const b = makeImageBlock(img)
  doc.transact(() => blocks(doc, key).insert(idx < 0 ? blocks(doc, key).length : idx + 1, [b]))
  return blockId(b)
}
export function updateImage(doc: Y.Doc, id: string, patch: ImagePatch, at?: number, key: string = BLOCKS): void {
  const idx = resolveBlockIndex(doc, id, at, key)
  if (idx < 0) return
  const m = blocks(doc, key).get(idx)
  if (blockType(m) !== 'image') return
  doc.transact(() => {
    if (patch.alt !== undefined) m.set('alt', patch.alt)
    if (patch.widthPct !== undefined) m.set('widthPct', patch.widthPct)
    if (patch.mask !== undefined) m.set('mask', patch.mask)
    if (patch.position !== undefined) m.set('position', patch.position)
    if (patch.natW !== undefined) m.set('natW', patch.natW)
    if (patch.natH !== undefined) m.set('natH', patch.natH)
    if (patch.border) {
      m.set('borderWidth', patch.border.width)
      m.set('borderColor', patch.border.color)
      m.set('borderStyle', patch.border.style)
    }
    if (patch.crop) {
      m.set('cropTop', patch.crop.top)
      m.set('cropRight', patch.crop.right)
      m.set('cropBottom', patch.crop.bottom)
      m.set('cropLeft', patch.crop.left)
    }
  })
}
export function deleteImageBlock(doc: Y.Doc, id: string, at?: number, key: string = BLOCKS): void {
  const idx = resolveBlockIndex(doc, id, at, key)
  if (idx < 0) return
  const arr = blocks(doc, key)
  const neighbor =
    idx > 0 ? blockId(arr.get(idx - 1)) : arr.length > idx + 1 ? blockId(arr.get(idx + 1)) : null
  doc.transact(() => {
    arr.delete(idx, 1)
    if (neighbor) redirects(doc).set(id, neighbor)
  })
}

export function seedIfEmpty(doc: Y.Doc, key: string = BLOCKS): void {
  if (blocks(doc, key).length > 0) return
  doc.transact(() => {
    blocks(doc, key).push([makeBlock('paragraph', '')])
  })
}

const META = 'meta'

export function docMeta(doc: Y.Doc): Y.Map<string> {
  return doc.getMap<string>(META)
}

export function getDocTitle(doc: Y.Doc): string {
  return docMeta(doc).get('title') ?? ''
}

export function setDocTitle(doc: Y.Doc, title: string): void {
  doc.transact(() => docMeta(doc).set('title', title))
}

// ---- document tabs (per-tab blocks arrays) ----
const TABS = 'tabs'
const ACTIVE_TAB = 'activeTab'
export const DEFAULT_TAB_ID = 'main'

export interface DocTab {
  id: string
  title: string
}

function newTabId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `tab-${crypto.randomUUID().slice(0, 8)}`
  return `tab-${Math.random().toString(36).slice(2, 10)}`
}

export function tabBlocksKey(tabId: string): string {
  return !tabId || tabId === DEFAULT_TAB_ID ? BLOCKS : `${BLOCKS}:${tabId}`
}

export function listTabs(doc: Y.Doc): DocTab[] {
  let legacy: DocTab[] = [{ id: DEFAULT_TAB_ID, title: getDocTitle(doc) || 'Tab 1' }]
  const raw = docMeta(doc).get(TABS)
  if (raw) {
    try {
      const arr = JSON.parse(raw) as DocTab[]
      if (Array.isArray(arr) && arr.length > 0 && arr.every(t => t && typeof t.id === 'string' && typeof t.title === 'string')) legacy = arr
    } catch {
      /* fall through to the implicit default tab */
    }
  }
  const merged = new Map(legacy.map((tab, order) => [tab.id, { ...tab, order }]))
  tabRecords(doc).forEach((record, id) => {
    if (record === null) merged.delete(id)
    else merged.set(id, { id, ...record })
  })
  const tabs = [...merged.values()]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(({ id, title }) => ({ id, title }))
  return tabs.length ? tabs : [{ id: DEFAULT_TAB_ID, title: 'Tab 1' }]
}

function tabRecords(doc: Y.Doc): Y.Map<{ title: string; order: number } | null> {
  return doc.getMap('documentTabs')
}

export function getActiveTabId(doc: Y.Doc): string {
  const id = docMeta(doc).get(ACTIVE_TAB)
  const tabs = listTabs(doc)
  return id && tabs.some((t) => t.id === id) ? id : tabs[0].id
}

export function setActiveTabId(doc: Y.Doc, id: string): void {
  doc.transact(() => docMeta(doc).set(ACTIVE_TAB, id))
}

export function createTab(doc: Y.Doc, title: string): string {
  const id = newTabId()
  doc.transact(() => {
    const tabs = listTabs(doc)
    const records = tabRecords(doc)
    const order = Math.max(tabs.length, ...Array.from(records.values(), (t) => t?.order ?? 0)) + 1
    records.set(id, { title: title || `Tab ${tabs.length + 1}`, order })
    const arr = blocks(doc, tabBlocksKey(id))
    if (arr.length === 0) arr.push([makeBlock('paragraph', '')])
  })
  return id
}

export function renameTab(doc: Y.Doc, id: string, title: string): void {
  doc.transact(() => {
    const records = tabRecords(doc)
    const order = records.get(id)?.order ?? listTabs(doc).findIndex((t) => t.id === id)
    if (order >= 0) records.set(id, { title, order })
  })
}

export function removeTab(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    const tabs = listTabs(doc)
    if (tabs.length <= 1) return
    const next = tabs.filter((t) => t.id !== id)
    tabRecords(doc).set(id, null)
    const active = docMeta(doc).get(ACTIVE_TAB)
    if (active === id || !next.some((t) => t.id === active)) docMeta(doc).set(ACTIVE_TAB, next[0].id)
  })
}

export function docWordCount(doc: Y.Doc): { words: number; chars: number } {
  let words = 0
  let chars = 0
  for (const v of blockViews(doc)) {
    chars += v.text.length
    const trimmed = v.text.trim()
    if (trimmed) words += trimmed.split(/\s+/).length
  }
  return { words, chars }
}
