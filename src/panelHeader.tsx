// The head of a navbar panel (stats, hooks) in the detail pane: the task
// header's band, holding the panel's title, any controls that scope what's
// below, and an X to close it. It stays put while the panel's body scrolls.
export function PanelHeader({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children?: React.ReactNode
}) {
  return (
    <div className="detail-header">
      <div className="panel-header-row">
        <h1>{title}</h1>
        {children}
        <button
          type="button"
          className="title-action panel-close"
          title="Close"
          aria-label="Close"
          onClick={onClose}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  )
}
