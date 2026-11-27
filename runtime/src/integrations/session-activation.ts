import { statSync } from 'node:fs';
import { canonicalWorkspace } from '../core/workspace.js';
import { openRepositoryWorkspace, repositoryWorkspaceIdentity } from '../repository/workspace.js';
import type { RepositoryIndexService } from '../services/repository-index.js';
import type { RuntimeController, SessionSnapshot } from '../workflow-api/index.js';
import { captureShellEnvironment } from './shell-environment.js';

interface WorkspaceSessionRequest {
  workspaceRoot: string;
  sessionId: string;
  teamSelection: string;
  leaderAgentId?: string;
}

type ActivateWorkspace = (
  request: WorkspaceSessionRequest & { shellEnvironment: Record<string, string> },
) => Promise<SessionSnapshot>;

type ActivationResult = { snapshot: SessionSnapshot } | { conflict: string };
type IndexAuthorization = { identity: string; stopIndexing?: () => void };

function indexWorkspaceIdentity(root: string): string | undefined {
  try {
    const info = statSync(root, { bigint: true });
    if (info.isDirectory()) return repositoryWorkspaceIdentity(info);
  } catch {
    // > Optional repository indexing must never disrupt Session activation.
  }
}

export class SessionActivation {
  private readonly registered = new Map<string, string>();
  private readonly indexAuthorizations = new Map<string, IndexAuthorization>();
  private readonly pending = new Map<
    string,
    { workspaceRoot: string; snapshot: Promise<SessionSnapshot> }
  >();
  private readonly startupShellEnvironment: Record<string, string>;
  private activateWorkspace?: ActivateWorkspace;

  constructor(
    startupEnvironment: NodeJS.ProcessEnv = process.env,
    private readonly repositoryIndex?: Pick<RepositoryIndexService, 'activate'>,
  ) {
    this.startupShellEnvironment = captureShellEnvironment(startupEnvironment);
  }

  setWorkspaceActivator(activate: ActivateWorkspace): void {
    this.activateWorkspace = activate;
  }

  get ready(): boolean {
    return this.activateWorkspace !== undefined;
  }

  registeredWorkspace(sessionId: string): string | undefined {
    return this.registered.get(sessionId);
  }

  register(
    workspaceRoot: string,
    sessionId: string,
    { authorizeRepositoryIndex = false }: { authorizeRepositoryIndex?: boolean } = {},
  ): void {
    const canonicalRoot = canonicalWorkspace(workspaceRoot);
    const existingRoot = this.registeredWorkspace(sessionId);
    if (existingRoot && existingRoot !== canonicalRoot)
      throw new Error('Session is already bound to a different workspace');
    this.registered.set(sessionId, canonicalRoot);
    if (authorizeRepositoryIndex) this.registerIndexScope(sessionId, canonicalRoot);
  }

  private registerIndexScope(sessionId: string, root: string): void {
    const indexService = this.repositoryIndex;
    if (!indexService) return;
    const identity = indexWorkspaceIdentity(root);
    const previous = this.indexAuthorizations.get(sessionId);
    if (previous?.identity === identity) return;
    previous?.stopIndexing?.();
    this.indexAuthorizations.delete(sessionId);
    if (!identity) return;

    const authorization: IndexAuthorization = { identity };
    this.indexAuthorizations.set(sessionId, authorization);
    void openRepositoryWorkspace(root)
      .then((workspace) => {
        if (this.indexAuthorizations.get(sessionId) !== authorization) return;
        if (workspace.root !== root || workspace.identity !== identity) {
          this.indexAuthorizations.delete(sessionId);
          return;
        }
        authorization.stopIndexing = indexService.activate({
          ...workspace,
          assertUnchanged: async () => {
            await workspace.assertUnchanged();
            if (this.indexAuthorizations.get(sessionId) !== authorization)
              throw new Error('The Session worktree is no longer authorized for indexing.');
          },
        });
      })
      .catch(() => {
        if (this.indexAuthorizations.get(sessionId) === authorization)
          this.indexAuthorizations.delete(sessionId);
      });
  }

  async open(
    runtime: Pick<RuntimeController, 'snapshot' | 'teamCatalog'>,
    request: WorkspaceSessionRequest & { shellEnvironment?: Record<string, string> },
  ): Promise<ActivationResult> {
    const activateWorkspace = this.activateWorkspace;
    if (!activateWorkspace) throw new Error('Runtime session activation is not ready');

    const { sessionId, teamSelection, leaderAgentId, shellEnvironment } = request;
    const workspaceRoot = canonicalWorkspace(request.workspaceRoot);
    const registeredWorkspace = this.registeredWorkspace(sessionId);
    if (registeredWorkspace && registeredWorkspace !== workspaceRoot)
      return { conflict: 'Session is already bound to a different workspace' };
    const selectedTeam = () =>
      runtime
        .teamCatalog()
        .find((team) => team.selection === teamSelection || team.teamId === teamSelection);
    if (registeredWorkspace) {
      const snapshot = runtime.snapshot(sessionId);
      if (snapshot.session.teamId !== selectedTeam()?.teamId)
        throw new Error('Session Team is immutable');
      if (!leaderAgentId) {
        this.registerIndexScope(sessionId, workspaceRoot);
        return { snapshot };
      }
    }

    // > Explicit Leader adoption makes its own native request.
    let entry = leaderAgentId ? undefined : this.pending.get(sessionId);
    if (entry && entry.workspaceRoot !== workspaceRoot)
      return { conflict: 'Session initialization is already requested for a different workspace' };
    if (!entry) {
      entry = {
        workspaceRoot,
        snapshot: activateWorkspace({
          workspaceRoot,
          sessionId,
          teamSelection,
          ...(leaderAgentId ? { leaderAgentId } : {}),
          shellEnvironment: captureShellEnvironment(
            shellEnvironment ?? this.startupShellEnvironment,
          ),
        }),
      };
      if (!leaderAgentId) this.pending.set(sessionId, entry);
    }
    let snapshot: SessionSnapshot;
    try {
      snapshot = await entry.snapshot;
    } finally {
      if (this.pending.get(sessionId) === entry) this.pending.delete(sessionId);
    }
    if (
      snapshot.session.id !== sessionId ||
      canonicalWorkspace(snapshot.session.workspaceRoot) !== workspaceRoot
    )
      return { conflict: 'Runtime opened a different workspace session' };
    const selected = selectedTeam();
    if (!selected || snapshot.session.teamId !== selected.teamId)
      throw new Error('Session Team is immutable');
    this.register(workspaceRoot, snapshot.session.id, { authorizeRepositoryIndex: true });
    return { snapshot };
  }
}
