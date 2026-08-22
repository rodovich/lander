# UI and CSS conventions

The web client is plain React with one hand-written stylesheet, `src/styles.css`.
No CSS-in-JS, no CSS modules, no utility framework, no preprocessor. Components
carry `className` strings that match selectors in that file. Keep it that way: the
value of a single readable stylesheet is that any rule can be found by grepping
the class name, and that stops being true the moment styling has two homes.

## Spacing

**Prefer `gap` on a flex or grid parent over `margin` on its children.** Spacing
between siblings is a property of the arrangement, not of the things arranged —
`gap` states it once, in one place, and doesn't have to be unset when a child
moves, wraps, or becomes conditional.

`padding` is fine where there is a **visible border**: a rule, or a background
change that makes the box's edge real. Don't reach for it as a substitute for
margin on an invisible box.

That leaves `margin` for the cases the other two can't express — most often
vertical rhythm inside flowing prose, as in the `.message-text` rules for
rendered markdown.

## Naming

Class names are kebab-case and read as `block-element`: `.meter`, `.meter-head`,
`.meter-label`, `.meter-track`, `.meter-fill`. Variants are a **second class**,
not a suffix — `.meter-fill.warn`, `.timeline-note-label.wedged`,
`.message-user.message-queued` — so a component composes them by appending a
token to the `className` string, and the base rule keeps applying.

**Name a class for what it presents, not for what the data means**, wherever the
layer doesn't get to know what the data means. The telemetry components are the
worked example: they render `meter`, `telemetry-count`, and `telemetry-text`
because the server and client no longer know whether a bar is a rate-limit window
or something a third-party flow declared. A `.usage-window` class would have been
a layering violation wearing a name.

## Changing existing UI

When a change is meant to be invisible — a refactor, a rename, a data-source swap
— say so and hold to it: the surface should look pixel-for-pixel the same
afterward. When a change is meant to be visible, the reverse applies; don't
smuggle unrelated visual drift into it.

Verify UI changes in the running app before committing them, not only in tests
(see [docs/testing.md](testing.md)) — a rule can typecheck, pass every unit test,
and still be wrong on screen.
