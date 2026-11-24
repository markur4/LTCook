import type { PaseoAgentCommandsResult, PaseoAgentHandle, PaseoApi } from '@getpaseo/client';
import { expect, test } from 'bun:test';
import { observeActivity } from '../../../runtime/src/paseo-plugin/server/activity';
import type { ActivitySnapshot } from '../../../runtime/src/paseo-plugin/shared/activity';

type TimelineItem = Awaited<
  ReturnType<PaseoAgentHandle['timeline']['refetch']>
>['entries'][number]['item'];

const catalog = {
  commands: [
    { name: 'workflow', description: 'Project workflow', kind: 'skill' },
    { name: 'verification', description: 'Project checks', kind: 'skill' },
  ],
  error: null,
} satisfies Pick<PaseoAgentCommandsResult, 'commands' | 'error'>;

function shell(command: string, output: string, exitCode = 0): TimelineItem {
  return {
    type: 'tool_call',
    name: 'shell',
    callId: command,
    status: 'completed',
    detail: { type: 'shell', command, output, exitCode },
  };
}

async function idleCodexActivity(
  items: TimelineItem[],
  commands: Pick<PaseoAgentCommandsResult, 'commands' | 'error'>,
): Promise<ActivitySnapshot['agent']> {
  const agent = {
    id: 'agent',
    provider: 'codex',
    cwd: '/repo',
    title: 'Codex',
    labels: {},
    status: 'idle',
    activeTurn: null,
    pendingPermissions: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const handle = {
    commands: async () => commands,
    refresh: async () => ({ agent }),
    timeline: {
      subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
      refetch: async () => ({
        agent,
        entries: items.map((item, index) => ({
          item,
          seqEnd: index + 1,
          timestamp: agent.updatedAt,
        })),
        epoch: 'epoch',
        gap: false,
        hasOlder: false,
      }),
    },
  };
  const paseo = {
    agents: {
      ref: () => handle,
      list: async () => ({ entries: [] }),
    },
  } as unknown as PaseoApi;
  const controller = new AbortController();
  let snapshot: ActivitySnapshot | undefined;
  await observeActivity(
    paseo,
    agent.id,
    controller.signal,
    async (value) => {
      snapshot = value;
      controller.abort();
    },
    async () => ({
      rag: { worktree: null, provider: 'ColGREP', availability: 'unknown', activity: 'unknown' },
      memory: {
        cpuOnly: null,
        lastHandoff: null,
        summarization: 'unknown',
        lastSummaryAt: null,
        stored: null,
        pending: null,
      },
      providerSubagents: [],
    }),
    async () => undefined,
  );
  if (!snapshot) throw new Error('Activity did not publish a snapshot.');
  return snapshot.agent;
}

test('idle Codex Activity shows successful reads of registered skills', async () => {
  const header = (name: string) =>
    `---\nname: ${name}\ndescription: Project instructions\n---\nBody`;
  const activity = await idleCodexActivity(
    [
      shell('cat /skills/workflow/SKILL.md', header('workflow')),
      shell("sed -n '1,160p' '/my skills/verification/SKILL.md'", header('"verification"')),
      shell('head -n 20 /skills/unlisted/SKILL.md', header('unlisted')),
    ],
    catalog,
  );
  expect(activity.skills?.map(({ name, description }) => ({ name, description }))).toEqual([
    { name: 'workflow', description: 'Project workflow' },
    { name: 'verification', description: 'Project checks' },
  ]);
});

test('idle Codex Activity distinguishes no observed loads from an unavailable catalog', async () => {
  const header = '---\nname: workflow\n---\n';
  const activity = await idleCodexActivity(
    [
      shell('cat /skills/workflow/README.md', header),
      shell('cat /skills/workflow/SKILL.md', header, 1),
      shell('cat /skills/workflow/SKILL.md | head -n 20', header),
      shell('echo /skills/workflow/SKILL.md', header),
    ],
    catalog,
  );
  expect(activity.skills).toEqual([]);
  expect(
    (await idleCodexActivity([], { commands: [], error: 'Catalog unreachable' })).skills,
  ).toBeNull();
});
