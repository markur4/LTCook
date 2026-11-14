---
name: ltcook-react-vite
description: Write, review, or refactor React and TypeScript browser components in Vite applications, including state, effects, client data fetching, accessibility, bundle size, and measured render performance.
license: MIT
---

# React browser best practices

Use this reference for client-rendered React applications. Follow the project's
existing component, data-access, and testing conventions. Correct behavior and
accessible interactions come before performance tuning; this is not a server
framework guide or a requirement to add libraries.

## Keep state and interactions direct

- Store the smallest source of truth. Compute filtered lists, totals, labels, and
  other values from current props/state during rendering rather than storing a
  second copy and synchronizing it with an effect. Keep state when the value is
  independently editable or must persist across renders.
- Put work caused by a user action in its event handler. Submitting a form or
  updating a cart should follow the action, not an effect watching a flag that the
  handler set. Effects synchronize with systems outside React.
- When an update depends on the previous state, use the updater form, such as
  `setCount(previous => previous + 1)`. Do not mutate state objects or arrays;
  produce the next value without changing the previous render's snapshot.
- Keep updater functions and rendering pure. Development StrictMode can repeat
  these calls; network requests, subscriptions, and other side effects do not
  belong there.
- Keep state near its consumers. Lift it when components must share ownership,
  not merely to centralize everything. Use refs for imperative handles or values
  that do not affect rendering, not to hide changes that the UI needs to display.

**Example: derive a label and update from an interaction.**

```tsx
import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  const label = `Count: ${count}`;

  return (
    <section aria-label="Counter">
      <p role="status">{label}</p>
      <button type="button" onClick={() => setCount(previous => previous + 1)}>
        Increment
      </button>
    </section>
  );
}
```

The label follows state without an effect or a second update, and the native
button supplies keyboard interaction.

## Make effects describe synchronization

Include every reactive value read by an effect in its dependency list. Do not
silence dependency checks or use a ref merely to make a stale closure appear
stable. If dependencies change too often, first reconsider the responsibility:
move interaction-specific work to a handler, derive values during rendering, or
create effect-only objects/functions inside the effect. Depend on the specific
values actually used rather than a larger container when that expresses the same
synchronization correctly.

Pair subscriptions, listeners, timers, and connections with cleanup. Setup and
cleanup must tolerate a setup/cleanup/setup cycle. For effect-owned fetching,
prevent a response for an obsolete input or unmounted component from replacing
current state; use the project's existing cancellation or stale-result mechanism.
An AbortController can cancel supported requests, but cancellation is not a
substitute for handling errors and deciding which result is current.

Do not use effects to orchestrate chains of internal state updates that could be
one event transition or a render-time calculation. Extract a custom hook when it
encapsulates a coherent reusable synchronization responsibility, not simply to
hide dependency warnings.

## Fetch without accidental waterfalls

Start independent requests together and await them together, for example with
`Promise.all`, when all results are needed and fail-fast behavior fits. Keep truly
dependent requests ordered. Respect existing concurrency limits and avoid launching
unbounded work for large collections. If partial success is meaningful, model
those results explicitly rather than pretending every request succeeded.

Use the application's existing data client/cache when present. Do not introduce
a new fetching library solely for deduplication. Represent loading, empty, error,
and success states as appropriate, and keep user-triggered mutations in event
handlers. Check HTTP failures and validate external payloads at the established
boundary before treating them as application data.

## Render an accessible, predictable interface

- Use semantic controls and landmarks. Give inputs associated labels and buttons
  meaningful names; preserve visible focus and keyboard operation.
- Expose important asynchronous status and error changes accessibly without
  announcing every render. Keep recovery actions available when a request fails.
- Use stable domain keys for lists whose items can move or change. Do not generate
  keys during rendering or use an index when item identity matters.
- Avoid numeric leakage from conditional expressions such as `items.length &&
  <List />`; use an explicit boolean condition or a ternary when zero is not UI.
- Define component types outside another component's render body so their identity
  does not change on every render and unexpectedly reset descendant state.

## Optimize the measured bottleneck

First identify the slow interaction or load and collect evidence using existing
browser/React profiling and production build output. Distinguish network delay,
JavaScript download/parse cost, expensive calculations, and unnecessary renders.
Choose a change that addresses the observed cause and compare the same scenario
afterward using the project's permitted checks.

For bundle cost, inspect what is actually shipped. Remove unused dependencies or
use supported narrower entry points when they measurably help; do not rewrite all
barrel imports by rule. Consider native `import()` or `React.lazy` with a suitable
Suspense fallback for a genuinely heavy optional feature. Account for the extra
request and first-use delay before splitting small or immediately needed code.
Keep Vite imports statically analyzable where possible.

For render cost, first reduce unnecessary state subscriptions and move expensive
work out of unrelated updates. Add `memo`, `useMemo`, or `useCallback` only when
profiling or an established library contract justifies the identity/cache cost;
simple expressions do not need memoization. Preserve correct behavior if a cache
is discarded. Use deferred rendering or transitions only for suitable non-urgent
work, never as a replacement for correct controlled-input updates or error states.

## Provenance

Independently worded browser-focused guidance informed by
[Vercel's React skill at commit 1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62](https://github.com/vercel-labs/agent-skills/blob/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/react-best-practices/SKILL.md),
which declares MIT. This is a curated local reference, not a copy of the upstream
rule collection; no upstream rule files are required.
