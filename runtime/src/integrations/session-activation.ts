import { canonicalWorkspace } from '../core/workspace.js';
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

export class SessionActivation {
  private readonly registered = new Map<string, string>();
  private readonly pending = new Map<
    string,
    { workspaceRoot: string; snapshot: Promise<SessionSnapshot> }
  >();
  private readonly startupShellEnvironment: Record<string, string>;
  private activateWorkspace?: ActivateWorkspace;

  constructor(startupEnvironment: NodeJS.ProcessEnv = process.env) {
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

  register(workspaceRoot: string, sessionId: string): void {
    const canonicalRoot = canonicalWorkspace(workspaceRoot);
    const existingRoot = this.registeredWorkspace(sessionId);
    if (existingRoot && existingRoot !== canonicalRoot)
      throw new Error('Session is already bound to a different workspace');
    this.registered.set(sessionId, canonicalRoot);
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
      if (!leaderAgentId) return { snapshot };
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
    this.register(workspaceRoot, snapshot.session.id);
    return { snapshot };
  }
}
