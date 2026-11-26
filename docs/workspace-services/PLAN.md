# Workspace organization and naming

Status: Implementation and local verification complete. Ready for review in
[draft PR #80](https://github.com/markur4/LTCook/pull/80) on
`codex/workspace-organizer-renamer`. No installation or deployment performed.

## Outcome

Explain Paseo and AppRC terminology in the glossary and shared agent instructions.
Document one main Session per Paseo workspace as a default convention, allowing
additional sessions and supporting tabs. Add two local runtime Services:
Workspace Organizer and Renamer. Hosts remain freely selectable; this Pass does
not introduce synchronization or project-to-host ownership.

Workspace Organizer maintains the native Feature (blue), Bugfix (red), CSC
(amber), and Research (violet) label catalog. It chooses one category when a
workspace has content and checks changed content at twelve-hour intervals.
It archives eligible workspaces after fourteen days without meaningful use.
Renamer checks changed conversations every thirty minutes and limits agent
titles to fifteen characters and workspace titles to twenty. Workspace naming
has an independent switch. The runtime owns scheduling, persistence, eligibility,
and native mutations; stateless `@tiny` inference suggests categories and names.

Use native History for archived sessions, native labels, and Paseo's existing
newest-created-first default. Protect active, pinned, awaiting-input, incomplete,
and terminal-bearing workspaces. Automatic archival always retains the working
directory and skips teardown commands through a dedicated, authenticated Paseo
maintenance endpoint. Hold native admission while archiving; missing capability
pauses auto-archival. Count genuine UI interactions separately from maintenance
and observe conversation changes without treating renamed metadata as new work.

## Ownership and verification

All Tasks share this checkout and branch. The coordinator owns composition,
Paseo integration, configuration, service guidance, and submission. Separate
Tasks own terminology delivery, service engines, and the activity patch. Review
the complete change in this checkout. Run bounded Traditional Tests for timing,
restart, inference validation, native contracts, and archive preservation; run
relevant formatting, type, and Python checks. Live model and installation
results must be distinguished from offline tests. No release or deployment is
part of this Pass.

## Active checklist

- [x] Inspect existing owners, backlog, current dependencies, and pinned APIs.
- [x] Add terminology, source links, and shared agent guidance.
- [x] Implement Organizer and Renamer with durable local schedules.
- [x] Connect native labels, names, activity, archive guards, and runtime lifecycle.
- [x] Expose declared configuration and document native archive recovery.
- [x] Run relevant checks and review the combined diff.
- [x] Prepare the draft PR with exact verification and remaining limitations.

## Verification results

- `bun run check`: formatting and runtime, Team, and evaluation TypeScript checks passed.
- `bun run test`: 505 Traditional Tests passed, 3 existing opt-in skips, 0 failures;
  3,323 assertions in 22.74 seconds.
- `bun run build`: runtime and both Team builds passed. Packaged maintenance
  hooks match their source files.
- `bun run build:paseo-web`: the complete patched Paseo web build passed on
  Node 26.13.1 and Bun 1.4.4. Its source revision, builder checksum, and all three
  patch checksums match the current source. The emitted bundle includes the
  workspace-activity hook. Earlier attempts exhausted memory; the successful
  build used a disk-backed temporary directory, a 4 GiB Node heap, and two CPU
  cores, which limits Metro to one bundling worker.
- Python launch/configuration tests: 55 passed with six workers. Focused
  documentation and service-setting tests passed. Ruff and Pyright passed.
- The pinned upstream activity reporter passed all 5 tests. Native archive
  tests exercised real Git worktrees, late file writes, and competing prompt,
  terminal, and setup admission. Client tests rejected stale capabilities and
  malformed preservation responses without a destructive fallback.
- Independent review completed with no remaining must-fix findings. GitHub's
  standard Linux checks passed on implementation commit `b748bab`.

Agent Evals, live model requests, installed-application checks, and native
Windows/macOS execution were not run. The documented observation limits remain:
other Paseo clients do not report focus-only activity, and external-only changes
in ordinary-directory projects or ignored files do not reset inactivity. Pin
those workspaces when needed. Automatic archival keeps the working directory.
