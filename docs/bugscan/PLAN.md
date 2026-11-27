# BugHunter Pass 2 — BugScan

Add a read-only Service that groups LTCook diagnostic failures, starts native
investigation Tasks through its internal Team, and preserves findings in the
existing coordination database. The Service records exact source provenance
where available, or the limits that constrain a diagnosis. The target is
`main`, with one shared worktree, branch, draft PR, and combined review Task.

Extend Traditional Tests and use the existing Pi route for model qualification.
The default Team models are `@medium` with high reasoning for the Coordinator and
investigators. Start automatically only when authorized with an enforceable
model budget. Manual diagnosis remains read-only and uses scoped existing
permissions.

An authenticated user can view findings through Activity → Services. The service
persists unfinished or unsuccessful states without replaying uncertain native
deliveries. A supported remedy and technical debt have separate fields.
Architectural findings carry an explicit immediate or deferred decision and the
rationale. Deferred findings stay outside the automatic repair batch.

Later Passes own BugFix eligibility, standing execution authorization, and
delivery. They can claim recovery only after repeating the formerly failing
behavior successfully on the repaired running build.

See [TODO.md](TODO.md) for the active checklist.
