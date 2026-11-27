# Tracker notebook redesign

## Goal

Give Tracker room to be a readable, editable conversation notebook, and expose
its service state in Activity. The existing nested Explorer cards make items,
editing controls, and coverage compete for a narrow column.

## Decisions

- Register one agent-bound **Tracker** tab in the workspace beside the native
  conversation. Read its `params.agentId`, never a newly focused composer.
- Remove the separate **Tracked Items** Explorer panel. **Activity → Services
  → Tracker** is the compact service entry and opens the full notebook.
- Keep existing Tracker collections and natural-language instructions. Show
  **All items**, collection selection, a local text search, and item sources.
- Use quiet rows with readable item text. Put collection instructions, item
  editing, and service controls in their own focused views.
- Keep **Notes** and **Coverage** separate within the same tab. Coverage is
  a per-message processing record, not a fabricated item-change log.
- Use the approved compact header, row, and control spacing without reducing
  text sizes. Retain larger control targets on native and coarse-pointer clients.
- Put **Copy all notes** beside search. Export all saved notes from the bound
  conversation as plain text, grouped under Tracker headings with bullet points,
  independent of selected collection or search filter. Include disabled
  collections and omit empty collections. Use Paseo's clipboard API and expose
  selectable text when clipboard access fails.
- Show processing state separately from coverage. Paused and skipped messages
  remain gaps. Missing original evidence remains visible on the affected item.
- Use only existing snapshot fields. Message timestamps are not extraction
  timestamps; pending events do not establish that inference is running.
- Preserve draft text and selection in the tab state. Background snapshots must
  not overwrite drafts. Mark a tab containing a draft as modified.
- Keep **Pause Tracker everywhere** explicitly global to the host. A single
  collection can be enabled or disabled independently.
- Keep this Pass within the UI and presentation logic. No changes to Tracker
  extraction, persistence formats, migration code, or provider inference.

## Integration

The pinned Paseo SDK already supports `addAgentPanel` in the workspace. The
host's `getFocusedAgentId` includes agent-context plugin tabs and propagates
their agent identity to focused composers. Activity can therefore use its
existing focus and workspace guards when the Tracker tab is active.

Source: [pinned Paseo focus selection](https://github.com/getpaseo/paseo/blob/23bae61535542a45ade7196a7b3c152705f16de3/packages/app/src/plugins/command-center/context.ts).

The notebook consumes the existing `ltcook.tracker.snapshot` subscription and
`ltcook.tracker.modify` RPC. The Activity service uses the same snapshot and
presentation helpers. Activity's existing visibility lifecycle releases its
observation when its web panel is hidden; extraction remains runtime-owned.

## Scope boundaries

This change replaces the old Explorer panel registration without compatibility
aliases. Existing saved layout references to that removed panel are not
migrated; open Tracker through the conversation control or Activity.

The broader service-directory reorganization in [BACKLOG.md](../../BACKLOG.md)
is independent of the redesign and remains deferred.

## Acceptance and verification

- A Tracker tab remains bound to its conversation across agent/tab changes.
- Activity shows collection/item counts, processing state, coverage, and a
  working **Open Tracker** route.
- Users can create/edit/disable/remove Trackers and edit/remove items using the
  existing API. Destructive actions are explicit.
- Search and collection selection work without changing stored data.
- Copy includes every saved note, reflects saved edits and removals, and reports
  success only after the clipboard operation completes.
- Source navigation uses complete source identity and the host capability.
- Coverage shows first-blocker recovery and preserves skipped-message gaps.
- Disconnected views are labelled; mutations cannot silently appear successful.
- Drafts survive background snapshots and returning to the tab.
- Layout is readable at desktop and narrow widths and follows the host theme.
- Run the relevant Traditional Tests, TypeScript checks, formatting checks, and
  browser interaction checks. The browser harness uses actual components with
  synthetic data and mocked transport; it does not establish live inference.

The active checklist is [TODO.md](TODO.md).
