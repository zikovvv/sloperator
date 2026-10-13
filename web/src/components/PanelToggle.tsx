/**
 * The one control that folds a panel away. Every panel gets the same button in the same place —
 * pinned to its top-left corner, fixed size, so it never moves when the panel is resized. Use this
 * everywhere a panel collapses; do not hand-roll another one.
 */
export function PanelToggle({ collapsed, onClick, label, title }: {
  collapsed: boolean
  onClick: () => void
  /** Stays stable for tests and screen readers: "Hide chat" / "Show chat". */
  label: string
  title: string
}) {
  return (
    <button className="panel-toggle" aria-label={label} aria-expanded={!collapsed} title={title} onClick={onClick}>
      {collapsed ? '»' : '«'}
    </button>
  )
}

/** The sliver a collapsed panel leaves behind: nothing but the same button, at the same corner. */
export function CollapsedStrip({ side, onClick, label, title }: {
  side: 'left' | 'right'
  onClick: () => void
  label: string
  title: string
}) {
  return (
    <div className={`flex w-6 shrink-0 justify-center bg-ink-900 pt-1.5 ${side === 'left' ? 'border-r' : 'border-l'} border-ink-800`}>
      <PanelToggle collapsed onClick={onClick} label={label} title={title} />
    </div>
  )
}
