# How-to user guides

[Documentation](README.md) · [Explanations](Explanations.md) · [References](References.md) · [Examples](EXAMPLES.md) · [Development](Development.md)

- [Install and start](#install-and-start)
  - [Install a release](#install-a-release)
  - [Install from a checkout](#install-from-a-checkout)
  - [Run the first command](#run-the-first-command)
  - [Use workspace tools in Pi or Codex](#use-workspace-tools-in-pi-or-codex)
  - [Enable an Intel iGPU for Ollama on WSL](#enable-an-intel-igpu-for-ollama-on-wsl)
  - [Run Agent Evals](#run-agent-evals)
  - [Remove an installation](#remove-an-installation)
- [Configure settings and paths](#configure-settings-and-paths)
  - [Initialize saved preferences](#initialize-saved-preferences)
  - [Choose a model alias](#choose-a-model-alias)
  - [Authenticate with Pi](#authenticate-with-pi)
  - [Choose application paths](#choose-application-paths)
  - [Select a team and resume a session](#select-a-team-and-resume-a-session)
  - [Plan work and answer decisions](#plan-work-and-answer-decisions)
  - [Configure guidance](#configure-guidance)
  - [Configure research tools](#configure-research-tools)
- [Extend and maintain configuration](#extend-and-maintain-configuration)
  - [Add a setting](#add-a-setting)
  - [Use settings in application code](#use-settings-in-application-code)
  - [Troubleshoot configuration and installation](#troubleshoot-configuration-and-installation)

Commands below distinguish installation, configuration, and runtime startup.
Replace `ROOT` with the workspace directory you want the agents to use.

<br>

# Install and start

## Install a release

No LTCook release exists yet. Use [checkout installation](#install-from-a-checkout).
The current manual [release workflow](Development.md#releases) builds Linux assets
for inspection; it does not publish a GitHub Release or a PyPI package.

The Linux setup `ltcook-setup-linux-x86_64` embeds committed project source and
its exact lock. Run it with `--yes --skip-setup`; no adjacent wheel, shell
bootstrap or Python installer is needed. AppRC owns managed runtime slots;
updating uses a newer setup executable, not a main/release/wheel selector.
Building an asset does not prove installation or native Windows/macOS support.

## Install from a checkout

Start with Python 3.12+, Node matching `.node-version`, Bun, uv, Git and just.
From the repository root:

```shell
just sync
uv run --locked ltcook app install -e --yes --skip-setup
```

This registers the checkout's existing `.venv` and publishes its command without
copying or owning the developer environment. The Git commit for AppRC 0.39.1rc1
is pinned in `pyproject.toml` and `uv.lock`. The editable route needs no
Rust/native compilation. On Linux or Windows, add `--desktop` to request a
desktop shortcut with the LTCook icon.

Registration initializes declared AppRC directories, extracts the canonical
`bundle.zip`, and prepares private Node, production dependencies, optional
browser tools and the configured service prerequisites. Local mode validates
Podman and its Compose provider. Missing native prerequisites can require normal
host elevation; this preparation does not start containers. `--skip-setup`
skips only optional configuration, not required initialization.

> [!WARNING]
> A clean prototype reinstall removes the previous LTCook-owned configuration,
> credentials, sessions, histories, caches and installation records. Use the
> installation manager's removal preview before reinstalling. If it cannot
> establish the cleanup inventory, it reports the problem and stops.

Configuration inspection and directory entry do not provision prerequisites.
Use `ltcook app doctor --json` for diagnostics; repeat the supported editable
registration to retry initialization. `config setup` initializes saved settings,
not external prerequisites.

Runtime launches omit an unset or empty `CONTAINER_CONNECTION`, preserving Podman's
default engine selection. Set it to a configured Podman connection name only when
a remote engine is intended.

To update the checkout, use Git, run `just sync`, and repeat editable
registration. `just sync` builds the deployment archive. AppRC's generic
`app update` synchronizes Python dependencies and skips that build.
See [installation placement](References.md#installation-placement) for recorded
resource locations and explicit migration.

> [!WARNING]
> Windows/macOS installation and live web/model workflows are not established by
> Linux checks. Browser installation failure is optional on supported hosts: the
> installer records the failure and continues without autonomous browser tools.
> Re-running the explicit installer retries the browser prerequisite. Core chat
> and configured web-search extensions do not require the browser tool.

## Run the first command

Inspect the application without starting agents:

```shell
ltcook --help
ltcook --version
ltcook app doctor --verbose --json
ltcook app paths
ltcook app doctor --json
ltcook config show --json
```

Run `ltcook` or its `ltcook serve` alias to open the server and bundled UI
without choosing a project:

```shell
ltcook serve
```

This starts or reuses this installation's runtime, requests Paseo in the default
browser, and follows backend logs. From WSL it opens the Windows browser through
`explorer.exe`, never a WSL browser. Exact reuse or focus of an existing tab depends
on the browser. Ctrl+C detaches the log viewer and leaves the runtime running.
Stop that runtime explicitly with `ltcook stop`; Compose containers remain managed
separately by `ltcook services stop`.

For a browser-free foreground server, use `ltcook launch runtime`. Ctrl+C stops
a server started by that foreground command; reusing a server does not take over
its ownership. Old or raw developer runtimes without output capture must be
restarted through the installed CLI before desktop log attachment is available.

The normal terminal view shows LTCook information messages and upstream
warnings/errors, with concise messages and bounded, actionable context.
Routine Paseo connection messages and metrics do not appear in this view.
Use `ltcook --verbose` for diagnostic messages, full structured context and
error stacks. Colors are enabled only for an interactive terminal; set
`NO_COLOR=1` to disable them. Unrecognized output remains visible.
These are presentation choices: the original diagnostic files retain their
raw contents in either mode.

Logs include private captured stdout/stderr in `<deployment>/logs/backend.log`,
the configured telemetry JSONL, and Paseo's rotating daemon log. Upstream output
can contain sensitive details; do not share these files without reviewing them.
If browser opening fails, the terminal prints the URL and continues following
logs. WSL host navigation requires working interop and localhost forwarding.

Opening the UI does not create a Session or start agents. In Paseo, use
**+ → LTCook**, choose an installed **Team**, and send a message. The native
agent is the Leader; its chat opens directly. On desktop, use the Team dropdown.
On narrow screens, open the composer controls and select a Team from the native
sheet before sending. Use the Model control to [choose an alias](#choose-a-model-alias)
for the Leader. For hosted models, [authenticate with Pi](#authenticate-with-pi).

The contextual **Team** panel is secondary to the Leader chat:

- The overview separates the **Leader**, **Persistent members**, running
  **Temporary members**, and **Available temporary roles**. Connected members
  have direct **Open conversation** actions. It also shows active Passes,
  progress, and actionable blockers.
- **Task Board** groups Tasks by their recorded state. Select a Task to inspect
  its description, acceptance criteria, ordered Steps, blocker and report.
- **Agent Focus** shows role settings, current assignments, recorded handoff and
  report, plus native model/activity when available. **Open conversation** uses
  Paseo's existing chat and is unavailable for disconnected members.

## Use workspace tools in Pi or Codex

Open an ordinary Pi or Codex chat in a workspace through LTCook's Paseo host.
Paseo attaches the local tool connection when it opens or resumes the chat.
Pi shows the LTCook tools directly, and Codex may discover them through tool
search. Some Codex modes ask for permission before calling an MCP tool.

- Use `ltcook_web_search` for SearXNG, `ltcook_web_fetch` for URLs, and
  `ltcook_web_content` for stored search/page results. All three use the
  shared workspace catalog in Pi and Codex. Keep the response ID in the
  same chat to read or page through results.
- Ask for a repository and environment inventory to use `ltcook_ried`. It can
  return a summary, inspect one section, or refresh the inventory.
- In Pi, ask for code by meaning to use `ltcook_repo_search`. For example, ask
  “Where does the runtime recover an interrupted assignment?” Add a relative
  path to narrow results. The first search builds the workspace index and can
  take longer than later searches. If another request is populating the index,
  retry once it finishes. If setup assets are missing or damaged, repeat the
  [installation procedure](#install-from-a-checkout) for your installation.
  Codex repository search requires a trusted read scope, which the current
  Paseo launch hook does not provide.
- Ask for a summary using `ltcook_summarize`. Supply text or ask Pi to summarize
  one regular UTF-8 file from the selected workspace, up to 24 KiB. An optional
  focus tells the summarizer what to emphasize. Codex accepts text because its
  file-read policy is outside the workspace connection's authority. Check
  consequential details such as identifiers and negated actions against the source.

The summarizer uses `@tiny-local`, which defaults to Spark X2.6 4B Q8_0 with
reasoning off. Pull it on the configured Ollama instance before the first
summary. Setup checks readiness without downloading Spark.

```shell
ollama pull hf.co/XHToken/Spark-X2.6-4B-GGUF:Q8_0
```

Run `ltcook app doctor --verbose --json` to check readiness. RIED and ordinary
hosted chats work without Spark. AppRC's global
[summarizer settings](References.md#environment-variables) apply when the runtime
starts. A keep-alive of `-1` keeps the model resident after use. Set it to `0`
to unload after a request or to a positive number of seconds for timed residency.

## Enable an Intel iGPU for Ollama on WSL

Configure acceleration on the Ollama server. LTCook's summarizer uses the local
server selected by `LTCOOK_OLLAMA_ENDPOINT`, which defaults to
`http://127.0.0.1:11434`. The Ollama server chooses where to load each model.
[Ollama GPU support](https://docs.ollama.com/gpu)

For a systemd-managed Ollama server inside WSL 2, check that WSL exposes
`/dev/dxg` and that your Linux distribution supplies the Mesa Dozen Vulkan
driver. Fedora 44's `mesa-vulkan-drivers` package installs the x86-64 Dozen
driver manifest shown below. Use the installed Dozen manifest path on other
distributions. [Fedora package files](https://packages.fedoraproject.org/pkgs/mesa/mesa-vulkan-drivers/fedora-44.html)

Edit a dedicated service drop-in:

```shell
sudo install -d /etc/systemd/system/ollama.service.d
sudoedit /etc/systemd/system/ollama.service.d/70-igpu.conf
```

```ini
[Service]
Environment="OLLAMA_VULKAN=1"
Environment="OLLAMA_IGPU_ENABLE=1"
Environment="VK_DRIVER_FILES=/usr/share/vulkan/icd.d/dzn_icd.x86_64.json"
Environment="OLLAMA_FLASH_ATTENTION=0"
```

The Flash Attention setting avoids a shader crash observed with the Intel
UHD Graphics 770 on WSL. Restart the Ollama service after saving the drop-in:

```shell
sudo systemctl daemon-reload
sudo systemctl restart ollama.service
```

Run a summary or a prompt through the configured server, then use `ollama ps`
against that same endpoint while the model is still loaded. The `PROCESSOR`
column shows how much of the model was offloaded. Use
`journalctl -u ollama.service -b` to check which Vulkan device Ollama selected
or to diagnose a runner crash. To undo this setup, remove only
`70-igpu.conf`, reload systemd, and restart Ollama.
[Ollama server settings and GPU verification](https://docs.ollama.com/faq#how-can-i-tell-if-my-model-was-loaded-onto-the-gpu)

## Run Agent Evals

Agent Evals provides **Instruction Audit**, **Behavior Evaluation**, and
**Bottleneck Attribution** through the CLI and the Paseo diagnostics panel.
Choose **Current Setup** (the default) to evaluate the active team and installed
guidance under local Bonsai, or **Synthetic Setup** for the packaged scenarios.
Current Setup uses the selected registered workspace when available, otherwise
global configuration. It does not measure the team's normal cloud model.

Both setups have completed with Bonsai. Results vary between runs; failed
attempts retain diagnostics for investigation. See the [backlog](../BACKLOG.md)
for the remaining reliability work.

```shell
ltcook eval audit --static-only
ltcook eval audit --setup current
ltcook eval run --setup current
ltcook eval run --quick --setup synthetic
ltcook eval run --setup synthetic --case read-only
ltcook eval run --setup synthetic --repetitions 2
ltcook eval run --all --setup synthetic
ltcook eval run --all --setup synthetic --case summarization
ltcook eval analyze --setup synthetic
ltcook eval list
ltcook eval watch RUN_ID
ltcook eval status RUN_ID
ltcook eval report RUN_ID
ltcook eval report RUN_ID --json
ltcook eval cancel RUN_ID
ltcook eval delete RUN_ID
```

Static Instruction Audit works without Ollama. The team Behavior Evaluation and
semantic Instruction Audit require local Ollama and the prepared Bonsai model.
Existing installations prepared for another model need the normal
setup or repair flow to prepare Bonsai. `ollama ps` shows the context and GPU
allocation while the model is loaded. Behavior Evaluation uses full instructions in the selected setup. It runs the
read-only, no-op and targeted-fix agent cases once each unless `--case` selects
one or `--repetitions N` requests more agent executions. These agent cases start
with reasoning off and may fall back once to low reasoning on Bonsai. If the
fallback also fails, the run stops and preserves the evidence.

Normal Behavior Evaluation also runs the core summarization evaluations. They
call the AppRC-configured local summarizer on fixed fixtures. Bonsai grades the
summaries after passing a calibration check. The CLI and Paseo panel show
summarization qualification separately from the run's execution status. A
confirmed required-fact omission, contradiction, invented material claim, or
cutoff fails qualification. Unavailable or inconclusive grading can block
qualification. The report retains the cases that ran and their evidence.

To qualify a change to the recommended model, prompt, generation settings, or
input preparation, run `ltcook eval run --all --setup synthetic --case summarization`.
It adds the near-limit input, file/inline comparison, three attempts for
selected high-risk cases, and a downstream native Pi decision. In the Paseo
diagnostics panel choose **Synthetic Setup**, **Summarization only**, then
**Run full qualification**. The command exits unsuccessfully for both failed
and blocked qualification. Use `ltcook eval report RUN_ID --json` or the panel's
structured data to inspect fixed-fixture summaries, evidence, and model versions.

Add `--summarization-grader gpt-6-luna` to a CLI run with
`--case summarization` to use hosted GPT-6 Luna with high reasoning for grading
and the full qualification rollout decisions. This requires a signed-in
Codex CLI on PATH. Only the fixed fixtures and
the summaries generated from them are sent to OpenAI. Candidate generation
still uses the AppRC-configured local Ollama model. If Luna is unavailable,
semantic grading is blocked.

Bottleneck Attribution uses the timings and traces from the same executions;
it does not repeat the agent's work just to measure time. Instruction Audit is
requested separately with `eval audit`, or together with the cases using
`eval run --all`. Semantic findings are suggestions requiring review.

Reports show actual elapsed time, the case safeguard and the successful runs
used to calculate it. The safeguard is three times the slowest of the five most
recent comparable successful attempts, with separate reasoning-mode histories.
Without a compatible baseline, the report identifies its 120-second bootstrap
safeguard. Failed attempts do not increase it. Partial results and sanitized
diagnostics remain available after a failure or cancellation.

Evaluation execution uses disposable state and workspace snapshots. Reports list
included and excluded resources, configuration provenance, unsupported tools, and
other limitations. Interactive Plan approval is outside evaluation coverage.
Linux and WSL execution require working Bubblewrap isolation; unavailable sandbox
support is reported as an error. Configured network access remains enabled.

The CLI and Paseo share progress, cancellation, history, and sanitized results in
runtime state. Closing the terminal detaches from a run; use `cancel` to stop it.
Unsupported records from older evaluation formats are left unchanged. To reset
history, stop the runtime, preserve any wanted results, and remove only its
`evals/runs` directory before restarting.

Use **Refresh** to reload coordination state. Recorded dependencies, verification
and approval gates, unavailable members, and uncertain deliveries explain why
work is waiting or blocked. Private work
text is fetched only for the selected detail, not included in bulk status data.

To open an existing project directory directly from the terminal:

```shell
ltcook launch runtime --workspace ROOT
```

Neither registration nor an AppRC marker is required. An existing
`apprc.workspace.env` enables the normal project settings and secret layers;
without it, launch uses user settings. Launching does not create markers or
registry entries. `ltcook workspace add project-name ROOT --yes` remains an
optional way to manage project-specific AppRC configuration.

The runtime starts Paseo using its built-in Pi provider. In local service mode,
opening a project starts the prepared LTCook Compose project; idle startup does
not start containers. In direct or
tunnel mode, the configured services remain on their remote host. Check service
status before relying on live research. Runtime startup prints `Paseo <listen>`;
open `http://<listen>/` in a browser for Paseo's bundled web UI. The UI is
enabled by the runtime and needs no separate server, assets, or dependency. You
can also connect through Paseo's existing client and select the LTCook
team-status panel. If `LTCOOK_PASEO_PASSWORD` is set, it protects API and
WebSocket access, not the static HTML page. Never put the password in the URL.
The minimal team contains Leader and Adjutant, not hidden specialists. Starting
agents is distinct from sending a model-backed prompt, which needs a working
provider and explicit input. The former terminal `ltcook launcher` is removed:
use bare `ltcook` for Paseo and `ltcook app ...` for maintenance.

## Remove an installation

If this installation has been started, run `ltcook stop` and
`ltcook services stop` before previewing removal. Confirm both succeed; stop
and resolve failures before uninstalling. AppRC's runtime locks do not stop
LTCook's detached Node process, which must release its database and deployment
before those directories are removed. A never-started installation needs no
service credentials for its uninstall cleanup.

Preview with `ltcook app uninstall --dry-run`, then use
`ltcook app uninstall --yes` to remove the program and its managed configuration,
appdata, cache, and state. Interactive uninstall offers to keep configuration.
Add `--keep-config` to both commands to explicitly retain settings and secrets.
Shared Pi authentication and external workspaces are excluded from removal.
Use `--remove-repository` to also select the editable checkout and any environment
inside it. AppRC rejects checkout removal if it contains configuration selected
for retention.

> [!CAUTION]
> Uninstall deletes deployment, sessions, runtime documents, and coordination
> data even with `--keep-config`. Review the dry-run paths before confirming.

The [uninstaller reference](References.md#uninstaller-reference) explains complete
removal. LTCook cleanup is scoped to its recorded deployment and Compose project;
it must not remove an independent `lcook` installation, unrelated services, shared
Podman, or external workspaces. Invalid ownership metadata preserves the affected
resources for recovery rather than guessing what can be deleted.

<br>

# Configure settings and paths

## Initialize saved preferences

Use the existing AppRC configuration CLI:

```shell
ltcook config setup --yes
ltcook config set app.team default-minimal --scope user
ltcook config edit
ltcook config show --json
```

`app.team` uses `LTCOOK_TEAM` and defaults to `default-minimal`.
[Model aliases](#choose-a-model-alias) have defaults. Use AppRC to replace a
physical model when needed. Provider credentials come from native login or a
provider secret field such as `OPENAI_API_KEY`. `config show --json` reports
application settings without exposing OAuth credentials.

Explicit runtime and service starts create only missing runtime, Crawl4AI and
SearXNG secrets after installation is Ready, preserving existing values. They do
not generate provider credentials. Status, diagnosis and auth checks do not
initialize these service secrets.

The [configuration layers](Explanations.md#configuration-files) preserve saved
user defaults, registered workspace overrides, and deliberate shell exports.
AppRC does not take ownership of arbitrary repository `.env` files. Use
`ltcook config --help` for the installed version's workspace and secret-file
management commands rather than inventing another configuration editor.

## Choose a model alias

| Alias | Model | Preset reasoning |
| --- | --- | --- |
| `@smol` | GPT-6 Luna | Provider default |
| `@tiny` | GPT-6 Luna | Low |
| `@tiny-local` | Spark X2.6 4B Q8_0 on Ollama | Off |
| `@smart` | GPT-6.2 Sol | Provider default |
| `@plan` | GPT-6.2 Sol | Xhigh |
| `@expensive` | GPT-6 Astra | Provider default |
| `@review-art` | GPT-6 Astra | Medium |

In a new Paseo LTCook conversation, choose a Team, then choose a Model for its
Leader. **Team assignment** uses the Leader's declared alias. An explicit
session reasoning choice takes priority over the Team member setting, the alias
preset, and the provider default, in that order. The composer shows when a
setting overrides the alias preset. For example, the default Team's Reviewer
uses `@plan` with its explicit high effort. Spark supports off, low, and high.

The draft previews runtime defaults. Workspace AppRC settings are applied at
launch. Paseo saves the resolved provider, model, and reasoning with the
conversation. Reopening it uses the last saved native settings even after an
alias changes. A live change through Paseo's native controls updates the
settings shown in the running conversation.

Use the terminal launcher to start a new native conversation:

```shell
ltcook launch model pi @plan
ltcook launch model codex @tiny
ltcook launch model pi @tiny-local --reasoning high
```

Pi uses the configured provider and the native Pi login. Codex uses its installed
CLI and its current login for hosted models. Pass other native launch arguments
after `--`. Reopen managed Sessions in Paseo. To resume a terminal
conversation, use the native CLI. For a Pi session with a custom model, such as
Spark, register the saved provider and exact model ID in the native Pi
`models.json` before resuming. Copy the relevant model entry from the workspace
Pi configuration, which `ltcook launch write-native-config --workspace ROOT`
can generate.

Change the physical model slots in
[AppRC](References.md#environment-variables). For hosted slots enter
`provider/model` and set effort through the Team or session. Drop any previous
`:effort` suffix. `@plan` shares the smart slot. The tiny-local slot accepts the
Ollama model tag, including its quantization suffix.

## Authenticate with Pi

LTCook exposes the installed Pi authentication CLI without implementing another
login flow:

```shell
ltcook auth login openai-codex
ltcook auth check --provider openai-codex --json --no-refresh
ltcook auth logout openai-codex
```

`login` requires an interactive terminal. For a headless machine, use
`ltcook auth login openai-codex --no-browser` and follow Pi's instructions. To store an
OpenAI API key rather than sign in with an account, use
`ltcook auth login openai --api-key`. Account OAuth and API billing credentials
are different methods; configuring `OPENAI_API_KEY` is not a ChatGPT login.
The wrapper preserves Pi's exit status; `auth check` reports ready/not-ready/invalid
without printing the credential. `--no-refresh` avoids refreshing an expired
OAuth token during inspection.

All LTCook projects use `<LTCOOK_PI_AUTH_DIR>/auth.json`, defaulting to
`~/.pi/agent/auth.json`. Existing Pi credentials there are reused. Set the
user-scoped `runtime.pi_auth_dir` (`LTCOOK_PI_AUTH_DIR`) to use another native Pi home.
Workspace-local Pi settings, models, extensions, web configuration, and session
histories remain separate; credentials are not copied or linked into those homes.
Earlier logins stored only in a workspace Pi home are not imported: run the
shared login once, or select an existing user-level auth home.

Logout removes stored credentials; it does not unset API keys in AppRC or the
environment, or revoke credentials at the provider.

> [!CAUTION]
> Login and logout affect other Pi instances using the same credential home.
> Keep `auth.json` private. LTCook does not remove an external shared Pi auth home
> when uninstalling its own application resources.


## Choose application paths

AppRC records absolute native or explicitly selected resource locations
separately from program ownership. Config, appdata, cache and state are enabled
independently. Use `ltcook app migrate --help` for supported explicit relocation;
do not move/edit the fixed native `installation/` authority by hand.

The default deployment is `<appdata>/deployment`, including private `node/`,
production `app/` and service receipts. Runtime documents and coordination use
`<state>/runtime` by default; cached project facts use `<cache>/projects`. Paseo's mutable home
defaults to `<LTCOOK_DEPLOYMENT_DIR>/paseo`, outside the replaceable
`<LTCOOK_DEPLOYMENT_DIR>/app` bundle. Workspace Pi homes default to
`<LTCOOK_DEPLOYMENT_DIR>/workspaces/<workspace-id>/pi`.
Shared provider authentication is separate: `runtime.pi_auth_dir` defaults to Pi's
user-level `~/.pi/agent`, and the SDK reads that home's `auth.json` without
changing the workspace-specific `PI_CODING_AGENT_DIR`.

`PASEO_HOME` must resolve inside the current deployment but outside its immutable
`app/` tree. `PI_CODING_AGENT_DIR` must resolve inside the deployment. Invalid
paths are rejected with the variable name.

Use `ltcook app paths` and `ltcook app doctor --json` to inspect actual locations.
See [project paths](References.md#project-paths).

## Select a team and resume a session

Use an existing project directory; registration and workspace initialization are
optional, as described in the [first-launch step](#run-the-first-command).

For a single POSIX invocation:

```shell
LTCOOK_TEAM=default-minimal LTCOOK_SESSION=my-project ltcook launch runtime --workspace ROOT
```

The aliases `default` and `default-minimal` resolve to local Team packages.
The catalog discovers managed direct packages under `teams/`; they must have
locked dependencies, built assets, and the current `apiVersion: 3` contract.
It accepts a local directory selection or canonical Team ID, not arbitrary module
paths. Changing a selection does not install a package.

The **Teams** sidebar lists installed, available, and invalid local Teams.
Select an installed Team to open its most recently active Leader in the chosen
Workspace, or create one when absent. **New Session** always starts a separate
conversation. When no Workspace is selected, use Paseo's native project and
Workspace choice. The Team badge in a running chat is read-only.

When `LTCOOK_SESSION` is unset, opening a project creates a fresh chat Session.
Starting the server without a project creates none. Set `LTCOOK_SESSION`
explicitly to resume that Session with the same workspace and
selected team; a Session cannot silently switch either. Multiple Sessions in one
workspace share a persistent TeamInstance, while their native conversations and
agent bindings remain separate.

Only one runtime owns a coordination database. A later `ltcook launch runtime
--workspace ROOT` command contacts that runtime to open the requested project
session. A launch without `--workspace` only starts or connects to the idle host;
it does not select a project. Stop the owner before starting another
runtime against the same database. Different Teams and multiple Sessions in one
Workspace share the same owner; each Session keeps its own Team and bindings.

Recovery reconciles native bindings and leaves uncertain handoffs blocked rather
than resending them. Inspect the panel's blockers and native conversations before
choosing further action. Restarting is not renewed permission to repeat an
external operation. [Coordination and recovery](Explanations.md#coordination-and-recovery)
explains the ownership boundary.

To start with a new coordination database, stop its owning runtime and select
an empty store before restarting:

```shell
ltcook config set runtime.database /absolute/path/to/new-coordination.sqlite --scope user
```

The new store starts new coordination Sessions. Pi/Paseo histories and shared
authentication remain with their native owners; selecting a fresh store does
not authorize replay of an uncertain action.

## Plan work and answer decisions

Open an explicit project Session first. Have the Team write its Design under
`<LTCOOK_RUNTIME_STATE_DIR>/documents/designs/`, using
`Design-YYYY_MM_DD-HH_MM-<concise-title>.md`. Start planning with its absolute path:

```shell
ltcook planning start --session SESSION --design /absolute/path/Design-2026_11_14-18_00-example.md --title example
ltcook planning show --session SESSION --plan Plan-2026_11_14-18_05-example
ltcook planning questions --session SESSION --plan Plan-2026_11_14-18_05-example
```

Use the registered Plan ID returned by `start`; example timestamps are illustrative.
`show` reads its current Markdown and workflow state; add `--json` for raw state.
Adjutant writes the proposed Plan, then Leader investigates and finalizes the same
file. Pending questions use native Paseo dialogs. If a dialog is interrupted,
inspect `questions` and answer explicitly through the authenticated CLI:

```shell
ltcook planning answer --session SESSION --plan PLAN_ID --decision DECISION_ID --answer 'Use clean breaking changes'
ltcook planning approve --session SESSION --plan PLAN_ID
ltcook planning reject --session SESSION --plan PLAN_ID
```

`approve` succeeds only after finalization, complete topic coverage, answered
mandatory categories and no outstanding blocking decisions. Rejection does not
permit execution. Missing responses, defaults and cancellation remain pending.
Session and Plan context are always explicit; these commands do not create a
Session or infer one from the current directory.

After approval, Leader registers the initial execution Tasks and completes the
scheduling handoff. The runtime dispatches eligible Tasks in creation order,
allowing different members to work concurrently and one active assignment per
member. A blocking decision pauses new dispatch. A failed prerequisite keeps
its dependents blocked: Leader registers a linked correction, waits for it to
finish, then explicitly retries the original Task. Its dependents unlock only
when that original Task succeeds. The full Team receives one independent
Pass-wide review; the minimal Team may register optional self-inspection before
the final execution Task finishes.

The Team appends detailed implementation reporting to the Plan, including
`Implementation Report`, `Emerging Issues` and `User decisions post approval`.
Lasting design decisions also belong in the Design. Appending reports does not
reset approval; a material scope change requires an explicit new user decision.

## Configure guidance

User guidance defaults to `<AppRC config>/guidance/rules/` and `skills/`. Set its
global root through AppRC when needed:

```shell
ltcook config set runtime.guidance_dir /absolute/path/guidance --scope user
ltcook guidance inspect --session SESSION
ltcook guidance inspect --session SESSION --agent NATIVE_AGENT_ID
```

Personal writing, language/frontend guidance and detailed Modes planning preferences are supplied by the User, not bundled by Core. For example, register native skills named `typescript-best-practices`, `vercel-react-best-practices`, and `principle-minimize-reader-load` in the user skills directory. Existing `ltcook-typescript`, `ltcook-react-vite` and `ltcook-reader-load` invocations are removed.

Shared personal skills in `~/.agents/skills/` are also loaded, matching standalone
Pi and Codex. LTCook resolves this user directory before switching native agent
`HOME`; project settings cannot redirect it. An absent shared directory is harmless.
The same physical skill is loaded once; distinct files with the same skill name
fail activation. Keep skill bodies and relative references together in one directory.

Rules are Markdown standing instructions. Skills use native `SKILL.md` directories
with names and descriptions. Their bodies and references load on demand; explicit-only skills remain available only on request. The inspector reports scope,
kind, applicability, diagnostics and actual native loading. Distinct resources
with conflicting names fail activation; repeated discovery of the same physical
resource is deduplicated. Required Core resources must be present.

Project `AGENTS.md`, `.pi/skills` and `.agents/skills` keep native trust behavior.
Global roots resolve before native agents change `HOME`; project settings cannot
redirect shared state, User guidance or the shared auth home. Core planning guidance applies to every Team. Optional integrations do not disable
it or the execution guards.

## Configure research tools

Use the `web` section for `web.searxng_url`, `web.crawl4ai_url`, and
`web.ssrf_allow_ranges`, and the AppRC setting `web.crawl4ai.api_token` for the
Crawl4AI credential (`CRAWL4AI_API_TOKEN`). The typed Python bundle exposes that
credential as `config.crawl4ai.api_token`. Local Compose assets bind to loopback.
For a central host, configure reachable URLs and explicitly choose
`web.connection_method` (`direct` or `paseo-tunnel`); Paseo pairing alone does
not expose arbitrary HTTP services. Remote service control remains on that host.
Only allow the private network ranges actually needed; do not disable SSRF
protection globally.

The commands use the current directory by default; pass `--workspace ROOT` to
resolve service configuration for a specific workspace.

Project-specific service overrides are optional. Existing initialized AppRC
workspace settings are used when present; service commands do not create markers.

Use the service commands for local Compose operations:

```shell
ltcook services start
ltcook services status
ltcook services logs
ltcook services stop
```

`start` starts the services in local mode; `status` inspects their containers and
`logs` shows recent output. `stop` stops SearXNG and Crawl4AI without removing the
project. Opening a project in local mode also starts the Compose project.
Check service status before live research: command success does not establish
healthy containers or successful web requests.

For `web.connection_method=direct` or `paseo-tunnel`, local commands do not
operate the remote host. Start and inspect remote services there. The local
controller cannot verify remote health or remove remote services.

The SearXNG Compose service publishes host loopback port `8888` to container port
`8080`, matching the AppRC default URL. This configuration correspondence does
not by itself prove that live searches succeed.

Lookup instructions start with a known source or targeted search. Explore
instructions compare alternatives and gaps from the outset. Both use SearXNG
search and HTTP/Crawl4AI retrieval; neither enables extension-internal model
summaries, query rewriting, or hosted fallback providers. Crawl4AI's configured
pool limits the server to two concurrent pages with one worker.

> [!IMPORTANT]
> Codesearch sends explicit public-code searches to hosted grep.app. Optional
> Context7 sends library-documentation requests to its hosted service. Neither is
> a private local index or an automatic SearXNG fallback. Do not submit secrets or
> private source to external tools.

The autonomous browser needs the separate `agent-browser` executable and browser
files prepared during installation. Enabling its Pi extension alone is not enough.
`runtime.browser_enabled` controls activation, `runtime.codesearch_enabled` controls
codesearch, and `runtime.context7_enabled` defaults to false. Browser prerequisites
are never installed by a passive status check or team activation.

<br>

# Extend and maintain configuration

## Add a setting

Add real application settings to the owning registered class in
[`config/sections`](../src/ltcook/config/sections), using `rc.field(...)` with the
consumer's exact environment name. Register new sections with `APP_RC.config(...)`
and include them in [`LtcookConfig`](../src/ltcook/config/bundle.py). Do not add
example retry/message fields or keep hidden TypeScript defaults.

Consume each section's `current_env_mapping()` in the appropriate workspace
launch, and add native translation only where a component requires its own
format. Mark credentials `secret=True`; redaction does not encrypt their stored
files. Follow [working conventions](../CONTRIBUTING.md#working-conventions).

## Use settings in application code

This illustrative program reads the existing team setting; it does not write
configuration or start agents:

```python
from ltcook.config.app import APP_RC
from ltcook.config.bundle import LtcookConfig

resolved = APP_RC.resolve()
config = resolved.build(LtcookConfig)
print(config.app.team)
```

Pass the resolved bundle or section to code that needs it. In a mounted Typer
command, reuse `state.resolved` rather than resolving the invocation twice.
Workspace launch code uses `resolve_launch(ROOT, original_environment=...)` to
resolve settings for the target workspace from original shell inputs. It does
not treat a prior workspace's merged environment as shell input. The
[settings example](EXAMPLES.md#resolve-settings-in-python) reads the existing
team setting without replacing application modules.

## Troubleshoot configuration and installation

Use `ltcook app paths` and `ltcook app doctor --json` for passive inspection.

| Symptom | Action |
| --- | --- |
| Command unavailable | Use the installed environment's executable or `python -m ltcook`. |
| Saved team is ignored | Compare `LTCOOK_TEAM` shell exports and registered workspace overrides. |
| Runtime deployment is missing | Run `just sync`, then repeat editable registration to initialize the staged payload. |
| Model alias is empty | Configure the matching `runtime.*_model` or smart fallback and provider credentials. |
| Provider authentication is not ready | Run `ltcook auth check --provider openai --json --no-refresh`, then use Pi login for the selected provider. |
| Ollama uses the CPU on an Intel iGPU under WSL | Check the Ollama service's Vulkan configuration and verify offload while a model is loaded. See [Enable an Intel iGPU for Ollama on WSL](#enable-an-intel-igpu-for-ollama-on-wsl). |
| Session reports a different team/workspace | Restore the original selection or choose a new session identifier. |
| Database already has an owner | Stop that runtime; do not delete its lock or run another recovery owner. |
| Browser unavailable | Inspect the installation receipt and browser prerequisites; do not confuse it with core chat/search availability. |
| Web tools cannot connect | Check configured URLs, actual Compose ports, credentials, network access, and narrow SSRF allowances. |
| Saved installation is incomplete | Inspect `ltcook app doctor --json` and repeat the installation procedure for your installation. |

The internal `python -m ltcook.launch environment --workspace ROOT` command emits
raw child-process environment values, including secrets. It is not a redacted
diagnostic; do not paste its output into issues, logs, or a shared terminal.
Use the [command reference](References.md#command-reference) for safe inspection.
