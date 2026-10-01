import { forwardRef } from 'react'

// A secondary row nested under a row of a listbox: a single ellipsized line,
// set off by a rail at the left — or, as a `link`, a plain accent-colored
// action without the rail. An option in the list's arrow-key order, though
// never the one Tab lands on: the list owns focus, and the row only reports
// clicks and keys.
export const ListSubrow = forwardRef<
  HTMLLIElement,
  {
    link?: boolean
    onClick: () => void
    onKeyDown: (e: React.KeyboardEvent<HTMLLIElement>) => void
    children: React.ReactNode
  }
>(function ListSubrow({ link, onClick, onKeyDown, children }, ref) {
  return (
    <li
      ref={ref}
      role="option"
      aria-selected={false}
      tabIndex={-1}
      className={'list-subrow' + (link ? ' link' : '')}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {!link && <span className="list-subrow-rail" aria-hidden="true" />}
      <span className="list-subrow-text">{children}</span>
    </li>
  )
})
