import type { EditorApi } from '../editor/Editor'

interface Props {
  api: React.RefObject<EditorApi>
  onUndo: () => void
  onRedo: () => void
}

function fmt(cmd: string) {
  document.execCommand(cmd)
}

export function Toolbar({ api, onUndo, onRedo }: Props) {
  return (
    <div className="toolbar-row">
      <div className="toolbar">
        <Group>
          <TBtn label="Undo" glyph="↶" onClick={onUndo} />
          <TBtn label="Redo" glyph="↷" onClick={onRedo} />
          <TBtn label="Print" glyph="⎙" />
        </Group>
        <Sep />
        <Group>
          <button className="tb-zoom">100% ▾</button>
        </Group>
        <Sep />
        <Group>
          <button className="tb-style">Normal text ▾</button>
        </Group>
        <Sep />
        <Group>
          <TBtn label="Bold" glyph="B" bold onClick={() => fmt('bold')} />
          <TBtn label="Italic" glyph="I" italic onClick={() => fmt('italic')} />
          <TBtn label="Underline" glyph="U" underline onClick={() => fmt('underline')} />
          <TBtn label="Text color" glyph="A" />
        </Group>
        <Sep />
        <Group>
          <TBtn label="Bulleted list" glyph="•≣" />
          <TBtn label="Numbered list" glyph="1≣" />
          <TBtn label="Align" glyph="≣" />
        </Group>
        <Sep />
        <Group>
          <button
            className="tb-dev"
            title="Insert variable-height blocks above the camera"
            onClick={() => api.current?.insertAbove(50)}
          >
            +50 above camera
          </button>
          <button
            className="tb-dev"
            title="Delete blocks above the camera"
            onClick={() => api.current?.deleteAbove(40)}
          >
            −40 above
          </button>
          <button
            className="tb-dev"
            title="Merge the anchored block into its predecessor (exercises the redirect table)"
            onClick={() => api.current?.mergeAnchorAway()}
          >
            merge anchor
          </button>
        </Group>
      </div>
    </div>
  )
}

function Group({ children }: { children: React.ReactNode }) {
  return <div className="tb-group">{children}</div>
}

function Sep() {
  return <div className="tb-sep" aria-hidden />
}

function TBtn({
  label,
  glyph,
  onClick,
  bold,
  italic,
  underline,
}: {
  label: string
  glyph: string
  onClick?: () => void
  bold?: boolean
  italic?: boolean
  underline?: boolean
}) {
  return (
    <button
      className="tb-btn"
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{
        fontWeight: bold ? 700 : undefined,
        fontStyle: italic ? 'italic' : undefined,
        textDecoration: underline ? 'underline' : undefined,
      }}
    >
      {glyph}
    </button>
  )
}
