import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { RuntimeActor, RuntimeCommand, RuntimeController, SessionSnapshot } from '../api/team.js';
export interface WorkspaceSessionRequest {
  workspaceRoot: string;
  sessionId: string;
  teamSelection: string;
  shellEnvironment: Record<string, string>;
}

function equalToken(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function agentBearer(secret: string, nativeAgentId: string): string {
  return createHmac('sha256', secret).update(nativeAgentId).digest('base64url');
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string { return typeof value === 'string'; }

function isOptionalString(value: Record<string, unknown>, key: string): boolean {
  return !(key in value) || isString(value[key]);
}

function isRuntimeCommand(value: unknown): value is RuntimeCommand {
  if (!isObject(value) || !isString(value.type)) return false;
  switch (value.type) {
    case 'task.create':
      return isString(value.title) && isString(value.description) && isString(value.acceptance)
        && isOptionalString(value, 'passId') && isOptionalString(value, 'passTitle');
    case 'task.update':
      return isString(value.taskId)
        && ['pending', 'running', 'blocked', 'completed', 'failed', 'cancelled'].includes(String(value.status))
        && isOptionalString(value, 'blocker');
    case 'assignment.create':
      return isString(value.taskId) && isString(value.memberKey) && isString(value.message);
    case 'report.create':
      return isString(value.assignmentId) && isString(value.summary) && isString(value.evidence);
    case 'review.create':
      return isString(value.reportId) && ['accepted', 'changes-requested'].includes(String(value.outcome))
        && isString(value.summary);
    case 'approval.create':
      return isObject(value.scope) && isString(value.scope.action) && isString(value.scope.resourceId)
        && isString(value.scope.revision) && ['approved', 'rejected'].includes(String(value.decision));
    case 'team.spawn':
    case 'team.close':
      return isString(value.memberKey);
    case 'team.message':
      return isString(value.memberKey) && isString(value.message);
    default:
      return false;
  }
}
export class RuntimeApi {
  private server: Server | undefined;
  private runtime: RuntimeController | undefined;
  private readonly sessions = new Map<string, string>();
  private readonly pendingSessions = new Map<string, Promise<SessionSnapshot>>();
  private selectedTeam: string | undefined;
  private openWorkspace: ((request: WorkspaceSessionRequest) => Promise<SessionSnapshot>) | undefined;
  constructor(runtime: RuntimeController | undefined, private readonly secret: string, private readonly listenAddress: string) { this.runtime = runtime; }
  setRuntime(runtime: RuntimeController): void { this.runtime = runtime; }
  setSession(workspaceRoot: string, sessionId: string): void { this.sessions.set(workspaceRoot, sessionId); }
  setOpenWorkspaceHandler(teamSelection: string, handler: (request: WorkspaceSessionRequest) => Promise<SessionSnapshot>): void {
    this.selectedTeam = teamSelection;
    this.openWorkspace = handler;
  }
  async listen(): Promise<string> {
    const [host, rawPort] = this.listenAddress.startsWith('[')
      ? [this.listenAddress.slice(1, this.listenAddress.indexOf(']')), this.listenAddress.slice(this.listenAddress.indexOf(']') + 2)]
      : this.listenAddress.split(':');
    const port = Number(rawPort);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || (host !== '127.0.0.1' && host !== '::1')) throw new Error('LTCOOK_API_LISTEN must be a loopback address with an explicit port');
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(port, host, resolve); });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Runtime API failed to bind a local TCP socket');
    return `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  }
  private async handle(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'POST' || !['/v1/command', '/v1/snapshot', '/v1/session/open'].includes(request.url ?? '')) { response.writeHead(404).end('{}'); return; }
    const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    try {
      const maxBodyLength = request.url === '/v1/session/open' ? 1_048_576 : 64_000;
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > maxBodyLength) throw new Error('request too large'); }
      const input = JSON.parse(body) as {
        sessionId?: string; command?: RuntimeCommand; workspaceRoot?: string; nativeAgentId?: string;
        teamSelection?: string; shellEnvironment?: Record<string, string>;
      };
      const isUser = equalToken(bearer, this.secret);
      const actor: RuntimeActor | undefined = isUser ? { kind: 'user' }
        : input.nativeAgentId && equalToken(bearer, agentBearer(this.secret, input.nativeAgentId))
          ? { kind: 'agent', nativeAgentId: input.nativeAgentId } : undefined;
      if (!actor) { response.writeHead(401).end('{"error":"unauthorized"}'); return; }
      if (request.url === '/v1/session/open' && actor.kind !== 'user') {
        response.writeHead(403).end('{"error":"user authentication required"}'); return;
      }
      const runtime = this.runtime;
      const openWorkspace = this.openWorkspace;
      if (request.url === '/v1/session/open') {
        if (!runtime || !openWorkspace) { response.writeHead(503).end('{"error":"Runtime session activation is not ready"}'); return; }
        const shell = input.shellEnvironment;
        if (!input.workspaceRoot || !input.sessionId || !input.teamSelection || !shell
          || typeof shell !== 'object' || Array.isArray(shell)
          || !Object.values(shell).every(value => typeof value === 'string')) {
          response.writeHead(400).end('{"error":"workspaceRoot, sessionId, teamSelection and shellEnvironment are required"}'); return;
        }
        if (input.teamSelection !== this.selectedTeam) {
          response.writeHead(409).end('{"error":"A running runtime cannot switch its selected team; stop and relaunch it explicitly"}'); return;
        }
        const current = this.sessions.get(input.workspaceRoot);
        if (current && current !== input.sessionId) { response.writeHead(409).end('{"error":"Workspace already has a different active session"}'); return; }
        let snapshot = current ? runtime.snapshot(current) : undefined;
        if (!snapshot) {
          let pending = this.pendingSessions.get(input.workspaceRoot);
          if (!pending) {
            pending = openWorkspace({
              workspaceRoot: input.workspaceRoot, sessionId: input.sessionId,
              teamSelection: input.teamSelection, shellEnvironment: shell,
            });
            this.pendingSessions.set(input.workspaceRoot, pending);
          }
          try { snapshot = await pending; }
          finally { this.pendingSessions.delete(input.workspaceRoot); }
          if (snapshot.session.id !== input.sessionId || snapshot.session.workspaceRoot !== input.workspaceRoot) {
            response.writeHead(409).end('{"error":"Runtime opened a different workspace session"}'); return;
          }
          this.setSession(input.workspaceRoot, snapshot.session.id);
        }
        response.writeHead(200).end(JSON.stringify({ sessionId: snapshot.session.id, workspaceRoot: snapshot.session.workspaceRoot })); return;
      }
      if (!runtime) {
        response.writeHead(503).end('{"error":"LTCook runtime is not ready"}'); return;
      }
      if (request.url === '/v1/snapshot') {
        if (actor.kind === 'user') {
          const sessionId = input.workspaceRoot ? this.sessions.get(input.workspaceRoot) : undefined;
          if (!sessionId) throw new Error('Workspace has no active LTCook session');
          response.writeHead(200).end(JSON.stringify(runtime.snapshot(sessionId))); return;
        }
        if (!input.sessionId) throw new Error('Agent snapshot requires a bound session');
        const snapshot: SessionSnapshot = runtime.snapshot(input.sessionId);
        if (!snapshot.members.some(member => member.binding?.nativeAgentId === actor.nativeAgentId)) throw new Error('Native agent is not bound to this session');
        response.writeHead(200).end(JSON.stringify(snapshot)); return;
      }
      if (!input.sessionId || !isRuntimeCommand(input.command)) throw new Error('sessionId and a valid runtime command are required');
      if (actor.kind === 'agent') {
        const snapshot = runtime.snapshot(input.sessionId);
        const member = snapshot.members.find(candidate => candidate.binding?.nativeAgentId === actor.nativeAgentId);
        if (!member) {
          response.writeHead(403).end('{"error":"native agent is not bound to this session"}'); return;
        }
      }
      const value = await runtime.execute(input.sessionId, actor, input.command);
      response.writeHead(200).end(JSON.stringify({ value }));
    } catch (error) { response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : 'request failed' })); }
  }
  async close(): Promise<void> { if (this.server) await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve())); }
}
