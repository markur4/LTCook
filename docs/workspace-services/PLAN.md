# Workspace organization and naming

Status: Implementation complete; final verification and draft PR preparation on
`codex/workspace-organizer-renamer`.

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
- [ ] Run relevant checks and review the combined diff.
- [ ] Prepare the draft PR with exact verification and remaining limitations.
