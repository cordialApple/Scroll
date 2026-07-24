const MENUS = ['File', 'Edit', 'View', 'Insert', 'Format', 'Tools', 'Extensions', 'Help']

interface Props {
  title: string
}

export function MenuBar({ title }: Props) {
  return (
    <div className="menubar">
      <div className="menubar-left">
        <button className="doc-icon" title="Scroll" aria-label="Scroll home">
          <span className="icon doc-glyph">≡</span>
        </button>
        <div className="menubar-titlecol">
          <div className="doc-title">{title}</div>
          <div className="menu-row">
            {MENUS.map((m) => (
              <button key={m} className="menu-item">
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="menubar-right">
        <button className="chip" title="Local, offline">
          <span className="dot dot-success" /> Saved locally
        </button>
        <div className="avatar" aria-hidden>
          S
        </div>
      </div>
    </div>
  )
}
