# Examples

[Documentation](README.md) · [Explanations](Explanations.md) · [How-to user guides](How-To-User-Guides.md) · [References](References.md) · [Development](Development.md)

- [Choose a bundled team and workspace](#choose-a-bundled-team-and-workspace)
- [Resume a named session](#resume-a-named-session)
- [Resolve settings in Python](#resolve-settings-in-python)
- [Inspect launch environment carefully](#inspect-launch-environment-carefully)

Examples describe declared interfaces; they have not been run as part of this documentation pass. Runtime startup additionally requires an installed deployment and configured provider.

<br>

# Choose a bundled team and workspace

From an installed environment, select a team for this process and launch it in
a workspace directory:

Before the first workspace-targeted command, register the repository with AppRC:

```shell
ltcook workspace add project-name /path/to/project --yes
```

```shell
LTCOOK_TEAM=default-minimal ltcook launch runtime --workspace /path/to/project
```

`default-minimal` is the default and contains only Main and Adjutant. Select the
full bundled team with `LTCOOK_TEAM=default`. The full team includes six persistent
members and four explicitly temporary variants; a temporary member must be
spawned explicitly before assignment. Team aliases resolve to the bundled modules.
An installed third-party module can also be selected by its resolvable module
specifier, provided it exports the fresh public `apiVersion: 1` contract.

The shell override applies only to this command. Save a user selection through
AppRC instead:

```shell
ltcook config setup --yes
ltcook config set app.team default-minimal --scope user
```

See [choose a team and resume a session](How-To-User-Guides.md#select-a-team-and-resume-a-session)
for session identity and workspace constraints.

<br>

# Resume a named session

A session is bound to its selected team and workspace. Set `LTCOOK_SESSION` to
choose an explicit identifier:

The workspace must already have the AppRC registration shown in the preceding example.

```shell
LTCOOK_SESSION=project-work ltcook launch runtime --workspace /path/to/project
```

When `LTCOOK_SESSION` is unset, the launcher derives a stable identifier from
the workspace. Reopening with the same identifier, workspace, and team resumes
that session. A persisted session cannot be switched to another team or
workspace.

Only one TypeScript runtime owns a coordination database. A later launch command
contacts the running runtime to open the workspace session instead of starting a
second owner. If no owner is running, it starts a runtime for the selected team.

<br>

# Resolve settings in Python

This complete program reads `AppSettings.team` from the settings available to the
current process. Save it as `read_team.py` in the installed Python environment:

```python
from ltcook.config.app import APP_RC
from ltcook.config.bundle import LtcookConfig

resolved = APP_RC.resolve()
config = resolved.build(LtcookConfig)
print(config.app.team)
```

The value defaults to `default-minimal`; `LTCOOK_TEAM` can override the saved
user setting for this invocation. For actual runtime startup, prefer
`ltcook launch runtime --workspace ROOT`: it resolves the target workspace and
preserves original shell-variable provenance before passing the environment to
native processes. See [workspace configuration](Explanations.md#configuration-files).

<br>

# Inspect launch environment carefully

The internal diagnostic command returns the resolved workspace and the child
process environment:

```shell
python -m ltcook.launch environment --workspace /path/to/project
```

Its JSON can contain credentials. Use it only in a private terminal when
necessary; never attach its output to an issue or paste it into shared logs.
The public command `ltcook config show --json` is the safer way to inspect
application settings and paths. Neither command proves that external services
are reachable or that a model request succeeds.
