import path from 'node:path';
import { listGitWorktrees } from '../repository/providers/git.js';
import { openRepositoryWorkspace } from '../repository/workspace.js';

export interface WorktreeScope {
  sessionId: string;
  agentId: string;
  workspaceRoot: string;
  passId?: string;
}

interface RegisteredWorktree {
  path: string;
  identity: string;
}

export interface SessionWorktree {
  path: string;
  branch?: string;
}

function scopeKey({ agentId, passId }: WorktreeScope): string {
  return passId ? `pass:${passId}` : `agent:${agentId}`;
}

/** Track the checkouts reported by agents without changing their workspace bindings. */
export class SessionWorktrees {
  private readonly sessions = new Map<string, Map<string, RegisteredWorktree>>();

  constructor(private readonly gitPath: string) {}

  async register(scope: WorktreeScope, checkout: string, signal?: AbortSignal): Promise<void> {
    if (!path.isAbsolute(checkout) || checkout.includes('\0'))
      throw new Error('Report an absolute Git worktree path.');
    const source = await openRepositoryWorkspace(scope.workspaceRoot);
    const candidate = await openRepositoryWorkspace(checkout);
    const entries = await listGitWorktrees(source, this.gitPath, signal);
    if (!entries.some((entry) => this.isAvailable(entry) && entry.path === candidate.root))
      throw new Error('The path is not an available worktree of the session repository.');

    await candidate.assertUnchanged();
    signal?.throwIfAborted();
    let worktrees = this.sessions.get(scope.sessionId);
    if (!worktrees) {
      worktrees = new Map();
      this.sessions.set(scope.sessionId, worktrees);
    }
    worktrees.set(scopeKey(scope), { path: candidate.root, identity: candidate.identity });
  }

  clear(scope: WorktreeScope, checkout: string): void {
    const worktrees = this.sessions.get(scope.sessionId);
    const key = scopeKey(scope);
    if (worktrees?.get(key)?.path !== checkout) return;
    worktrees.delete(key);
    if (!worktrees.size) this.sessions.delete(scope.sessionId);
  }

  async read(scope: WorktreeScope, signal?: AbortSignal) {
    const worktrees = this.sessions.get(scope.sessionId);
    const source = await openRepositoryWorkspace(scope.workspaceRoot);
    const entries = await listGitWorktrees(source, this.gitPath, signal).catch((error: unknown) => {
      signal?.throwIfAborted();
      if (worktrees?.size) throw error;
      return [];
    });
    const available = entries
      .filter((entry) => this.isAvailable(entry))
      .map(({ path, branch }) => ({
        path,
        ...(branch ? { branch } : {}),
      }));
    if (!worktrees?.size) return { following: null, available };

    const byPath = new Map(available.map((item) => [item.path, item]));
    const registered = new Map<string, SessionWorktree>();
    for (const [key, binding] of [...worktrees]) {
      const entry = byPath.get(binding.path);
      const checkout =
        entry && (await openRepositoryWorkspace(binding.path).catch(() => undefined));
      if (worktrees.get(key) !== binding) continue;
      if (
        !entry ||
        !checkout ||
        checkout.root !== binding.path ||
        checkout.identity !== binding.identity
      ) {
        worktrees.delete(key);
        continue;
      }
      registered.set(key, entry);
    }
    if (!worktrees.size && this.sessions.get(scope.sessionId) === worktrees)
      this.sessions.delete(scope.sessionId);
    const paths = new Set([...registered.values()].map(({ path }) => path));
    const following = registered.get(scopeKey(scope)) ?? registered.get(`agent:${scope.agentId}`);
    return {
      following:
        following ?? (paths.size === 1 ? (registered.values().next().value ?? null) : null),
      available,
    };
  }

  private isAvailable(entry: { bare?: true; prunable?: true }): boolean {
    return !entry.bare && !entry.prunable;
  }
}
