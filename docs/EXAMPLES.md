# Examples

[Documentation](README.md) · [Explanations](Explanations.md) · [How-to user guides](How-To-User-Guides.md) · [References](References.md) · [Development](Development.md)

- [Choose a bundled team and workspace](#choose-a-bundled-team-and-workspace)
- [Authenticate with Pi](#authenticate-with-pi)
- [Resume a named session](#resume-a-named-session)
- [Select an assignee through Team API](#select-an-assignee-through-team-api)
- [Resolve settings in Python](#resolve-settings-in-python)
- [Inspect launch environment carefully](#inspect-launch-environment-carefully)

Examples describe declared interfaces; they have not been run as part of this documentation pass. Idle server startup needs an installed deployment; starting project agents additionally needs model selections and provider authentication.

<br>

# Choose a bundled team and workspace

From an installed environment, open Paseo, then choose a Team for a Session:

To open the UI before choosing a project:

```shell
ltcook launch runtime
```

Use **+ → LTCook → Team** and send a message to open the Leader chat.
Alternatively, choose the CLI creation default and open an existing directory:

```shell
LTCOOK_TEAM=default-minimal ltcook launch runtime --workspace /path/to/project
```

`default-minimal` is the CLI creation default and contains only Leader and Adjutant.
The GUI composer defaults to installed `default`. Select the
full bundled team with `LTCOOK_TEAM=default`. The full team includes six persistent
members and four explicitly temporary variants; a temporary member must be
spawned explicitly before assignment. Team aliases resolve to the bundled modules.
Additional Teams belong in managed `teams/` workspaces with locked dependencies,
built assets, and a valid public `apiVersion: 3` export.

The shell override applies only to this command. Save a user selection through
AppRC instead:

```shell
ltcook config setup --yes
ltcook config set app.team default-minimal --scope user
```

See [choose a team and resume a session](How-To-User-Guides.md#select-a-team-and-resume-a-session)
for session identity and workspace constraints.

<br>

# Authenticate with Pi

Use the installed native Pi login without configuring OAuth in AppRC:

```shell
ltcook auth login openai
ltcook auth check --provider openai --json --no-refresh
```

For an API key rather than account sign-in, use
`ltcook auth login openai --api-key`. For headless account sign-in, use
`--no-browser`. Credentials are shared through `runtime.pi_auth_dir`, normally
`~/.pi/agent`; project Pi settings and histories remain isolated.
See [Pi authentication](How-To-User-Guides.md#authenticate-with-pi).

<br>


# Resume a named session

A session is bound to its selected team and workspace. Set `LTCOOK_SESSION` to
choose an explicit identifier:

The existing project directory does not need AppRC registration or a marker.

```shell
LTCOOK_SESSION=project-work ltcook launch runtime --workspace /path/to/project
```

When `LTCOOK_SESSION` is unset, opening a project creates a fresh chat Session;
idle server startup creates none. To resume, explicitly reuse the same
`LTCOOK_SESSION`, workspace, and selected
team. A Session cannot silently switch its workspace or team. Multiple Sessions
in one workspace share its logical TeamInstance, but retain separate native
conversations and agent bindings.

Only one TypeScript runtime owns a coordination database. A later launch command
contacts the running runtime to open the workspace session instead of starting a
second owner. If no owner is running, it starts the shared runtime. Team selection belongs to
the requested Session, not the daemon.

<br>

# Select an assignee through Team API

A managed local Team package can reuse the minimal definition and provide
one selection hook. This illustrative module changes Team identity and chooses
from the members Core declares eligible for the requested work:

```typescript
import base from '@ltcook/team-default-minimal';
import type { TeamPackage } from '@ltcook/runtime/team-api';

const team: TeamPackage = {
  apiVersion: 3,
  definition: { ...base.definition, id: 'my-team', name: 'My team' },
  selectAssignee(context, eligible) {
    const preferred = context.workType === 'plan.prefill' ? 'adjutant' : 'leader';
    const selected = eligible.find((member) => member.key === preferred);
    if (!selected) throw new Error(`No eligible member for ${context.workType}`);
    return selected.key;
  },
};
export default team;
```

Core validates the returned member key and persists the assignment before dispatch.
The hook has no runtime handle or approval authority. Omitting the hook uses the
Team's declared `routing`. Leader still schedules execution Tasks through workflow
commands after Plan approval. See [Team API](References.md#team-api).

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
user setting for this invocation. For server startup, use
`ltcook launch runtime`; supply `--workspace ROOT` to explicitly open a project.
The launch helper preserves original shell-variable provenance and reads
initialized project settings only when present. See
[workspace configuration](Explanations.md#configuration-files).

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
