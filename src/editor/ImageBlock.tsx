import { useEffect, useState, type CSSProperties } from 'react'
import type * as Y from 'yjs'
import {
  updateImage,
  deleteImageBlock,
  type BlockView,
  type ImageView,
  type MaskPreset,
  type ImagePosition,
} from '../doc/model'

interface Props {
  view: BlockView
  doc: Y.Doc
  blocksKey?: string
  onImageLoad: () => void
}

const MASK_CLIP: Record<MaskPreset, string | undefined> = {
  none: undefined,
  rounded: undefined,
  circle: 'circle(50%)',
  ellipse: 'ellipse(50% 50%)',
  triangle: 'polygon(50% 0%, 100% 100%, 0% 100%)',
  hexagon: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
}

const MASKS: MaskPreset[] = ['none', 'rounded', 'circle', 'ellipse', 'triangle', 'hexagon']
const POSITIONS: ImagePosition[] = ['inline', 'wrap-left', 'wrap-right', 'behind']
const POS_LABEL: Record<ImagePosition, string> = {
  inline: 'Inline',
  'wrap-left': 'Wrap L',
  'wrap-right': 'Wrap R',
  behind: 'Behind',
}
const BORDER_STYLES = ['none', 'solid', 'dashed', 'dotted', 'double']

function clampFrac(n: number): number {
  return n < 0 ? 0 : n > 0.9 ? 0.9 : n
}

function figureVisual(img: ImageView): CSSProperties {
  const s: CSSProperties = {}
  if (img.border.width > 0 && img.border.style !== 'none') {
    s.border = `${img.border.width}px ${img.border.style} ${img.border.color}`
  }
  if (img.mask === 'rounded') s.borderRadius = 'var(--radius-md)'
  const clip = MASK_CLIP[img.mask]
  if (clip) s.clipPath = clip
  return s
}

// Position takes the block out of normal flow (float/absolute). The height model assumes stacked blocks,
// so wrap/behind are best-effort — inline is the fully-anchored path.
function rootStyle(img: ImageView): CSSProperties {
  const w = `${img.widthPct}%`
  switch (img.position) {
    case 'wrap-left':
      return { float: 'left', width: w, maxWidth: '60%', marginRight: 20, marginBottom: 8 }
    case 'wrap-right':
      return { float: 'right', width: w, maxWidth: '60%', marginLeft: 20, marginBottom: 8 }
    case 'behind':
      return { position: 'absolute', width: w, zIndex: 0, opacity: 0.5 }
    default:
      return {}
  }
}

export function ImageBlock({ view, doc, blocksKey = 'blocks', onImageLoad }: Props) {
  const img = view.image!
  const id = view.id
  const [selected, setSelected] = useState(false)

  useEffect(() => {
    if (!selected) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest(`[data-img-ui="${id}"]`)) setSelected(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [selected, id])

  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.currentTarget
    if (img.natW === 0 && el.naturalWidth > 0) {
      // Dims unknown at insert (by-URL). Persisting them is a Yjs write, which drives the editor's
      // re-measure + hold-camera on its own — so no manual re-anchor here.
      updateImage(doc, id, { natW: el.naturalWidth, natH: el.naturalHeight }, undefined, blocksKey)
    } else {
      onImageLoad()
    }
  }

  const hasDims = img.natW > 0 && img.natH > 0
  const cropActive =
    img.crop.top > 0 || img.crop.right > 0 || img.crop.bottom > 0 || img.crop.left > 0
  const figW = img.position === 'inline' ? `${img.widthPct}%` : '100%'
  const figureBase: CSSProperties = {
    width: figW,
    maxWidth: hasDims ? `${img.natW}px` : undefined,
    overflow: 'hidden',
    ...figureVisual(img),
  }

  let figure: JSX.Element
  if (cropActive && hasDims) {
    const l = clampFrac(img.crop.left)
    const r = clampFrac(img.crop.right)
    const t = clampFrac(img.crop.top)
    const b = clampFrac(img.crop.bottom)
    const vw = Math.max(0.02, 1 - l - r)
    const vh = Math.max(0.02, 1 - t - b)
    figure = (
      <figure
        className="img-figure"
        style={{ ...figureBase, position: 'relative', aspectRatio: `${img.natW * vw} / ${img.natH * vh}` }}
      >
        <img
          className="img-el"
          src={img.src}
          alt={img.alt}
          draggable={false}
          onLoad={onLoad}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: `${100 / vw}%`,
            height: `${100 / vh}%`,
            transform: `translate(${-(l * 100)}%, ${-(t * 100)}%)`,
          }}
        />
      </figure>
    )
  } else {
    figure = (
      <figure
        className="img-figure"
        style={{ ...figureBase, aspectRatio: hasDims ? `${img.natW} / ${img.natH}` : undefined }}
      >
        <img
          className="img-el"
          src={img.src}
          alt={img.alt}
          draggable={false}
          onLoad={onLoad}
          style={{ display: 'block', width: '100%', height: hasDims ? '100%' : 'auto' }}
        />
      </figure>
    )
  }

  return (
    <div
      className={`block block-image${selected ? ' img-selected' : ''}`}
      data-block-id={id}
      data-img-ui={id}
      data-author={view.author}
      data-pos={img.position}
      style={rootStyle(img)}
      onClick={() => setSelected(true)}
    >
      {figure}
      {selected && (
        <ImageToolbar
          doc={doc}
          id={id}
          img={img}
          blocksKey={blocksKey}
          onRemove={() => {
            setSelected(false)
            deleteImageBlock(doc, id, undefined, blocksKey)
          }}
        />
      )}
    </div>
  )
}

interface ToolbarProps {
  doc: Y.Doc
  id: string
  img: ImageView
  blocksKey: string
  onRemove: () => void
}

function ImageToolbar({ doc, id, img, blocksKey, onRemove }: ToolbarProps) {
  const set = (patch: Parameters<typeof updateImage>[2]) => updateImage(doc, id, patch, undefined, blocksKey)
  const cropPct = (k: keyof ImageView['crop']) => Math.round(img.crop[k] * 100)
  const onCrop = (k: keyof ImageView['crop'], pct: number) =>
    set({ crop: { ...img.crop, [k]: clampFrac((Number.isFinite(pct) ? pct : 0) / 100) } })

  return (
    <div
      className="img-toolbar"
      role="toolbar"
      aria-label="Image options"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="img-tb-row">
        <label className="img-tb-field">
          <span>Width</span>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={img.widthPct}
            onChange={(e) => set({ widthPct: Number(e.target.value) })}
          />
          <span className="img-tb-num">{img.widthPct}%</span>
        </label>
        <label className="img-tb-field">
          <span>Shape</span>
          <select value={img.mask} onChange={(e) => set({ mask: e.target.value as MaskPreset })}>
            {MASKS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="img-tb-row">
        <label className="img-tb-field">
          <span>Border</span>
          <input
            type="number"
            min={0}
            max={16}
            value={img.border.width}
            onChange={(e) => set({ border: { ...img.border, width: Math.max(0, Number(e.target.value) || 0) } })}
          />
        </label>
        <select
          value={img.border.style}
          onChange={(e) => set({ border: { ...img.border, style: e.target.value } })}
        >
          {BORDER_STYLES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          type="color"
          aria-label="Border color"
          value={img.border.color}
          onChange={(e) => set({ border: { ...img.border, color: e.target.value } })}
        />
      </div>

      <div className="img-tb-row">
        <span className="img-tb-lbl">Crop %</span>
        {(['top', 'right', 'bottom', 'left'] as const).map((k) => (
          <label key={k} className="img-tb-crop">
            <span>{k[0].toUpperCase()}</span>
            <input
              type="number"
              min={0}
              max={90}
              value={cropPct(k)}
              onChange={(e) => onCrop(k, Number(e.target.value))}
            />
          </label>
        ))}
      </div>

      <div className="img-tb-row">
        <div className="img-tb-pos">
          {POSITIONS.map((p) => (
            <button
              key={p}
              className={`img-tb-posbtn${img.position === p ? ' on' : ''}`}
              aria-pressed={img.position === p}
              onClick={() => set({ position: p })}
            >
              {POS_LABEL[p]}
            </button>
          ))}
        </div>
        <button className="img-tb-remove" onClick={onRemove}>
          Remove
        </button>
      </div>

      <div className="img-tb-row">
        <label className="img-tb-field img-tb-alt">
          <span>Alt</span>
          <input
            type="text"
            value={img.alt}
            placeholder="Describe the image"
            onChange={(e) => set({ alt: e.target.value })}
          />
        </label>
      </div>
    </div>
  )
}
