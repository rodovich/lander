// A row of mutually exclusive options drawn as one pill, the picked one raised.
// A radio group under the hood, so arrow keys move the pick the way they do
// between native radios: only the picked segment is in the tab order.
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: { value: T; label: React.ReactNode; title?: string }[]
  value: T
  onChange: (value: T) => void
  // Names the group for assistive tech.
  label: string
  className?: string
}) {
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0
    if (!step || options.length === 0) return
    e.preventDefault()
    const at = options.findIndex((o) => o.value === value)
    const next = options[(at + step + options.length) % options.length]
    onChange(next.value)
    const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('button')
    buttons[options.indexOf(next)]?.focus()
  }

  return (
    <div
      className={'segmented' + (className ? ` ${className}` : '')}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => {
        const picked = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={picked}
            tabIndex={picked ? 0 : -1}
            title={o.title}
            className={'segmented-option' + (picked ? ' picked' : '')}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
