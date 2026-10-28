import { Component, type ReactNode } from 'react'

// How long a caught error stands before the boundary renders its children again.
// Most render errors come from a task midway through editing lander, which its
// later edits fix. Fast Refresh retries failed boundaries after a client edit,
// but a server edit changes only the data, which this retry picks up without
// knowing what the children read. An error that never clears retries, and logs,
// every interval.
const RETRY_MS = 10_000

type Props = {
  // What failed, as the fallback names it: "Couldn't render {label}".
  label: string
  // Changing this clears a caught error at once, so a region that failed for
  // one task or project renders afresh for the next without being remounted.
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
  private retry: ReturnType<typeof setTimeout> | undefined

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  static getDerivedStateFromProps(props: Props, state: State) {
    return props.resetKey === state.resetKey
      ? null
      : { error: null, resetKey: props.resetKey }
  }

  componentDidCatch() {
    clearTimeout(this.retry)
    this.retry = setTimeout(() => this.setState({ error: null }), RETRY_MS)
  }

  componentWillUnmount() {
    clearTimeout(this.retry)
  }

  render() {
    const { error } = this.state
    const { children, label } = this.props
    if (!error)
      return typeof children === 'function' ? <Call render={children} /> : children
    return (
      <div className="render-error" role="alert">
        Couldn't render {label}: {error.message}
      </div>
    )
  }
}

function Call({ render }: { render: () => ReactNode }) {
  return render()
}
