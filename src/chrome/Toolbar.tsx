import type { BlockType } from '../doc/model'
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
          <TBtn label="Print" glyph="⎙" onClick={() => window.print()} />
        </Group>
        <Sep />
        <Group>
          <button className="tb-zoom" disabled title="Zoom — coming soon">
            100%
          </button>
        </Group>
        <Sep />
        <Group>
          <select
            className="tb-style"
            aria-label="Block style"
            defaultValue="paragraph"
            onChange={(e) => api.current?.setBlockType(e.target.value as BlockType)}
          >
            <option value="paragraph">Normal text</option>
            <option value="heading">Heading</option>
            <option value="quote">Quote</option>
          </select>
        </Group>
        <Sep />
        <Group>
          <TBtn label="Bold" glyph="B" bold onClick={() => fmt('bold')} />
          <TBtn label="Italic" glyph="I" italic onClick={() => fmt('italic')} />
          <TBtn label="Underline" glyph="U" underline onClick={() => fmt('underline')} />
          <TBtn label="Text color — coming soon" glyph="A" disabled />
        </Group>
        <Sep />
        <Group>
          <TBtn label="Bulleted list — coming soon" glyph="•≣" disabled />
          <TBtn label="Numbered list — coming soon" glyph="1≣" disabled />
          <TBtn label="Align — coming soon" glyph="≣" disabled />
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
  disabled,
}: {
  label: string
  glyph: string
  onClick?: () => void
  bold?: boolean
  italic?: boolean
  underline?: boolean
  disabled?: boolean
}) {
  return (
    <button
      className="tb-btn"
      title={label}
      aria-label={label}
      disabled={disabled}
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
