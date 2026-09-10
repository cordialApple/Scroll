export interface MenuAction {
  label: string
  onClick?: () => void
  disabled?: boolean
  shortcut?: string
  checked?: boolean
}

export type MenuEntry = MenuAction | 'separator'

export interface MenuDef {
  label: string
  items: MenuEntry[]
}

interface Props {
  def: MenuDef
  open: boolean
  onToggle: () => void
  onClose: () => void
}

export function MenuDropdown({ def, open, onToggle, onClose }: Props) {
  return (
    <div className="menu">
      <button
        className={`menu-item${open ? ' menu-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggle}
      >
        {def.label}
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {def.items.map((it, i) =>
            it === 'separator' ? (
              <div key={i} className="menu-pop-sep" aria-hidden />
            ) : (
              <button
                key={i}
                className="menu-pop-item"
                role="menuitemcheckbox"
                aria-checked={it.checked ?? false}
                disabled={it.disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  it.onClick?.()
                  onClose()
                }}
              >
                <span className="menu-pop-check" aria-hidden>
                  {it.checked ? '✓' : ''}
                </span>
                <span className="menu-pop-label">{it.label}</span>
                {it.shortcut && <span className="menu-pop-shortcut">{it.shortcut}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  )
}
