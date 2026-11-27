import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import { bugHunterTeamId } from '../../../runtime/src/services/bughunter-team.js';
import type { CreateAgentOptions } from '../../../runtime/src/workflow-api/index.js';
import { FakeAgents } from './runtime-fixtures.js';

class BugScanAgents extends FakeAgents {
  options?: CreateAgentOptions;

  override async create(options: CreateAgentOptions) {
    this.options = options;
    return super.create(options);
  }
}

test('dispatches a hidden read-only investigation and persists its sanitized result', async () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'ltcook-bugscan-team-')));
  const repositoryRoot = path.join(directory, 'repository');
  const workspaceRoot = path.join(directory, 'snapshot');
  mkdirSync(repositoryRoot);
  mkdirSync(workspaceRoot);
  const archived = path.join(workspaceRoot, 'source.ts');
  const tracked = 'export const stable = true;\n';
  writeFileSync(path.join(repositoryRoot, 'source.ts'), tracked);
  writeFileSync(archived, tracked);
  const git = (args: string[]) =>
    execFileSync('git', ['-C', repositoryRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  git(['init']);
  git(['add', '--', 'source.ts']);
  git([
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'user.name=Fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Fixture',
  ]);
  const sourceRevision = git(['rev-parse', 'HEAD']);
  const agents = new BugScanAgents();
  const databasePath = path.join(directory, 'coordination.sqlite');
  let runtime = createRuntime({ databasePath, agents });
  try {
    const records = runtime.bugScanRecords<{ step: string }>(repositoryRoot);
    records.save({ step: 'investigating' });
    const signal = AbortSignal.timeout(4000);
    const request = {
      workspaceRoot,
      sourceRevision,
      sourceRepositoryRoot: repositoryRoot,
      role: 'coordinator' as const,
      huntId: 'hunt-1',
      requestId: 'hunt-1:coordinator',
      brief: 'Investigate the fixture.',
      evidence: { apiKey: 'fixture-private-key', message: 'Untrusted diagnostic text' },
      signal,
    };
    const result = runtime.investigateBugScan(request);
    await agents.sendStarted.wait();
    const { sessionId, member } = agents.options!;
    const assignment = runtime.snapshot(sessionId).assignments[0]!;
    const actor = { kind: 'agent' as const, nativeAgentId: assignment.nativeAgentId };
    expect(
      runtime.bugHunterConversations(repositoryRoot, [{ id: 'hunt-1' }, { id: 'different-hunt' }]),
    ).toEqual(
      new Map([
        ['hunt-1', [{ id: actor.nativeAgentId, role: 'BugHunter Coordinator', stage: 'scan' }]],
        ['different-hunt', []],
      ]),
    );
    expect(runtime.bugHunterConversations(workspaceRoot, [{ id: 'hunt-1' }]).get('hunt-1')).toEqual(
      [],
    );

    expect(member).toMatchObject({ modelAlias: 'medium', thinking: 'high', readOnly: true });
    expect(runtime.teamCatalog().some((entry) => entry.teamId === bugHunterTeamId)).toBe(false);
    expect(runtime.listSessions(workspaceRoot)).toEqual([]);
    await expect(
      runtime.openSession({ workspaceRoot, teamSelection: bugHunterTeamId }),
    ).rejects.toThrow();
    expect(agents.sends[0]!.message).not.toContain('fixture-private-key');
    expect(
      runtime.authorizeTool(sessionId, assignment.nativeAgentId, 'read', { path: archived })
        .allowed,
    ).toBe(true);
    expect(
      runtime.authorizeTool(sessionId, assignment.nativeAgentId, 'read', {
        path: path.join(repositoryRoot, 'source.ts'),
      }).allowed,
    ).toBe(false);
    expect(runtime.authorizeTool(sessionId, assignment.nativeAgentId, 'bash', {}).allowed).toBe(
      false,
    );
    writeFileSync(archived, 'unverified mutation');
    expect(
      runtime.authorizeTool(sessionId, assignment.nativeAgentId, 'read', { path: archived })
        .allowed,
    ).toBe(false);
    await expect(
      runtime.execute(sessionId, actor, {
        type: 'task.create',
        title: 'Unauthorized',
        description: 'Untrusted',
        acceptance: 'Denied',
      }),
    ).rejects.toThrow(/internal BugHunter Team/);
    await runtime.execute(sessionId, actor, {
      type: 'report.create',
      assignmentId: assignment.id,
      summary: 'Diagnosis',
      evidence: '{"apiKey":"model-private-key","finding":"supported"}',
      outcome: 'success',
    });
    expect(await result).toMatchObject({
      summary: 'Diagnosis',
      evidence: '{"apiKey":"<redacted>","finding":"supported"}',
    });
    expect(runtime.snapshot(sessionId).passes).toEqual([]);
    expect(agents.closes).toBe(1);
    await runtime.close();
    runtime = createRuntime({ databasePath, agents });
    expect(runtime.bugScanRecords<{ step: string }>(repositoryRoot).load()).toEqual({
      step: 'investigating',
    });
    expect(
      await runtime.investigateBugScan({
        ...request,
        workspaceRoot: path.join(directory, 'recreated-snapshot'),
      }),
    ).toMatchObject({ summary: 'Diagnosis' });
    expect(agents.sends).toHaveLength(1);
    expect(
      runtime.bugHunterConversations(repositoryRoot, [{ id: 'hunt-1' }]).get('hunt-1'),
    ).toMatchObject([{ id: actor.nativeAgentId, stage: 'scan' }]);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('closes a cancelled investigation and never replays its handoff', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ltcook-bugscan-team-'));
  const agents = new BugScanAgents();
  const runtime = createRuntime({
    databasePath: path.join(directory, 'coordination.sqlite'),
    agents,
  });
  const stop = new AbortController();
  const request = {
    workspaceRoot: directory,
    role: 'investigator' as const,
    workerSlot: 0 as const,
    requestId: 'hunt-2:investigator',
    brief: 'Investigate the fixture.',
    evidence: {},
    signal: stop.signal,
  };
  try {
    const result = runtime.investigateBugScan(request);
    await agents.sendStarted.wait();
    stop.abort(new Error('Investigation budget exhausted'));
    await expect(result).rejects.toThrow('Investigation budget exhausted');
    expect(agents.closes).toBe(1);
    await expect(
      runtime.investigateBugScan({
        ...request,
        signal: AbortSignal.timeout(4000),
      }),
    ).rejects.toThrow('cannot be automatically replayed');
    expect(agents.sends).toHaveLength(1);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
