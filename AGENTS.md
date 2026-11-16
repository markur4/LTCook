# Repository conventions

Before making changes, read [Contributing](CONTRIBUTING.md) and follow its shared
conventions. Consult the relevant [Development](docs/Development.md) guides.

## Release policy
- Treat the committed `RELEASE_PYPI` value in `justfile` as a hard gate. When it is `"false"`, do not recommend or run a manual PyPI publish or retry command.
- The current manual asset-build workflow creates no tags, GitHub Releases or PyPI publications.
- Publishing requires separate explicit authorization; do not turn repository push permission into release permission.

## Repo routing and project rules
- Follow [Working conventions](CONTRIBUTING.md#working-conventions) and the
  [repository layout](docs/Development.md#repository-routing).
- Apply the prototype breaking-change rule in Contributing to every new format,
  cache, API and installer path. Do not add migration code or compatibility layers.
- Inspect the existing owner and shared helpers before adding an implementation;
  warn the user when documented paths appear stale.
- Check [BACKLOG.md](BACKLOG.md) and assess related durable work for the pass.
- Keep one authoritative active checklist beside its plan. Before closing a
  pass, transfer unfinished work according to the shared contribution rules.

## Documentation rules
- Follow the canonical [documentation rules](docs/README.md#documentation-rules),
  including component names, navigation, and
  [installation instructions](docs/How-To-User-Guides.md#install-from-a-checkout).

## README maintenance
- Adapt in place; never replace the README with a generic README. Before editing,
  follow [README maintenance](CONTRIBUTING.md#readme-maintenance), including the
  approval boundary for substantial redesign.

## Verification
- Review the diff for duplicate helpers, naming drift, unnecessary abstractions, and regressions.
- Repository policy: keep pytest-xdist in the development dependency group and run Python tests with six workers by default. Do not remove the dependency or reduce this default without explicit user approval. A complete test-suite measurement includes both Traditional Tests and model-backed Agent Evals; report their times and outcomes separately and together.
- Repository policy: call the two categories Traditional Tests and Agent Evals. Use the established labels Instruction Audit, Behavior Evaluation, and Bottleneck Attribution in interfaces, documentation, and reports. Routine Agent Evals use full instructions in the selected setup, with one repetition by default. Behavior Evaluation and Bottleneck Attribution share the same executions; do not add reduced-instruction runs or repeated timing runs by default.
- Agent Evals safeguards use three times the slowest of the five most recent comparable successful attempts, with separate no-reasoning and low-reasoning histories. Preserve diagnostics before fallback, cancellation, or failure; failed attempts must not increase the safeguard. The 120-second safeguard applies only when there is no compatible successful history.
- Run the project’s relevant lint, type-check, and test commands before considering the task done.
- Before native installer work, follow the
  [integration and system procedures](docs/Development.md#integration-and-system-procedures).
- From WSL, never launch native Windows verification executables, directly or
  through helpers: this includes PowerShell, Windows Python/pytest, `cmd.exe`,
  and Windows `uv`. Use independent native Windows CI, not a Windows virtual
  environment or executable launched from WSL.
- For Unix installer changes, follow the same
  [integration and system procedures](docs/Development.md#integration-and-system-procedures).
  Preserve lifecycle link checks and distinguish actual installer proof from
  the generated direct-package smoke.

## User Decisions
- Never answer questions on the user's behalf.
- Do not treat recommended options, defaults, timeouts, or auto-resolution as user approval or user preference.
- If a user decision is required, ask and wait for the user’s explicit answer.
