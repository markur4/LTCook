# Documentation

- [Find the right page](#find-the-right-page)
  - [Start here](#start-here)
  - [Choose a document](#choose-a-document)
- [Documentation conventions](#documentation-conventions)
  - [Component names](#component-names)
  - [Documentation rules](#documentation-rules)

<br>

# Find the right page

## Start here

LTCook connects Pi agents and interchangeable teams to Paseo. Install from a
checkout using the [installation guide](How-To-User-Guides.md#install-from-a-checkout),
then run `ltcook launch runtime` to open the idle server/UI. Before starting
agents, choose models in AppRC and [authenticate through Pi](How-To-User-Guides.md#authenticate-with-pi).
The application defaults to the two-member `default-minimal` team. The
[team-selection guide](How-To-User-Guides.md#select-a-team-and-resume-a-session)
shows how to choose a team and open an existing project directory; registration
and workspace markers are optional.

The [Explanations](Explanations.md) page describes how AppRC, native Pi/Paseo,
the runtime, and interchangeable teams connect. Use
[Examples](EXAMPLES.md) for source-grounded invocations and
[References](References.md) for exact settings, commands, paths, and interfaces.

## Choose a document

| Document | Purpose |
| --- | --- |
| [Explanations](Explanations.md) | Explain application components and how their boundaries fit together. |
| [How-to user guides](How-To-User-Guides.md) | Complete an installation, configuration, team, or troubleshooting task. |
| [References](References.md) | Look up exact commands, files, environment variables, and public interfaces. |
| [Examples](EXAMPLES.md) | Follow short, independent configuration and launch examples. |
| [Contributing](../CONTRIBUTING.md) | Shared conventions and the normal quick setup and checks. |
| [Development](Development.md) | Detailed development, packaging, integration, and release guidance. |

<br>

# Documentation conventions

## Component names

Use these names consistently:

| Name | Implementation | Responsibility |
| --- | --- | --- |
| AppRC | `ltcook.config.app.APP_RC` | One settings, workspace, secret-file, and path declaration. |
| `AppSettings` | `ltcook.config.sections.app.AppSettings` | Selects team, session, workspace, and deployment. |
| `LtcookConfig` | `ltcook.config.bundle.LtcookConfig` | Groups LTCook's registered AppRC settings sections. |
| Launch helper | `ltcook.launch.resolve_launch()` | Resolves global settings or optional project overrides from original shell inputs. |
| `ltcook` CLI | `ltcook.cli.app.app` | Exposes AppRC commands, runtime launch, and native Pi authentication. |
| Runtime | `runtime/src/main.ts` | Starts the idle Paseo host and opens project Sessions on explicit user request. |
| Pi authentication | `ltcook auth` and native Pi's SDK | Shares Pi-managed credentials while keeping project settings and histories separate. |
| Team package | `TeamPackage` in `runtime/src/team-api/index.ts` | Provides versioned member, guidance and work-routing declarations. |
| Deployment bundle | `src/ltcook_distr/bundle.zip` | Canonical archive of runtime, team, resource, service and lock assets for installation. |
| Lifecycle payload | `src/ltcook_distr/payload/app_lifecycle` | Prepares and maintains LTCook-owned installation resources. |

## Documentation rules

Describe implemented behavior and use exact source-declared settings and commands.
Link the relevant phrase to its component explanation, task guide, or reference;
keep useful cross-links at the point where a reader needs them. Do not document
an imagined setup command, old `lcook` adapter, GUI, notebook, or second chat UI.

Examples should be independent and illustrative, state prerequisites, and avoid
printing secrets. Do not imply that a command has been run or that an external
service, model workflow, or platform has been verified when it has not. Installation
and live web research have explicit external prerequisites; normal quick checks
must not start model workflows or require a 30-minute agent loop.

Keep each page's document-title H1 above its table of contents. Put topical H1
sections below the contents, with H2 headings nested beneath the relevant H1 and
listed once in document order. Use relative links and preserve useful published
anchors. Keep generated documentation assets in their source-generation workflow.
