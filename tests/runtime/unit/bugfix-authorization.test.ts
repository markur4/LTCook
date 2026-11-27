import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BugFixAuthorization,
  type BugFixAuthorizationRequest,
} from '../../../runtime/src/core/bugfix-authorization.js';
import { CoordinationStore } from '../../../runtime/src/storage/coordination.js';

const cleanups: Array<() => void> = [];
const user = { kind: 'user' } as const;
const agent = { kind: 'agent', nativeAgentId: 'ordinary-worker' } as const;
const selectedPath = 'runtime/src/repository/search.ts';
const grantInput = {
  targetBranch: 'main',
  repairKinds: ['proper-fix'],
  actions: ['source.edit', 'git.commit', 'verify'],
  allowedPaths: ['runtime/src/repository'],
  maxModelRequests: 20,
};

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ltcook-bugfix-authorization-'));
  const database = path.join(directory, 'coordination.sqlite');
  let store = new CoordinationStore(database);
  const repository = { root: directory, remote: 'https://example.invalid/main/fixture.git' };
  const session = store.createSession({ teamId: 'fixture-bughunter', workspaceRoot: directory });
  function authorization() {
    return new BugFixAuthorization(store, session.id, repository);
  }
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    repository,
    authorization,
    reopen() {
      store.close();
      store = new CoordinationStore(database);
      return authorization();
    },
    approvals: () => store.listApprovals(session.id),
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test('BugFix standing grants are user-only, explicit, and bound to action and target', () => {
  const f = fixture();
  const authorization = f.authorization();
  expect(authorization.current()).toBeUndefined();
  expect(() => authorization.grant(agent, grantInput)).toThrow(/authenticated user/);
  expect(() => authorization.grant(user, { ...grantInput, maxModelRequests: 0 })).toThrow();
  expect(() => authorization.grant(user, { ...grantInput, targetBranch: 'main..other' })).toThrow();
  const grant = authorization.grant(user, grantInput);
  const edit = {
    revision: grant.revision,
    repository: f.repository,
    targetBranch: 'main',
    repairKind: 'proper-fix',
    action: 'source.edit',
    paths: [selectedPath],
  } satisfies BugFixAuthorizationRequest;
  expect(authorization.authorize(edit)).toBe(true);
  for (const rejected of [
    { ...edit, targetBranch: 'release' },
    { ...edit, repairKind: 'workaround' },
    { ...edit, repairKind: undefined },
    { ...edit, repository: { ...f.repository, remote: 'elsewhere' } },
    { ...edit, repository: { ...f.repository, root: path.join(f.repository.root, 'other') } },
    { ...edit, action: 'git.push' },
    { ...edit, paths: [] },
    { ...edit, paths: ['runtime/src/repository-other/search.ts'] },
    { ...edit, paths: ['runtime/src/repository/../core/runtime.ts'] },
  ] satisfies BugFixAuthorizationRequest[]) {
    expect(authorization.authorize(rejected)).toBe(false);
  }
});

test('explicit prohibitions survive replacement and restart until the user clears them', () => {
  const f = fixture();
  const authorization = f.authorization();
  const initial = authorization.grant(user, grantInput);
  const prohibited = authorization.prohibit(user, { action: 'source.edit', path: selectedPath });
  const replacement = authorization.grant(user, grantInput);
  const reopened = f.reopen();
  const edit = {
    revision: replacement.revision,
    repository: f.repository,
    targetBranch: 'main',
    repairKind: 'proper-fix',
    action: 'source.edit',
    paths: [selectedPath],
  } satisfies BugFixAuthorizationRequest;
  expect(reopened.authorize(edit)).toBe(false);
  expect(() => reopened.clearProhibition(agent, prohibited.id)).toThrow(/authenticated user/);
  reopened.clearProhibition(user, prohibited.id);
  expect(reopened.authorize(edit)).toBe(true);
  expect(reopened.authorize({ ...edit, revision: initial.revision })).toBe(false);
  expect(() => reopened.revoke(agent)).toThrow(/authenticated user/);
  reopened.revoke(user);
  expect(f.reopen().authorize(edit)).toBe(false);
  expect(f.approvals()).toContainEqual(
    expect.objectContaining({
      decision: 'rejected',
      source: 'user',
      scope: {
        action: 'bugfix.standing',
        resourceId: f.repository.root,
        revision: replacement.revision,
      },
    }),
  );
});

test('even broad explicit path grants cannot mutate the authorization and verification controls', () => {
  const f = fixture();
  const authorization = f.authorization();
  const grant = authorization.grant(user, { ...grantInput, allowedPaths: ['runtime', 'tests'] });
  const edit = {
    revision: grant.revision,
    repository: f.repository,
    targetBranch: 'main',
    repairKind: 'proper-fix',
    action: 'source.edit',
    paths: [selectedPath],
  } satisfies BugFixAuthorizationRequest;
  expect(authorization.authorize(edit)).toBe(true);
  for (const forbidden of [
    'runtime/src/core/bugfix-authorization.ts',
    'runtime/src/services/bugscan-integration.ts',
    'runtime/resources/rules/core.md',
    'runtime/src/repository/AGENTS.md',
    'runtime/src/repository/.git/config',
    'runtime/package.json',
    'tests/runtime/unit/scheduler.test.ts',
  ]) {
    expect(authorization.authorize({ ...edit, paths: [forbidden] })).toBe(false);
    expect(
      authorization.authorize({ ...edit, action: 'git.commit', paths: [selectedPath, forbidden] }),
    ).toBe(false);
  }
});
