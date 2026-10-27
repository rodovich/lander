import { Component, type ReactNode } from 'react'

type Props = {
  // What failed, as the fallback names it: "Couldn't render {label}".
  label: string
  // A caught error lasts until this changes or the user clicks Try again, so a
  // region that failed for one task or project renders afresh for the next
  // without being remounted.
  resetKey?: unknown
  // A function is called from a component below the boundary, so a throw while
  // building the children is caught here too, not only a throw inside them.
  children: ReactNode | (() => ReactNode)
}

type State = { error: Error | null; resetKey: unknown }

// Shows a render error in place of the children that threw, so the rest of the
// page keeps working. A throw with no boundary above it unmounts the whole root.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  static getDerivedStateFromProps(props: Props, state: State) {
    return props.resetKey === state.resetKey
      ? null
      : { error: null, resetKey: props.resetKey }
  }

  render() {
    const { error } = this.state
    const { children, label } = this.props
    if (!error)
      return typeof children === 'function' ? <Call render={children} /> : children
    return (
      <div className="render-error" role="alert">
        <span className="render-error-text">
          Couldn't render {label}: {error.message}
        </span>
        <button
          type="button"
          className="action-button"
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
      </div>
    )
  }
}

function Call({ render }: { render: () => ReactNode }) {
  return render()
}
