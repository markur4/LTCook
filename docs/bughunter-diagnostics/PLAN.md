# BugHunter Pass 1 — Logging and diagnostics

Improve shared runtime diagnostics and make indexing the first subsystem with
structured operation evidence and a progress deadline. The target is `main`.
The Pass uses one shared branch, worktree, draft pull request, and combined review.
Extend the existing Traditional Test suite. BugScan, automatic repair, and
model-backed qualification belong to later Passes.

## Coverage assessment

| Area | Available evidence | Coverage and gaps |
| --- | --- | --- |
| Runtime and coordination | [Telemetry](../../runtime/src/diagnostics/telemetry.ts) JSONL, Perfetto, and authenticated [runtime status](../../runtime/src/integrations/runtime-api.ts). | Structured operation records now carry identity, severity, outcome, and sanitized context. Several existing coordination and HTTP error paths still expose generic activity or a response code. |
| Services and repository tools | [Index scheduler](../../runtime/src/services/repository-index.ts), [ColGREP generation checks](../../runtime/src/repository/providers/colgrep.ts), and [workspace Service status](../../runtime/src/integrations/paseo-workspace-services.ts). | Scheduled indexing distinguishes stale-but-usable data, a stalled refresh, retry, blocked access or writer contention, cancellation, and failure. A fully blocked runtime event loop cannot emit an in-process deadline. Other tools still have caller-specific diagnostics. |
| Pi and Paseo | [Pi provider stderr](../../runtime/src/integrations/pi-rpc.ts), [Pi indexing and evaluation hooks](../../runtime/src/integrations/pi-extension.ts), and [Paseo owner startup evidence](../../runtime/src/integrations/paseo.ts). | The managed and AppRC-launched standalone indexing paths can record structured evidence. Provider and daemon failures still have separate owner logs. |
| GUI and frontend | [Service screen status](../../runtime/src/paseo-plugin/client/components/WorkspaceServices.tsx), [evaluation diagnostics](../../runtime/src/paseo-plugin/client/screens/Diagnostics.tsx), and the [browser acceptance fixture](../../tests/runtime/system/paseo-gui-acceptance.ts). | The existing on-demand browser fixture captures screenshots, snapshots, console, and page errors. No continuous collection is required. Frontend RPC failures may live only in the affected view. |
| External dependencies | [Compose status and logs](../../runtime/src/services/controller.ts) and [typed inference errors](../../runtime/src/services/workspace-metadata-inference.ts). | External service evidence is provider-specific. Durable outage signals are a later instrumentation opportunity. |
| Configuration and authentication | Machine-readable [Doctor](../References.md#command-reference) and [authentication status](../../src/ltcook/auth.py). | Some timeouts and local command errors collapse into invalid credentials. Record the observed outcome before attributing it to auth. |
| Build, packaging, installation, and update | [Deployment fingerprint](../../runtime/src/integrations/deployed-build.ts), [native release source commit](../../src/ltcook_dev/packaging/release_manifest.py), [backend log](../../src/ltcook/_runtime_client.py), and [update checks](../../src/ltcook/_app_update.py). | Runtime records identify verified installed bytes. Exact source mapping needs matching provenance. Launcher preparation and process-spawn errors can be read after a later start. Failures in the registered restart wrapper and builds without source provenance remain gaps. |
| Traditional Tests and Agent Evals | [CI](../../.github/workflows/ci.yml), [Agent Eval checkpoints](../../runtime/src/evals/service.ts), and [sanitized observation](../../runtime/src/evals/diagnostics.ts). | Test evidence is separate from operational failures. Later qualification exercises the selected models and checks hard failures using evaluator-owned fixtures. |

## Decisions carried into later Passes

- BugScan records an explicit decision for each architectural problem exposed
  by a diagnosis. Record the work to address immediately, the work to defer,
  and the rationale. Deferred findings stay out of automatic BugFix batches.
- A recovery claim requires successful verification of the formerly failing
  behavior on the repaired running build, in both live operation and
  qualification. Integration and installation have separate outcomes.

See the [active checklist](TODO.md) and [canonical diagnostic guidance](../Development.md#operational-diagnostics).
