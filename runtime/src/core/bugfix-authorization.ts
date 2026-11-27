import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { CoordinationStore } from '../storage/coordination.js';
import type { RuntimeActor } from '../workflow-api/index.js';

const actions = z.enum([
  'worktree.create',
  'source.edit',
  'verify',
  'git.commit',
  'git.push',
  'pr.open',
  'pr.merge',
  'issue.write',
  'worktree.cleanup',
]);
const repairKinds = z.enum(['proper-fix', 'workaround']);

export type BugFixAction = z.infer<typeof actions>;
export type BugFixRepairKind = z.infer<typeof repairKinds>;
export interface BugFixRepository {
  root: string;
  remote: string;
}

const branch = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => {
    return (
      /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value) &&
      value !== 'HEAD' &&
      !value.startsWith('refs/') &&
      !value.includes('..') &&
      !value.endsWith('.') &&
      value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'))
    );
  }, 'Use a named Git branch without ref syntax.');

const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    return (
      !/[\\:\u0000-\u001f\u007f]/u.test(value) &&
      value.split('/').every((part) => part && part !== '.' && part !== '..')
    );
  }, 'Use a repository-relative path without traversal.');

export const bugFixGrantSchema = z.strictObject({
  targetBranch: branch,
  repairKinds: z.array(repairKinds).min(1).max(2),
  allowedPaths: z.array(relativePath).min(1).max(128),
  actions: z.array(actions).min(1).max(actions.options.length),
  maxModelRequests: z.number().int().min(1).max(1024),
});

export const bugFixProhibitionSchema = z.strictObject({
  targetBranch: branch.optional(),
  repairKind: repairKinds.optional(),
  action: actions.optional(),
  path: relativePath.optional(),
});

export interface BugFixGrant extends z.infer<typeof bugFixGrantSchema> {
  repository: BugFixRepository;
  revision: string;
}

export interface BugFixProhibition extends z.infer<typeof bugFixProhibitionSchema> {
  id: string;
}

export interface BugFixAuthorizationRequest {
  revision: string;
  repository: BugFixRepository;
  targetBranch: string;
  repairKind?: BugFixRepairKind;
  action: BugFixAction;
  paths?: readonly string[];
}

type Store = Pick<CoordinationStore, 'records' | 'putRecord' | 'createApproval' | 'listApprovals'>;
interface Policy {
  id: 'policy';
  standing?: { grant: BugFixGrant; approvalId?: string };
  prohibitions: BugFixProhibition[];
}

const policyKind = 'bugfix-authorization';
const pathActions = new Set<BugFixAction>([
  'source.edit',
  'git.commit',
  'git.push',
  'pr.open',
  'pr.merge',
]);
const protectedPaths = [
  'runtime/resources',
  'runtime/src/core',
  'runtime/src/diagnostics',
  'runtime/src/evals',
  'runtime/src/guidance-api',
  'runtime/src/integrations',
  'runtime/src/main.ts',
  'runtime/src/models',
  'runtime/src/paseo-plugin',
  'runtime/src/services/bugfix',
  'runtime/src/services/bugscan',
  'runtime/src/services/bughunter-team.ts',
  'runtime/src/storage',
  'runtime/src/team-api',
  'runtime/src/tools',
  'runtime/src/workflow-api',
  'src/ltcook/config',
  'src/ltcook/launch.py',
  'src/ltcook/_runtime_client.py',
  'src/ltcook_dev',
  'src/ltcook_distr',
  'teams',
  'tests',
  'evals',
  'docs/Development.md',
  'docs/Explanations.md',
  'CONTRIBUTING.md',
].map((entry) => entry.toLowerCase());

function within(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

/** Applies to every changed path. Bind the actual worktree and require tracked paths at the sink. */
export function isBugFixEditablePath(candidate: string): boolean {
  if (!relativePath.safeParse(candidate).success) return false;
  const normalized = candidate.toLowerCase();
  if (!normalized.includes('/') || protectedPaths.some((entry) => within(entry, normalized)))
    return false;
  const parts = normalized.split('/');
  if (/^bug(?:fix|scan|hunter)/.test(parts.at(-1) ?? '')) return false;
  return parts.every(
    (name) =>
      !name.startsWith('.') &&
      !/^(?:agents\.md|claude\.md|justfile|package(?:-lock)?\.json|bun\.lockb?|pyproject\.toml|uv\.lock|tsconfig[\w.-]*\.json)$/.test(
        name,
      ),
  );
}

/** Bind approval evidence to the configured repository and recheck it at each action. */
export class BugFixAuthorization {
  private readonly repository: BugFixRepository;

  constructor(
    private readonly store: Store,
    private readonly sessionId: string,
    repository: BugFixRepository,
  ) {
    if (
      !path.isAbsolute(repository.root) ||
      path.normalize(repository.root) !== repository.root ||
      !repository.remote ||
      /[\u0000-\u001f\u007f]/u.test(repository.remote)
    )
      throw new Error('BugFix requires a canonical checkout and verified remote identity.');
    this.repository = { ...repository };
  }

  grant(actor: RuntimeActor, input: unknown): BugFixGrant {
    this.requireUser(actor);
    const grant: BugFixGrant = {
      ...bugFixGrantSchema.parse(input),
      repository: this.repository,
      revision: randomUUID(),
    };
    const policy = this.policy();
    this.save({ ...policy, standing: { grant } });
    const approval = this.record('bugfix.standing', grant.revision, 'approved');
    this.save({ ...policy, standing: { grant, approvalId: approval.id } });
    return structuredClone(grant);
  }

  revoke(actor: RuntimeActor): void {
    this.requireUser(actor);
    const policy = this.policy();
    if (!policy.standing) return;
    this.save({ id: 'policy', prohibitions: policy.prohibitions });
    this.record('bugfix.standing', policy.standing.grant.revision, 'rejected');
  }

  prohibit(actor: RuntimeActor, input: unknown): BugFixProhibition {
    this.requireUser(actor);
    const prohibition = { ...bugFixProhibitionSchema.parse(input), id: randomUUID() };
    const policy = this.policy();
    this.save({ ...policy, prohibitions: [...policy.prohibitions, prohibition] });
    this.record('bugfix.prohibition', prohibition.id, 'rejected');
    return prohibition;
  }

  clearProhibition(actor: RuntimeActor, id: string): void {
    this.requireUser(actor);
    const policy = this.policy();
    if (!policy.prohibitions.some((prohibition) => prohibition.id === id)) return;
    this.record('bugfix.prohibition', id, 'approved');
    this.save({ ...policy, prohibitions: policy.prohibitions.filter((entry) => entry.id !== id) });
  }

  listProhibitions(): BugFixProhibition[] {
    return structuredClone(this.policy().prohibitions);
  }

  current(): BugFixGrant | undefined {
    const standing = this.policy().standing;
    if (!standing?.approvalId || !this.matchesRepository(standing.grant.repository)) return;
    const approvals = this.store
      .listApprovals(this.sessionId)
      .filter(
        (approval) =>
          approval.source === 'user' &&
          approval.scope.action === 'bugfix.standing' &&
          approval.scope.resourceId === this.repository.root &&
          approval.scope.revision === standing.grant.revision,
      );
    if (approvals.some((approval) => approval.decision === 'rejected')) return;
    if (
      approvals.some(
        (approval) => approval.id === standing.approvalId && approval.decision === 'approved',
      )
    )
      return structuredClone(standing.grant);
  }

  authorize(request: BugFixAuthorizationRequest): boolean {
    const grant = this.current();
    if (
      !grant ||
      !this.matchesRepository(request.repository) ||
      request.revision !== grant.revision ||
      request.targetBranch !== grant.targetBranch ||
      !grant.actions.includes(request.action) ||
      (request.action === 'source.edit' && !request.repairKind) ||
      (request.repairKind && !grant.repairKinds.includes(request.repairKind))
    )
      return false;
    const paths = request.paths ?? [];
    if (
      pathActions.has(request.action) &&
      (!paths.length ||
        paths.some(
          (candidate) =>
            !isBugFixEditablePath(candidate) ||
            !grant.allowedPaths.some((prefix) => within(prefix, candidate)),
        ))
    )
      return false;
    return !this.policy().prohibitions.some(
      ({ targetBranch, action, repairKind, path }) =>
        (!targetBranch || targetBranch === request.targetBranch) &&
        (!action || action === request.action) &&
        (!repairKind || !request.repairKind || repairKind === request.repairKind) &&
        (!path || !paths.length || paths.some((candidate) => within(path, candidate))),
    );
  }

  private matchesRepository(repository: BugFixRepository): boolean {
    return repository.root === this.repository.root && repository.remote === this.repository.remote;
  }

  private requireUser(actor: RuntimeActor): void {
    if (actor.kind !== 'user')
      throw new Error('Only the authenticated user may change BugFix authorization.');
  }

  private policy(): Policy {
    return (
      this.store
        .records<Policy>(this.sessionId, policyKind)
        .find((record) => record.id === 'policy') ?? { id: 'policy', prohibitions: [] }
    );
  }

  private save(policy: Policy): void {
    this.store.putRecord(this.sessionId, policyKind, policy);
  }

  private record(action: string, revision: string, decision: 'approved' | 'rejected') {
    return this.store.createApproval(this.sessionId, {
      scope: { action, resourceId: this.repository.root, revision },
      decision,
    });
  }
}
