import { CloseIcon, IconButton } from './iconButton'

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
        <IconButton label="Close" className="panel-close" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
    </div>
  )
}
