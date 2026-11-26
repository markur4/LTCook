# Workspace terminology

Use component-qualified names when discussing organization or directories:

- A **Paseo project** is a registered root and sidebar group, usually a repository, containing Paseo workspaces.
- A **Paseo workspace** is a task container referencing a working directory. Several workspaces can share that directory. A separate Git worktree is optional isolation, not the workspace itself.
- An **AppRC workspace** is a selected working directory and configuration scope. Its root commonly matches a Paseo project's root, but can instead be a worktree. Do not treat the two objects as interchangeable.
- An **agent session** has native conversation history and runtime state. A **tab** is a view; it can show an agent or subagent, terminal, browser, file, or diff. Tabs are not all sessions.
- An **LTCook Session** is the user-facing chat with its native bindings; it can include several Team agents. An **LTCook Project** is the logical collection of roots, repositories, Sessions, and Goals.
- A **host** runs a Paseo daemon and its agents. Choose the host for the work; do not assign a preferred host to a project.

Default to **one Paseo workspace with one main user-facing session**. Additional sessions are welcome when useful. Keep related subagents and supporting views, such as plans, files, diffs, and summaries, in that workspace's tabs. This convention is not a session limit or a reason to create a new worktree. Follow the applicable Pass checkout policy when isolating implementation work.
