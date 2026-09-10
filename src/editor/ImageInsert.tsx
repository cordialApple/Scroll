import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { EditorApi } from './Editor'
import type { NewImage } from '../doc/model'

type Tab = 'upload' | 'url' | 'camera'
interface Pending {
  src: string
  natW: number
  natH: number
}

const MAX_EDGE = 1600
const TAB_LABEL: Record<Tab, string> = { upload: 'Upload', url: 'By URL', camera: 'Camera' }

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => resolve(im)
    im.onerror = () => reject(new Error('image load failed'))
    im.src = src
  })
}

// Downscale so the long edge is <= MAX_EDGE, then encode as a JPEG data URI. Shared by upload + camera.
function drawScaled(source: CanvasImageSource, iw: number, ih: number): Pending {
  const scale = Math.min(1, MAX_EDGE / Math.max(iw, ih))
  const w = Math.max(1, Math.round(iw * scale))
  const h = Math.max(1, Math.round(ih * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(source, 0, 0, w, h)
  return { src: canvas.toDataURL('image/jpeg', 0.85), natW: w, natH: h }
}

async function fileToPending(file: File): Promise<Pending> {
  const objectUrl = URL.createObjectURL(file)
  try {
    const el = await loadImage(objectUrl)
    return drawScaled(el, el.naturalWidth, el.naturalHeight)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

interface Props {
  api: RefObject<EditorApi>
  onClose: () => void
}

export function ImageInsert({ api, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('upload')
  const [pending, setPending] = useState<Pending | null>(null)
  const [alt, setAlt] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const switchTab = (t: Tab) => {
    setTab(t)
    setPending(null)
    setErr(null)
  }

  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return
    setErr(null)
    setBusy(true)
    try {
      setPending(await fileToPending(file))
    } catch {
      setErr('Could not read that image file.')
    } finally {
      setBusy(false)
    }
  }, [])

  const canInsert = tab === 'url' ? url.trim().length > 0 : pending !== null

  const confirm = () => {
    let img: NewImage | null = null
    if (tab === 'url') {
      const src = url.trim()
      if (src) img = { src, alt, natW: 0, natH: 0 }
    } else if (pending) {
      img = { src: pending.src, alt, natW: pending.natW, natH: pending.natH }
    }
    if (!img) return
    api.current?.insertImage(img)
    onClose()
  }

  return (
    <div className="dlg-scrim" onClick={onClose}>
      <div
        className="dlg img-dlg"
        role="dialog"
        aria-modal="true"
        aria-label="Insert image"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dlg-head">
          <h2>Insert image</h2>
          <button className="dlg-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="img-tabs" role="tablist" aria-label="Image source">
          {(['upload', 'url', 'camera'] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`img-tab${tab === t ? ' img-tab-on' : ''}`}
              onClick={() => switchTab(t)}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>

        <div className="dlg-body img-dlg-body">
          {err && (
            <div className="img-err" role="alert">
              {err}
            </div>
          )}
          {tab === 'upload' && <UploadTab busy={busy} pending={pending} onPick={handleFile} />}
          {tab === 'url' && <UrlTab url={url} setUrl={setUrl} />}
          {tab === 'camera' && <CameraTab pending={pending} onCapture={setPending} onError={setErr} />}
        </div>

        <div className="img-dlg-foot">
          <input
            className="img-alt"
            placeholder="Alt text (optional)"
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
          />
          <div className="img-foot-actions">
            <button className="img-btn" onClick={onClose}>
              Cancel
            </button>
            <button className="img-btn img-btn-primary" disabled={!canInsert} onClick={confirm}>
              Insert
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Preview({ src }: { src: string }) {
  return (
    <div className="img-preview">
      <img src={src} alt="" />
    </div>
  )
}

function UploadTab({
  busy,
  pending,
  onPick,
}: {
  busy: boolean
  pending: Pending | null
  onPick: (f: File | undefined) => void
}) {
  return (
    <div className="img-upload">
      <label className="img-drop">
        <input
          type="file"
          accept="image/*"
          onChange={(e) => onPick(e.target.files?.[0])}
        />
        <span className="img-drop-cta">{busy ? 'Processing…' : 'Choose an image file'}</span>
        <span className="img-drop-hint">Downscaled to 1600px on the long edge</span>
      </label>
      {pending && <Preview src={pending.src} />}
    </div>
  )
}

function UrlTab({ url, setUrl }: { url: string; setUrl: (u: string) => void }) {
  const trimmed = url.trim()
  return (
    <div className="img-url">
      <input
        className="img-url-input"
        type="url"
        placeholder="https://example.com/photo.jpg"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        autoFocus
      />
      {trimmed && <Preview src={trimmed} />}
    </div>
  )
}

function CameraTab({
  pending,
  onCapture,
  onError,
}: {
  pending: Pending | null
  onCapture: (p: Pending | null) => void
  onError: (m: string) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    const md = navigator.mediaDevices
    if (!md?.getUserMedia) {
      onError('This browser has no camera access.')
      return
    }
    md.getUserMedia({ video: true })
      .then((stream) => {
        // Unmounted before the permission resolved — stop immediately so the camera light goes off.
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const v = videoRef.current
        if (v) {
          v.srcObject = stream
          v.play().catch(() => {})
        }
        setReady(true)
      })
      .catch(() => onError('Camera access was blocked or unavailable.'))
    return () => {
      alive = false
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [onError])

  const capture = () => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    onCapture(drawScaled(v, v.videoWidth, v.videoHeight))
  }

  return (
    <div className="img-camera">
      {pending ? (
        <>
          <Preview src={pending.src} />
          <button className="img-btn" onClick={() => onCapture(null)}>
            Retake
          </button>
        </>
      ) : (
        <>
          <div className="img-cam-frame">
            <video ref={videoRef} playsInline muted />
          </div>
          <button className="img-btn img-btn-primary" disabled={!ready} onClick={capture}>
            Capture
          </button>
        </>
      )}
    </div>
  )
}
