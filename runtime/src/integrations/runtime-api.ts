import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { isRuntimeCommand } from '../api/commands.js';
import type {
  RuntimeActor,
  RuntimeCommand,
  RuntimeController,
  SessionSnapshot,
} from '../api/team.js';
import { canonicalWorkspace } from '../core/workspace.js';
export interface WorkspaceSessionRequest {
  workspaceRoot: string;
  sessionId: string;
  teamSelection: string;
  shellEnvironment: Record<string, string>;
}

function equalToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function agentBearer(secret: string, nativeAgentId: string): string {
  return createHmac('sha256', secret).update(nativeAgentId).digest('base64url');
}

export class RuntimeApi {
  private server: Server | undefined;
  private runtime: RuntimeController | undefined;
  private selectedTeamId: string | undefined;
  private readonly sessions = new Map<string, string>();
  private readonly defaultSessions = new Map<string, string>();
  private readonly pendingSessions = new Map<
    string,
    { workspaceRoot: string; pending: Promise<SessionSnapshot> }
  >();
  private selectedTeam: string | undefined;
  private openWorkspace:
    ((request: WorkspaceSessionRequest) => Promise<SessionSnapshot>) | undefined;
  constructor(
    runtime: RuntimeController | undefined,
    private readonly secret: string,
    private readonly listenAddress: string,
  ) {
    this.runtime = runtime;
  }
  setRuntime(runtime: RuntimeController): void {
    this.runtime = runtime;
  }
  setSession(workspaceRoot: string, sessionId: string): void {
    const canonicalRoot = canonicalWorkspace(workspaceRoot);
    const existingRoot = this.sessions.get(sessionId);
    if (existingRoot && existingRoot !== canonicalRoot) {
      throw new Error('Session is already bound to a different workspace');
    }
    this.sessions.set(sessionId, canonicalRoot);
    if (!this.defaultSessions.has(canonicalRoot))
      this.defaultSessions.set(canonicalRoot, sessionId);
  }
  setOpenWorkspaceHandler(
    teamSelection: string,
    handler: (request: WorkspaceSessionRequest) => Promise<SessionSnapshot>,
    teamId?: string,
  ): void {
    this.selectedTeam = teamSelection;
    this.selectedTeamId = teamId;
    this.openWorkspace = handler;
  }
  async listen(): Promise<string> {
    const [host, rawPort] = this.listenAddress.startsWith('[')
      ? [
          this.listenAddress.slice(1, this.listenAddress.indexOf(']')),
          this.listenAddress.slice(this.listenAddress.indexOf(']') + 2),
        ]
      : this.listenAddress.split(':');
    const port = Number(rawPort);
    if (
      !host ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      (host !== '127.0.0.1' && host !== '::1')
    )
      throw new Error('LTCOOK_API_LISTEN must be a loopback address with an explicit port');
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Runtime API failed to bind a local TCP socket');
    return `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  }
  private async handle(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    response.setHeader('content-type', 'application/json');
    if (
      request.method !== 'POST' ||
      !['/v1/command', '/v1/snapshot', '/v1/session/open'].includes(request.url ?? '')
    ) {
      response.writeHead(404).end('{}');
      return;
    }
    const bearer = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : '';
    try {
      const maxBodyLength = request.url === '/v1/session/open' ? 1_048_576 : 64_000;
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > maxBodyLength) throw new Error('request too large');
      }
      const input = JSON.parse(body) as {
        sessionId?: string;
        command?: RuntimeCommand;
        workspaceRoot?: string;
        nativeAgentId?: string;
        teamSelection?: string;
        shellEnvironment?: Record<string, string>;
      };
      const isUser = equalToken(bearer, this.secret);
      const actor: RuntimeActor | undefined = isUser
        ? { kind: 'user' }
        : input.nativeAgentId && equalToken(bearer, agentBearer(this.secret, input.nativeAgentId))
          ? { kind: 'agent', nativeAgentId: input.nativeAgentId }
          : undefined;
      if (!actor) {
        response.writeHead(401).end('{"error":"unauthorized"}');
        return;
      }
      if (request.url === '/v1/session/open' && actor.kind !== 'user') {
        response.writeHead(403).end('{"error":"user authentication required"}');
        return;
      }
      const runtime = this.runtime;
      const openWorkspace = this.openWorkspace;
      if (request.url === '/v1/session/open') {
        if (!runtime || !openWorkspace) {
          response.writeHead(503).end('{"error":"Runtime session activation is not ready"}');
          return;
        }
        const shell = input.shellEnvironment;
        if (
          !input.workspaceRoot ||
          !input.sessionId ||
          !input.teamSelection ||
          !shell ||
          typeof shell !== 'object' ||
          Array.isArray(shell) ||
          !Object.values(shell).every((value) => typeof value === 'string')
        ) {
          response
            .writeHead(400)
            .end(
              '{"error":"workspaceRoot, sessionId, teamSelection and shellEnvironment are required"}',
            );
          return;
        }
        if (input.teamSelection !== this.selectedTeam) {
          response
            .writeHead(409)
            .end(
              '{"error":"A running runtime cannot switch its selected team; stop and relaunch it explicitly"}',
            );
          return;
        }
        const workspaceRoot = canonicalWorkspace(input.workspaceRoot);
        const registeredWorkspace = this.sessions.get(input.sessionId);
        if (registeredWorkspace && registeredWorkspace !== workspaceRoot) {
          response
            .writeHead(409)
            .end('{"error":"Session is already bound to a different workspace"}');
          return;
        }
        let snapshot = registeredWorkspace ? runtime.snapshot(input.sessionId) : undefined;
        if (!snapshot) {
          let entry = this.pendingSessions.get(input.sessionId);
          if (entry && entry.workspaceRoot !== workspaceRoot) {
            response
              .writeHead(409)
              .end(
                '{"error":"Session initialization is already requested for a different workspace"}',
              );
            return;
          }
          if (!entry) {
            const pending = openWorkspace({
              workspaceRoot,
              sessionId: input.sessionId,
              teamSelection: input.teamSelection,
              shellEnvironment: shell,
            });
            entry = { workspaceRoot, pending };
            this.pendingSessions.set(input.sessionId, entry);
          }
          try {
            snapshot = await entry.pending;
          } finally {
            if (this.pendingSessions.get(input.sessionId) === entry)
              this.pendingSessions.delete(input.sessionId);
          }
          if (
            snapshot.session.id !== input.sessionId ||
            canonicalWorkspace(snapshot.session.workspaceRoot) !== workspaceRoot
          ) {
            response.writeHead(409).end('{"error":"Runtime opened a different workspace session"}');
            return;
          }
          if (this.selectedTeamId && snapshot.session.teamId !== this.selectedTeamId) {
            response.writeHead(409).end('{"error":"Runtime opened a different team session"}');
            return;
          }
          this.setSession(workspaceRoot, snapshot.session.id);
        }
        response.writeHead(200).end(
          JSON.stringify({
            sessionId: snapshot.session.id,
            workspaceRoot: snapshot.session.workspaceRoot,
          }),
        );
        return;
      }
      if (!runtime) {
        response.writeHead(503).end('{"error":"LTCook runtime is not ready"}');
        return;
      }
      if (request.url === '/v1/snapshot') {
        if (actor.kind === 'user') {
          const requestedWorkspace = input.workspaceRoot
            ? canonicalWorkspace(input.workspaceRoot)
            : undefined;
          if (
            input.sessionId &&
            (!requestedWorkspace || this.sessions.get(input.sessionId) !== requestedWorkspace)
          ) {
            throw new Error('Session does not belong to the requested workspace');
          }
          const sessionId =
            input.sessionId ??
            (requestedWorkspace ? this.defaultSessions.get(requestedWorkspace) : undefined);
          if (!sessionId) throw new Error('Workspace has no active LTCook session');
          const snapshot = runtime.snapshot(sessionId);
          if (
            requestedWorkspace &&
            canonicalWorkspace(snapshot.session.workspaceRoot) !== requestedWorkspace
          ) {
            throw new Error('Session does not belong to the requested workspace');
          }
          response.writeHead(200).end(JSON.stringify(snapshot));
          return;
        }
        if (!input.sessionId) throw new Error('Agent snapshot requires a bound session');
        const snapshot: SessionSnapshot = runtime.snapshot(input.sessionId);
        if (
          !snapshot.members.some((member) => member.binding?.nativeAgentId === actor.nativeAgentId)
        ) {
          throw new Error('Native agent is not bound to this session');
        }
        response.writeHead(200).end(JSON.stringify(snapshot));
        return;
      }
      if (!input.sessionId || !isRuntimeCommand(input.command))
        throw new Error('sessionId and a valid runtime command are required');
      const sessionSnapshot = runtime.snapshot(input.sessionId);
      if (actor.kind === 'agent') {
        const member = sessionSnapshot.members.find(
          (candidate) => candidate.binding?.nativeAgentId === actor.nativeAgentId,
        );
        if (!member) {
          response.writeHead(403).end('{"error":"native agent is not bound to this session"}');
          return;
        }
      } else if (
        this.sessions.get(input.sessionId) !==
        canonicalWorkspace(sessionSnapshot.session.workspaceRoot)
      ) {
        response.writeHead(403).end('{"error":"session is not active in this runtime"}');
        return;
      }
      const value = await runtime.execute(input.sessionId, actor, input.command);
      response.writeHead(200).end(JSON.stringify({ value }));
    } catch (error) {
      response
        .writeHead(400)
        .end(JSON.stringify({ error: error instanceof Error ? error.message : 'request failed' }));
    }
  }
  async close(): Promise<void> {
    if (this.server)
      await new Promise<void>((resolve, reject) =>
        this.server!.close((error) => (error ? reject(error) : resolve())),
      );
  }
}
