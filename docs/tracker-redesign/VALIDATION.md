# Tracker redesign validation

Checked on 2026-11-27, after rebasing onto main at
`ae8e0da4621ddae370dbdc2d973c27b6f45cdaf5`.

## Traditional Tests and static checks

- `bun run check`: passed. Includes repository TypeScript formatting and
  runtime, Team, and Agent Evals TypeScript checks.
- `bun test tests/runtime/unit/tracker.test.ts tests/runtime/unit/tracker-presentation.test.ts`:
  **18 passed**, **0 failed**, **73 assertions**, approximately 3.2 seconds.
- Runtime TypeScript and changed-file formatting checks passed after the final
  layout corrections. `git diff --check` passed.
- Tools: Bun 1.4.4 and Node 26.13.1; project dependencies came from the committed
  npm lock. No dependency or lockfile changes are part of the redesign.

The new presentation tests cover persistent skipped and paused coverage gaps,
independent progress for another Tracker, removed/disabled Trackers, full
epoch-and-sequence message identity, source availability, and tracking scope.

## Browser checks

A temporary browser harness rendered the actual `TrackedItems` and
`TrackerService` production components through React Native Web with synthetic
conversation data. Paseo hooks, transport, and modal hosting were mocked; the
checks establish component behavior rather than an installed-host deployment.

Passed interactions:

- Select collections and search item text.
- Preserve drafts during incoming snapshots and tab unmount/reopen.
- Mark unsaved tabs, retain drafts after failed saves, and clear the submitted
  draft after a successful save.
- Mark edited items as manually maintained.
- Reveal the exact source host, agent, epoch, and sequence.
- Require confirmation before skipping; cancellation sends no mutation.
- Retry the first blocked message and use the explicit global pause control.

Dark and light appearances were inspected. Layouts at 1440, 1024, 390, and
320 pixels were inspected, including valid 77-character unbroken Tracker
names. Final captures showed no clipped names, horizontal document overflow,
or browser page errors.

## Review corrections

- Disabled editor fields while a save is pending, preventing text entered
  after Save from being discarded by the completed request.
- Clear only the unchanged submitted draft using the latest tab state.
- Measure the loading root as well as the loaded root so React Native Web
  subscribes to layout from the initial mount.
- Constrain long-name text and navigation widths so narrow layouts wrap.
- Split item rendering, coverage, and dialogs into dedicated components.

The pinned Paseo host's agent-context plugin-tab focus behavior was checked
against its source and existing focused-agent test. No host patch or cached
last-agent fallback was introduced.
