import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSkillDocument } from '../../../runtime/src/paseo-plugin/server/skill-documents';
import type {
  PaseoAgent,
  PaseoAgentCommandsResult,
  PaseoAgentHandle,
  PaseoApi,
} from '@getpaseo/client';
import { expect, test } from 'bun:test';
import { observeActivity } from '../../../runtime/src/paseo-plugin/server/activity';
import {
  readTurnSkills,
  type RegisteredSkill,
} from '../../../runtime/src/paseo-plugin/server/activity-uses';
import type { ActivitySnapshot } from '../../../runtime/src/paseo-plugin/shared/activity';

type TimelineItem = Awaited<
  ReturnType<PaseoAgentHandle['timeline']['refetch']>
>['entries'][number]['item'];

const catalog = {
  commands: [
    { name: 'workflow', description: 'Project workflow', argumentHint: '', kind: 'skill' },
    { name: 'verification', description: 'Project checks', argumentHint: '', kind: 'skill' },
  ],
  error: null,
} satisfies Pick<PaseoAgentCommandsResult, 'commands' | 'error'>;

function shell(command: string, output: string, exitCode = 0, callId = command): TimelineItem {
  return {
    type: 'tool_call',
    name: 'shell',
    callId,
    status: 'completed',
    error: null,
    detail: { type: 'shell', command, output, exitCode },
  };
}

const timestamp = '2026-01-01T00:00:00.000Z';
const at = Date.parse(timestamp);
type Entry = { item: TimelineItem; turnId?: string };

function fixture(
  items: Entry[],
  commands: Pick<PaseoAgentCommandsResult, 'commands' | 'error'>,
  provider = 'codex',
) {
  const agent = {
    id: 'agent',
    provider,
    cwd: '/repo',
    title: 'Agent',
    labels: {},
    status: 'idle',
    activeTurn: null,
    pendingPermissions: [],
    updatedAt: timestamp,
  } as PaseoAgent;
  const handle = {
    cwd: agent.cwd,
    commands: async () => commands,
    refresh: async () => ({ agent }),
    timeline: {
      subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
      refetch: async (options?: Parameters<PaseoAgentHandle['timeline']['refetch']>[0]) => ({
        agent,
        entries: items
          .map((entry, index) => ({ ...entry, seqEnd: index + 1, timestamp }))
          .filter((entry) => !options?.cursor || entry.seqEnd < options.cursor.seq),
        epoch: 'epoch',
        gap: false,
        hasOlder: false,
      }),
    },
  };
  return { agent, handle };
}

async function activityFor(
  items: Entry[],
  commands: Pick<PaseoAgentCommandsResult, 'commands' | 'error'>,
  provider?: string,
  files?: RegisteredSkill[],
): Promise<ActivitySnapshot['agent']> {
  const { agent, handle } = fixture(items, commands, provider);
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
      rag: {
        worktree: null,
        provider: 'ColGREP',
        indexingEnabled: null,
        availability: 'unknown',
        activity: 'unknown',
      },
      memory: {
        device: null,
        rate: null,
        lastHandoff: null,
        summarization: 'unknown',
        lastSummaryAt: null,
        stored: null,
        pending: null,
      },
      providerSubagents: [],
    }),
    async () => files,
  );
  if (!snapshot) throw new Error('Activity did not publish a snapshot.');
  return snapshot.agent;
}

function idleCodexActivity(
  items: TimelineItem[],
  commands: Pick<PaseoAgentCommandsResult, 'commands' | 'error'>,
): Promise<ActivitySnapshot['agent']> {
  return activityFor(
    items.map((item) => ({ item, turnId: 'turn' })),
    commands,
  );
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
      shell("sed -n '50,55p' /skills/workflow/SKILL.md", header),
      shell('cat /skills/workflow/SKILL.md | head -n 20', header),
      shell('echo /skills/workflow/SKILL.md', header),
      shell('cat /skills/[a-z]*/SKILL.md', header),
      {
        type: 'user_message',
        text: '<skill name="workflow" location="/skills/workflow/SKILL.md">\nBody',
      },
    ],
    catalog,
  );
  expect(activity.skills).toEqual([]);
  expect(
    (await idleCodexActivity([], { commands: [], error: 'Catalog unreachable' })).skills,
  ).toBeNull();
});

test('repeated and parallel skill reads retain distinct canonical occurrences', async () => {
  const command = 'cat /repo/.pi/skills/workflow/SKILL.md';
  const output = '---\nname: workflow\n---\nPrivate document body';
  const files = [{ name: 'workflow', path: '/repo/.pi/skills/workflow/SKILL.md' }];
  const activity = await activityFor(
    [
      { item: shell(command, output, 0, 'reused'), turnId: 'first' },
      { item: shell(command, output, 0, 'parallel'), turnId: 'first' },
      { item: shell(command, output, 0, 'reused'), turnId: 'second' },
    ],
    catalog,
    'codex',
    files,
  );
  const occurrences = [
    { epoch: 'epoch', position: 1, kind: 'tool', id: 'reused', at, turnId: 'first' },
    { epoch: 'epoch', position: 2, kind: 'tool', id: 'parallel', at, turnId: 'first' },
    { epoch: 'epoch', position: 3, kind: 'tool', id: 'reused', at, turnId: 'second' },
  ];
  expect(activity.skills).toEqual([
    {
      name: 'workflow',
      id: 'workflow',
      description: 'Project workflow',
      loadedAt: at,
      documentAvailable: true,
      occurrences,
    },
  ]);
  expect(activity.tools?.map(({ id, target, skillId }) => ({ id, target, skillId }))).toEqual(
    occurrences.map((target) => ({ id: target.id, target, skillId: 'workflow' })),
  );
  expect(JSON.stringify({ tools: activity.tools, skills: activity.skills })).not.toContain(command);
  expect(JSON.stringify({ tools: activity.tools, skills: activity.skills })).not.toContain(output);
});

test('Pi links a skill prompt by native message ID and a read by native call ID', async () => {
  const files = [{ name: 'workflow', path: '/repo/.pi/skills/workflow/SKILL.md' }];
  const read: TimelineItem = {
    type: 'tool_call',
    name: 'read',
    callId: 'file-read',
    status: 'completed',
    error: null,
    detail: { type: 'read', filePath: '.pi/skills/workflow/SKILL.md' },
  };
  const activity = await activityFor(
    [
      {
        item: {
          type: 'user_message',
          text: '<skill name="workflow" location="/repo/.pi/skills/workflow/SKILL.md">\nBody\n</skill>',
          messageId: 'message-id',
          clientMessageId: 'client-id',
        },
        turnId: 'turn',
      },
      { item: read, turnId: 'turn' },
    ],
    { commands: [], error: 'Catalog unreachable' },
    'pi',
    files,
  );
  expect(activity.skills?.[0]?.occurrences).toEqual([
    { epoch: 'epoch', position: 1, kind: 'message', id: 'message-id', at, turnId: 'turn' },
    { epoch: 'epoch', position: 2, kind: 'tool', id: 'file-read', at, turnId: 'turn' },
  ]);
  expect(activity.tools?.[0]?.skillId).toBe('workflow');
});

test('turn skill lookup reads canonical history for the selected turn and epoch', async () => {
  const { agent, handle } = fixture(
    [
      {
        item: shell('cat /skills/workflow/SKILL.md', '---\nname: workflow\n---\n', 0, 'first'),
        turnId: 'turn-1',
      },
      {
        item: shell(
          'cat /skills/verification/SKILL.md',
          '---\nname: verification\n---\n',
          0,
          'second',
        ),
        turnId: 'turn-2',
      },
    ],
    catalog,
  );
  const timeline = {
    ...handle.timeline,
    subscribe: () => {
      throw new Error('Turn badges must not subscribe to Activity.');
    },
  };
  const ref = { ...handle, timeline } as unknown as PaseoAgentHandle;
  const signal = new AbortController().signal;
  const files = async () => undefined;
  const skills = await readTurnSkills(
    agent,
    ref,
    { epoch: 'epoch', turnId: 'turn-1', position: 1 },
    signal,
    files,
  );
  expect(skills).toEqual([
    {
      id: 'workflow',
      name: 'workflow',
      description: 'Project workflow',
      loadedAt: at,
      documentAvailable: false,
      occurrences: [
        { epoch: 'epoch', position: 1, kind: 'tool', id: 'first', at, turnId: 'turn-1' },
      ],
    },
  ]);
  const tail = await ref.timeline.refetch();
  const cached = {
    ...ref,
    timeline: {
      ...ref.timeline,
      refetch: () => {
        throw new Error('A known complete tail should be reused.');
      },
    },
  };
  expect(
    await readTurnSkills(agent, cached, { epoch: 'epoch', turnId: 'turn-1', tail }, signal, files),
  ).toEqual(skills);
  expect(
    await readTurnSkills(agent, ref, { epoch: 'stale', turnId: 'turn-1' }, signal, files),
  ).toEqual([]);
  expect(
    await readTurnSkills(
      agent,
      ref,
      { epoch: 'epoch', turnId: 'turn-2', position: 1 },
      signal,
      files,
    ),
  ).toEqual([]);
});

test('reads only the registered skill in allowed roots and bounds the inline preview', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'ltcook-skill-document-'));
  try {
    const cwd = path.join(temporary, 'workspace');
    const file = path.join(cwd, 'skills', 'fixture', 'SKILL.md');
    const outside = path.join(temporary, 'outside', 'SKILL.md');
    await Promise.all([
      mkdir(path.dirname(file), { recursive: true }),
      mkdir(path.dirname(outside), { recursive: true }),
    ]);
    const body = 'Readable instructions. '.repeat(100).trim();
    const markdown = `---\nname: fixture\n---\n${body}\n`;
    await Promise.all([writeFile(file, markdown), writeFile(outside, markdown)]);
    const handle = {
      refresh: async () => ({ agent: { cwd, archivedAt: null } }),
    } as unknown as PaseoAgentHandle;

    const registered = async () => [{ name: 'fixture', path: file }];
    expect(
      await readSkillDocument(handle, { skillId: 'fixture', view: 'full' }, registered),
    ).toEqual({ name: 'fixture', markdown: body });
    const preview = await readSkillDocument(
      handle,
      { skillId: 'fixture', view: 'preview' },
      registered,
    );
    expect(preview.markdown.endsWith('…')).toBe(true);
    expect(preview.markdown.length).toBeLessThan(body.length);
    await expect(
      readSkillDocument(handle, { skillId: 'other', view: 'full' }, registered),
    ).rejects.toThrow('unavailable');
    await expect(
      readSkillDocument(handle, { skillId: 'fixture', view: 'full' }, async () => [
        { name: 'fixture', path: outside },
      ]),
    ).rejects.toThrow('unavailable');

    if (process.platform !== 'win32') {
      await rm(file);
      await symlink(outside, file);
      await expect(
        readSkillDocument(handle, { skillId: 'fixture', view: 'full' }, registered),
      ).rejects.toThrow('unavailable');
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
