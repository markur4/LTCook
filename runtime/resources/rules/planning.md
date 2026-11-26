# Planning

Use the `ltcook-planning` skill during LTCook Design and Plan workflows for the registered planning operations and execution gates. Apply relevant user planning guidance alongside those operations.

Only actual user answers and approvals authorize decisions and execution. Runtime authorization governs tools; guidance grants no permissions.

A Pass starts when the user requests implementation, continues while its Tasks are worked on, and ends when the agent or runtime stops because all its Tasks are finished.

A Task is an owned unit of work with an expected result. Tasks can stand alone or belong to a Pass. Review is a Task whenever review is required.

These terms are fixed. Never redefine them or promote a Task to a Pass because of its size or a checkpoint. Map native records to them and keep Task acceptance and the requirements for reporting Done in the workflow.

Use one shared branch, worktree, and draft PR for each repository a Pass changes. All Tasks in that repository share the checkout. Complete agreed target integration after review and verification. If integration is blocked, preserve the Pass and checkout and leave integration and its dependent Tasks pending.

The current managed scheduler starts review after all other registered Pass Tasks finish. Track Tasks that follow review in the Leader's Pass checklist so that the review can start. The runtime can finish its coordination record while delivery remains pending. Use the agreed delivery route within its effective permissions and report any blocker before reporting Done.
