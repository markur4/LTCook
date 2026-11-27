# Tracker redesign validation

Checked on 2026-11-27 after the user approved the compact interactive preview,
Notes label, Copy all notes action, implementation, and merge. The final branch
integrates main at `4fac474`, preserving its newer workspace naming and Services
sidebar behavior.

## Traditional Tests and static checks

- `bun run check`: passed. Includes repository TypeScript formatting and
  runtime, Team, and Agent Evals TypeScript checks.
- `ruff format --check src tests` and `ruff check src tests`: passed.
- `pyright`: passed with zero errors and warnings.
- After the native clipboard-fallback correction, runtime TypeScript and
  changed-file formatting checks passed again. `git diff --check` passed.

| Traditional Tests | Passed | Remaining skips |
| --- | ---: | ---: |
| Bun runtime, native, integration, and Team contracts | 492 | 2 |
| Python local suite with six workers | 289 | 0 |
| Total | 781 | 2 |

Commands used:

```shell
bun run test
bun test tests/runtime/unit/ried.test.ts -t 'native Just inventories'
PYTHONPATH=src .venv/bin/python -m pytest -m 'not integration and not system'
PYTHONPATH=src .venv/bin/python -m pytest \
  tests/python/unit/test_clean.py::test_clean_preserves_virtual_environment_and_shared_uv_cache \
  tests/python/unit/test_release_tooling.py::test_release_policy_uses_the_exact_tag_snapshot \
  tests/python/unit/test_release_tooling.py::test_hosted_gate_watches_the_exact_tag_push
```

The initial Bun run passed 491 tests in 34.23 seconds; the initial Python run
passed 286 in 9.10 seconds. Providing Just and rerunning its four initially
skipped offline cases added one Bun pass in 0.264 seconds and three Python
passes in 1.34 seconds. The two remaining skips require opt-in live
Ollama/Bonsai inference and an explicitly supplied pinned `brief` executable.
The Python configuration supplied six workers for both runs.

Tools: Bun 1.4.4, Node 26.13.1, Python 3.13.5, Just 1.59.0, and Python dependencies
from the committed `uv.lock`. No dependency or lockfile changes are part of this
redesign. Model-backed Agent Evals were not run: inference, extraction rules,
and stored Tracker records are unchanged.

The presentation tests cover persistent coverage gaps, independent Tracker
progress, removed and disabled collections, timeline identity, tracking scope,
and plain-text export. Export tests include disabled and empty collections,
Unicode, multiline notes, saved edits, and removals.

## Browser checks

A temporary browser harness rendered the actual production `TrackedItems`,
`TrackerCopyNotes`, and `TrackerService` components through React Native Web.
Conversation data and Paseo transport were synthetic. The clipboard adapter
used the browser's real clipboard for the successful copy check. These checks
establish component behavior, not an installed-host deployment or native-device
execution.

Passed interactions:

- Select collections and search item text.
- Copy all nine notes while one collection and a search filter show only one.
- Read the actual clipboard and confirm every collection is present.
- Copy a newly saved edit and exclude the superseded text.
- Simulate clipboard failure and expose identical text for manual copying,
  without showing a false success state.
- Disable copying when no notes exist.
- Preserve drafts during incoming snapshots and tab unmount/reopen.
- Mark unsaved tabs, retain drafts after failed saves, and clear the submitted
  draft after a successful save.
- Mark edited items as manually maintained.
- Reveal the exact source host, agent, epoch, and sequence.
- Require confirmation before skipping; cancellation sends no mutation.
- Retry the first blocked message and use the explicit global pause control.

The approved compact layout was checked at 1024, 390, and 320 pixels with no
horizontal document overflow or browser page errors. Coarse-pointer web controls
measured 44 pixels high. The initial redesign also covered dark and light themes,
1440-pixel layouts, and valid 77-character unbroken Tracker names.

## Review corrections

- Disable editor fields during a save and clear only the unchanged submitted
  draft, so a completed request cannot discard newer input.
- Measure both loading and loaded roots and constrain long navigation names.
- Keep clipboard success feedback tied to the completed copy and clean up its
  timer when the component unmounts.
- Use selectable native Text for manual copying; a disabled Android text input
  would prevent selecting the fallback. Web retains a read-only text input.
- Preserve 44-pixel control targets on native and coarse-pointer web clients.
- Preserve the newer Services sidebar component when resolving the registration
  conflict with main.

Independent review confirmed the native-selection correction and reported no
remaining findings. The pinned Paseo host's agent-context plugin-tab focus
behavior was checked against its source and existing focused-agent test. No
host workaround or cached last-agent fallback was introduced.
