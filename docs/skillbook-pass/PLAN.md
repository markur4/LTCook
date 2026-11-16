# Plan: shared agent skillbook

Status: Verified source handoff; final integration evidence belongs in PR #12 and the final report. Approved in the originating conversation.

## Outcome

Centralize Agent Instructions and Skills under the dotfiles-managed `dot_agents/`, deploy a single `~/.agents/skills` library for Pi/Codex/LTCook, make the full supplied Modes guide active, and preserve historical guidance outside discovery. Chezmoi sources override local differences for managed targets. Preserve unrelated files, credentials and application data.

## Work and ownership

The coordinator archives old sources, owns standing instructions/deployment mappings/docs and all checks/Git. A Senior worker owns Modes; a Standard worker owns other shared skill packages. A Senior worker owns LTCook real-user shared discovery, current evaluation snapshots/isolation, docs and focused regressions. One Code Reviewer reviews each repository's complete frozen pass. All writers use the shared pass workspace for their repository; no worker Git or checks.

## Sequence

1. Capture old OMP/Codex/OpenCode/LTCook sources and rendered OMP reference.
2. Build central content and thin native instruction entry points; add prototype skill.
3. Update LTCook discovery before native HOME changes, preserving native guidance/trust/conflicts.
4. Run checks, batch review, fix and verify relevant findings.
5. Integrate LTCook then dotfiles, deploy selected dotfiles, inspect native discovery and clean eligible workspaces.

## Verification and delivery

Use existing native rendering/parity/discovery and maintained helper checks; approved focused LTCook test additions cover the shared directory and evaluation isolation. Run repository-required relevant lint/type/Traditional Test checks, Python with six workers. No model-backed evaluations, new infrastructure, application reinstall, production deployment or release. Treat missing installed LTCook inspection as a disclosed limit.

Pass + Draft PR in each repository, one branch/worktree each, coordinator signed scoped commits with phase evidence, published pass commits, ordinary history-preserving target integration. Preserve native branch protections, no forced updates or published rewrites. Remove pass workspaces/branches only after integration.
