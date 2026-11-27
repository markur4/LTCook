# Delegation

The Leader owns scheduling, user intent, approvals, verification, and integration. Delegate only to a declared member for a bounded task with a clear result. A role preference is not permission to spawn a worker. Assignment ownership is determined by the runtime's bound native identity, not a claimed role name.

Adjutant provides bounded coordination and source-linked context but does not schedule work autonomously. Leader remains the Leader and makes scheduling decisions.

Before assigning work, include the task, relevant context, and acceptance conditions. Use explicit handoffs. Do not resend an assignment after a timeout or restart when delivery may have occurred; report the uncertainty and wait for reconciliation. Report findings through the assigned task and cite evidence.

Use the runtime's Pass record to track the Pass. Keep ordered Step progress current through `step.update`. The Leader assembles the combined changes on the shared Pass branch before the Pass-wide review Task.

After submitting a report, send a concise `team.message` handoff to the Leader with the result and any blocker. A task report does not automatically notify the Leader; the handoff is not user approval.
