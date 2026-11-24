import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MemoryFixture } from '../runtime/src/evals/session-memory-fixtures.js';
import type { MemoryMessage } from '../runtime/src/session-memory/text.js';

export const editBase = '53a615798b8ca04a63c70e2d3b9503b01a97ddf3';

type TranscriptLine = readonly [author: MemoryMessage['author'], text: string];
type EditCase = {
  id: string;
  file: string;
  sibling: string;
  assignment: string;
  manualHandoff: string;
  conversation: readonly TranscriptLine[];
  focus: string;
  grade(workspace: string): Promise<Record<string, boolean>>;
};

const parallelWork: readonly (readonly TranscriptLine[])[] = [
  [
    [
      'user',
      'Separate task NAV-31. Prepare a navigation inventory for the workspace panel and record only confirmed differences between the running interface and the guide. The setup and remediation pass can wait until that list is reviewed.',
    ],
    [
      'agent',
      'The panel reads the active Project before listing sessions. The empty workspace view appears while the preferences request is outstanding, and the switcher remains available while a new workspace is loading. I saw the old label Open Working Folder in three examples and the running panel uses Open Workspace. The guide should distinguish opening an existing Project and adding a new directory.',
    ],
    ['tool', 'Workspace search succeeded with 17 matches.'],
    [
      'agent',
      'docs/How-To-User-Guides.md links to the panel under the workspace activation chapter. The reference index points to the same chapter using a different anchor. The screenshot caption is visible at a narrow width but the second line uses the old label. I plan to keep the anchor and rewrite the caption when the copy pass is approved.',
    ],
  ],
  [
    [
      'agent',
      'The retry banner and repeated loading indicator share a component, but they use separate conditions. The banner persists until there is a fresh successful snapshot, whereas the loading indicator stops as soon as the request completes. The previous screenshot showed both only because the retry was already in flight. We can verify the states independently by stopping the fixture before and after the retry starts.',
    ],
    ['tool', 'Shell command completed with exit code 0.'],
    [
      'agent',
      'The explorer results on the default-minimal workspace show that the messages are plain report strings in the provider records. The list of notification types is unnecessary for the next edit. The relevant caller formats the current state after the workspace view has loaded. We should keep the provider recovery status wording readable in narrow panes.',
    ],
    [
      'agent',
      'A reviewer noted that the status label must read Partial while one service is still starting. The documentation draft says Ready when the first service answers. This is a documentation mismatch only. The current decision is to document the existing reporting path and defer any UI behavior change.',
    ],
  ],
  [
    [
      'user',
      'For NAV-31, keep the terminology used by the install guide. If a fixture shows the status going through Starting and Partial, report the transition in the handoff. Keep the live runtime settings out of the examples.',
    ],
    [
      'agent',
      'I checked a second setup through the package environment. It reaches Starting, then Partial while the service probe is unresolved, then Ready. The third state did not appear in the portable fixture because its HTTP endpoint was stubbed, so the mock and native results need separate notes. The demo wait loop watches the visible label after reconnection.',
    ],
    ['tool', 'File write completed for "docs/Development.md".'],
    [
      'agent',
      'The contributor overview now points to the environment guide. It still needs a link check from the section on state directories. A status table there uses historical snapshot labels that were removed during the contribution rules cleanup. We should update the table on the next documentation pass, after the install chapter references the maintained command.',
    ],
  ],
  [
    [
      'agent',
      'The local fixture check generated twelve temporary session records and cleaned them after the test. I verified the file count before saving the package report. The recovery view used an example base directory named workspace-a, and the screenshots are still staged beside the outline. No user history was used in that run.',
    ],
    ['tool', 'Shell command completed with exit code 0.'],
    [
      'agent',
      'I compared the two screenshot captions with visible program labels. One contains an older shortcut and the keyboard menu now lists the action under Tools. The accessibility review requests a text instruction for opening the menu at the end of the chapter. The captions should use the same verb as the walkthrough but retain the environment name in each image alt text.',
    ],
    [
      'agent',
      'The previous developer run had an unresolved question about local review status labels. This separate pass does not need to settle that contract. The new examples use resolved and unresolved display text only where it exists in the current list view.',
    ],
  ],
  [
    [
      'agent',
      'The working conventions distinguish local verification from hosted job status. Add a link to the release section in the helper text and use the workflow name from the source. In the existing table, pull-request jobs and manually triggered jobs have similar names, so both should be qualified in the text if they appear together.',
    ],
    ['tool', 'Workspace search succeeded with 9 matches.'],
    [
      'agent',
      'The native smoke test serializes the workspace selection before calling the server. That order was stable across the prepared setup and is not part of the copy correction. The assistant critique duplicated two paragraphs because it counted the description and the screenshot alt text as separate pages. The final checklist labels each rule once.',
    ],
    [
      'agent',
      'We skipped the copy test for the prebuilt package because this documentation fixture does not stage fresh binaries. The markdown validator reached the closing summary and all named links resolved within the draft. I recorded the completed checks and moved the screenshot notes into the same review thread.',
    ],
  ],
  [
    [
      'user',
      'Please keep the unrelated documentation work in a separate patch. It may reuse the existing component names, section structure, and fast verification commands. Avoid any changes to startup or provider behavior during the copy pass.',
    ],
    [
      'agent',
      'The reference table currently lists two environment screen labels that look like status codes. The runtime stores their canonical names and converts capitalization for the panel. The guide can use the visible labels as examples while retaining the canonical field names in the reference table. This also preserves existing translation commands.',
    ],
    ['tool', 'Shell command completed with exit code 0.'],
    [
      'agent',
      'The independent readback confirmed the jump from the list of workspace commands to the setup section. The help link correctly opens the copy guide and the heading stays in view when the menu is narrow. The older example with a generated command output still belongs under recovery. I left that example alone for the more specific follow-up.',
    ],
  ],
];

export function editTranscript(fixture: EditCase): MemoryFixture {
  const beforeCorrection = fixture.conversation.slice(0, -1);
  const transcript = beforeCorrection.flatMap((line, index) => [
    line,
    ...(parallelWork[index] ?? []),
  ]);
  const duplicateReports = parallelWork.flatMap((turn) =>
    turn.filter(([author]) => author !== 'user'),
  );
  transcript.push(...duplicateReports, fixture.conversation.at(-1)!);
  const messages = transcript.map(([author, text], index): MemoryMessage => ({
    seq: index + 1,
    author,
    text,
  }));
  const turns = Array.from({ length: Math.ceil((messages.length - 1) / 3) }, (_, index) =>
    messages.slice(index * 3, Math.min(index * 3 + 3, messages.length - 1)),
  );
  const evidence = messages.find(({ text }) => text === fixture.conversation[1]?.[1])!;
  return {
    id: fixture.id,
    turns: [...turns, [messages.at(-1)!]],
    flushAfter: [evidence.seq],
    originalSources: [],
    correctionSources: [messages.length],
    focus: fixture.focus,
    task: { prompt: fixture.assignment, expected: {} },
    facts: [
      {
        label: 'implementation location',
        source: evidence.seq,
        expected: new RegExp(fixture.file.replaceAll('.', '\\.')),
        identifiers: [fixture.file],
        critical: true,
        kind: 'reference',
      },
    ],
  };
}

const traceFile = 'runtime/src/evals/attribution.ts';
const workspaceFile = 'runtime/src/integrations/workspace-preparation.ts';

export const sessionMemoryEditCases: readonly EditCase[] = [
  {
    id: 'trace-pairing',
    file: traceFile,
    sibling: 'runtime/src/evals/diagnostics.ts',
    assignment:
      'Implement the approved trace-pairing correction in runtime/src/evals/attribution.ts. Change that file only.',
    manualHandoff:
      'Keep interval union, category independence and the existing output fields. Correct duplicate begin events and out-of-order ends for paired spans.',
    focus: 'trace pairing duplicate begin stale end correlationId attribution.ts',
    conversation: [
      [
        'user',
        'Trace pairing follow-up EVAL-63. Preserve interval union within each category and keep categories independent. The dashboard expects milliseconds and the existing category fields. We still need to decide which duplicate begin event is authoritative.',
      ],
      [
        'agent',
        'Trace pairing is in runtime/src/evals/attribution.ts in attributeEvaluationTrace. The map key includes pid, correlationId, name and tid. I reproduced a duplicate begin replacing the first timestamp before closing the span. An out-of-order end also deletes the start even when its timestamp predates it.',
      ],
      ['tool', 'Shell command completed with exit code 1.'],
      [
        'agent',
        'I confirmed a normal complete interval still merges with a paired span of the same category. Model and wait categories overlap legitimately. The fixture named TRACE_OLD_END demonstrates that the stale end is possible after trace buffers are combined. We should keep the paired span active for the next eligible end.',
      ],
      [
        'user',
        'Initial thought for EVAL-63. Prefer the latest begin so the pair uses the shortest duration. I want to confirm with the trace producer before committing to it.',
      ],
      [
        'agent',
        'Trace producer investigation found a duplicate begin replays the original event after buffering restarts. The earlier timestamp represents the real opening time. Counting both would inflate elapsed time, and replacing it would under-report. There is no implied change to standalone duration records.',
      ],
      [
        'user',
        'Final EVAL-63 trace pairing decision. Keep the first chronological begin for a key when duplicate begin events arrive in timestamp order. If an end predates the open span, ignore that stale end and keep the start open. A valid end closes it, so a subsequent begin for the same key creates a new span. Keep the existing grouping and complete-event behavior.',
      ],
    ],
    async grade(workspace) {
      const { attributeEvaluationTrace } = (await import(
        pathToFileURL(path.join(workspace, traceFile)).href
      )) as typeof import('../runtime/src/evals/attribution.js');
      const phases = (events: [string, number][]) =>
        events.map(([ph, ts]) => ({ name: 'model.trace', ph, ts, pid: 1, tid: 1 }));
      return {
        duplicateBegin:
          attributeEvaluationTrace(
            phases([
              ['B', 1000],
              ['B', 2000],
              ['E', 5000],
            ]),
          ).model === 4,
        staleEnd:
          attributeEvaluationTrace(
            phases([
              ['B', 3000],
              ['E', 1000],
              ['E', 5000],
            ]),
          ).model === 2,
        reusablePair:
          attributeEvaluationTrace(
            phases([
              ['B', 1000],
              ['E', 3000],
              ['B', 4000],
              ['E', 5000],
            ]),
          ).model === 3,
        overlap:
          attributeEvaluationTrace([
            ...phases([
              ['B', 1000],
              ['E', 4000],
            ]),
            { name: 'model.complete', ph: 'X', ts: 3000, dur: 2000 },
            { name: 'wait', ph: 'X', ts: 4000, dur: 2000 },
          ]).model === 4,
      };
    },
  },
  {
    id: 'workspace-preparation',
    file: workspaceFile,
    sibling: 'runtime/src/integrations/shell-environment.ts',
    assignment:
      'Implement the approved workspace preparation cache correction in runtime/src/integrations/workspace-preparation.ts. Change that file only.',
    manualHandoff:
      'Avoid invalidating reusable workspace preparation on a no-op rewrite of a generated dependency. Keep invalidation for real input changes.',
    focus:
      'workspace preparation cache identical dependency atomic replacement identityPaths permissions',
    conversation: [
      [
        'user',
        'Workspace preparation follow-up PREP-44. Find why an unchanged generated dependency forces a second prepare after the builder mirrors it into the workspace. We still require invalidation when dependency content changes.',
      ],
      [
        'agent',
        'The cache owner is runtime/src/integrations/workspace-preparation.ts. WorkspacePreparationCache stores a fingerprint of identityPaths and dependencies. The generated dependency writer renders to a sibling temporary file and renames it, so an atomic replacement with identical bytes changes inode identity.',
      ],
      ['tool', 'Shell command completed with exit code 1.'],
      [
        'agent',
        'A write in place with unchanged bytes already reuses the entry. PREP_REPLACE_IDENTICAL is the failing case. PREP_CONFIG_CONTENT still needs invalidation even if old and new content have the same byte length. Identity paths include generated launch configuration and currently detect replacement independently of contents.',
      ],
      [
        'user',
        'Initial PREP-44 idea was to ignore inode changes for all tracked paths. Wait until we confirm whether workspace identity records belong in that exception.',
      ],
      [
        'agent',
        'Owner review confirmed that only a regular file under dependencies is content-addressable for reuse. An identity path replacement needs a new preparation even with the same content. Permission mode still matters for regular dependency files. Directory fingerprint behavior and unsupported paths should continue to follow the existing rules.',
      ],
      [
        'user',
        'Final PREP-44 decision. For regular dependency files only, reuse across atomic replacement with the same bytes and inode-independent metadata. Preserve file mode, size, owner and group invalidation. Preserve identity path and directory checks, and keep validating file contents.',
      ],
    ],
    async grade(workspace) {
      const { WorkspacePreparationCache } = (await import(
        pathToFileURL(path.join(workspace, workspaceFile)).href
      )) as typeof import('../runtime/src/integrations/workspace-preparation.js');
      const cache = new WorkspacePreparationCache();
      const dependency = path.join(workspace, 'dependency');
      const identity = path.join(workspace, 'identity');
      const replace = async (file: string, content: string, mode = 0o600) => {
        await writeFile(file + '.next', content, { mode });
        await rename(file + '.next', file);
      };
      await replace(dependency, 'v1');
      await replace(identity, 'id');
      const get = () =>
        cache.get('fixture', () => ({
          reusable: true,
          environment: {},
          dependencies: [dependency],
          identityPaths: [identity],
        }));
      const initial = await get();
      await replace(dependency, 'v1');
      const identical = await get();
      await replace(dependency, 'v2');
      const contents = await get();
      await replace(dependency, 'v2', 0o644);
      const mode = await get();
      await replace(identity, 'id');
      const replacedIdentity = await get();
      return {
        identicalReplacement: initial === identical,
        contentChange: contents !== identical,
        modeChange: mode !== contents,
        identityReplacement: replacedIdentity !== mode,
      };
    },
  },
];
