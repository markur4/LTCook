import process from 'node:process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { isRuntimeCommand } from '../workflow-api/commands.js';
import type {
  RuntimeActor,
  RuntimeCommand,
  RuntimeController,
  SessionSnapshot,
} from '../workflow-api/index.js';
import { canonicalWorkspace } from '../core/workspace.js';
import type { EvalRunService } from '../evals/service.js';
import {
  EvalDeleteRequestSchema,
  EvalRunIdSchema,
  EvalStartRequestSchema,
  EvalStatusRequestSchema,
} from '../evals/contracts.js';
export interface RuntimeLifecycleIdentity {
  instanceId: string;
  deploymentRoot: string;
  databasePath: string;
  paseoListen: string;
  backendLogPath: string | null;
  paseoLogPath: string;
  telemetryLogPath: string;
}

export interface WorkspaceSessionRequest {
  workspaceRoot: string;
  sessionId: string;
  teamSelection: string;
  shellEnvironment: Record<string, string>;
  leaderAgentId?: string;
}

/** Captures the shell before AppRC overlays, without retaining nested provenance. */
export function captureShellEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const encoded = source.LTCOOK_SHELL_PROVENANCE;
  let original: Record<string, unknown> = source;
  if (encoded !== undefined) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch {
      throw new Error('LTCOOK_SHELL_PROVENANCE is not an environment mapping');
    }
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      Array.isArray(decoded) ||
      !Object.values(decoded).every((value) => typeof value === 'string')
    ) {
      throw new Error('LTCOOK_SHELL_PROVENANCE is not an environment mapping');
    }
    original = decoded as Record<string, string>;
  }
  return Object.fromEntries(
    Object.entries(original).filter(
      (entry): entry is [string, string] =>
        entry[0] !== 'LTCOOK_SHELL_PROVENANCE' && typeof entry[1] === 'string',
    ),
  );
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
  private readonly sessions = new Map<string, string>();
  private readonly pendingSessions = new Map<
    string,
    { workspaceRoot: string; pending: Promise<SessionSnapshot> }
  >();
  private readonly startupShellEnvironment: Record<string, string>;
  private openWorkspace:
    ((request: WorkspaceSessionRequest) => Promise<SessionSnapshot>) | undefined;
  private prepareSession:
    | ((
        request: WorkspaceSessionRequest & { leaderAgentId: string },
      ) => Promise<{ env: Record<string, string>; mcpServers?: Record<string, unknown> }>)
    | undefined;
  setPrepareSessionHandler(handler: NonNullable<RuntimeApi['prepareSession']>): void {
    this.prepareSession = handler;
  }
  private lifecycle: RuntimeLifecycleIdentity | undefined;
  private shutdown: (() => Promise<void>) | undefined;
  private stopping = false;
  private evals: EvalRunService | undefined;
  private evaluationObserver:
    ((agentId: string, value: Record<string, unknown>) => void) | undefined;
  setEvaluationObserver(observer: (agentId: string, value: Record<string, unknown>) => void): void {
    this.evaluationObserver = observer;
  }
  constructor(
    runtime: RuntimeController | undefined,
    private readonly secret: string,
    private readonly listenAddress: string,
    startupEnvironment: NodeJS.ProcessEnv = process.env,
  ) {
    this.runtime = runtime;
    this.startupShellEnvironment = captureShellEnvironment(startupEnvironment);
  }
  setRuntime(runtime: RuntimeController): void {
    this.runtime = runtime;
  }
  setEval(service: EvalRunService): void {
    this.evals = service;
  }
  setLifecycle(identity: RuntimeLifecycleIdentity, shutdown: () => Promise<void>): void {
    this.lifecycle = { ...identity };
    this.shutdown = shutdown;
  }
  beginShutdown(): void {
    this.stopping = true;
  }
  setSession(workspaceRoot: string, sessionId: string): void {
    const canonicalRoot = canonicalWorkspace(workspaceRoot);
    const existingRoot = this.sessions.get(sessionId);
    if (existingRoot && existingRoot !== canonicalRoot) {
      throw new Error('Session is already bound to a different workspace');
    }
    this.sessions.set(sessionId, canonicalRoot);
  }
  setOpenWorkspaceHandler(
    handler: (request: WorkspaceSessionRequest) => Promise<SessionSnapshot>,
  ): void {
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
    if (!(
      (request.method === 'POST' &&
        [
          '/v1/command',
          '/v1/snapshot',
          '/v1/session/open',
          '/v1/team/catalog',
          '/v1/session/list',
          '/v1/session/prepare',
          '/v1/runtime/stop',
          '/v1/tool/authorize',
          '/v1/ried',
          '/v1/evaluation/observe',
          '/v1/evals/start',
          '/v1/evals/status',
          '/v1/evals/list',
          '/v1/evals/report',
          '/v1/evals/cancel',
          '/v1/evals/delete',
        ].includes(request.url ?? '')) ||
      (request.method === 'GET' && request.url === '/v1/status')
    )) {
      response.writeHead(404).end('{}');
      return;
    }
    const bearer = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : '';
    if (request.method === 'GET' && request.url === '/v1/status') {
      if (!equalToken(bearer, this.secret)) {
        response.writeHead(401).end('{"error":"unauthorized"}');
        return;
      }
      if (this.stopping || !this.lifecycle || !this.openWorkspace) {
        response.writeHead(503).end('{"error":"LTCook runtime is starting or stopping"}');
        return;
      }
      response.writeHead(200).end(JSON.stringify(this.lifecycle));
      return;
    }
    if (request.url === '/v1/runtime/stop' && !equalToken(bearer, this.secret)) {
      response.writeHead(401).end('{"error":"user authentication required"}');
      return;
    }
    try {
      const maxBodyLength = request.url === '/v1/session/open' ? 1_048_576 : 64_000;
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > maxBodyLength) throw new Error('request too large');
      }
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('request must be a JSON object');
      }
      if (request.url === '/v1/runtime/stop') {
        if (
          !('instanceId' in parsed) ||
          typeof parsed.instanceId !== 'string' ||
          !parsed.instanceId
        ) {
          response.writeHead(400).end('{"error":"instanceId is required"}');
          return;
        }
        if (this.stopping || !this.lifecycle || !this.shutdown || !this.openWorkspace) {
          response.writeHead(503).end('{"error":"LTCook runtime is starting or stopping"}');
          return;
        }
        if (parsed.instanceId !== this.lifecycle.instanceId) {
          response.writeHead(409).end('{"error":"Runtime instance changed; probe again"}');
          return;
        }
        const shutdown = this.shutdown;
        this.beginShutdown();
        response.once('finish', () => {
          setImmediate(() => {
            void shutdown().catch((error: unknown) => {
              const message =
                error instanceof Error
                  ? error.message.replace(/(token|password|api.?key)=?[^\s]*/gi, '$1=<redacted>')
                  : 'unknown shutdown error';
              process.stderr.write(`LTCook runtime shutdown failed: ${message}\n`);
              process.exitCode = 1;
            });
          });
        });
        response.writeHead(202).end('{"stopping":true}');
        return;
      }
      const input = parsed as {
        sessionId?: string;
        command?: RuntimeCommand;
        workspaceRoot?: string;
        nativeAgentId?: string;
        teamSelection?: string;
        leaderAgentId?: string;
        shellEnvironment?: unknown;
        toolName?: unknown;
        input?: unknown;
        operation?: unknown;
        section?: unknown;
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
      if (request.url === '/v1/evaluation/observe') {
        if (
          !this.evaluationObserver ||
          actor.kind !== 'agent' ||
          !input.sessionId ||
          !this.runtime ||
          !this.runtime
            .snapshot(input.sessionId)
            .members.some(
              (member) =>
                member.binding?.nativeAgentId === actor.nativeAgentId &&
                member.binding.state === 'bound',
            )
        ) {
          response.writeHead(403).end('{}');
          return;
        }
        this.evaluationObserver(actor.nativeAgentId, parsed as Record<string, unknown>);
        response.writeHead(200).end('{}');
        return;
      }
      if ((request.url ?? '').startsWith('/v1/evals/')) {
        if (actor.kind !== 'user') {
          response.writeHead(403).end('{"error":"user authentication required"}');
          return;
        }
        if (!this.evals) {
          response.writeHead(503).end('{"error":"Agent Evals service is not ready"}');
          return;
        }
        let value: unknown;
        switch (request.url) {
          case '/v1/evals/start': {
            const request = EvalStartRequestSchema.parse(parsed);
            value = { runId: await this.evals.start(request) };
            break;
          }
          case '/v1/evals/status': {
            const { runId, after } = EvalStatusRequestSchema.parse(parsed);
            value = await this.evals.status(runId, after);
            break;
          }
          case '/v1/evals/list':
            value = { runs: this.evals.list() };
            break;
          case '/v1/evals/report': {
            const { runId } = EvalRunIdSchema.parse(parsed);
            value = this.evals.report(runId);
            break;
          }
          case '/v1/evals/cancel': {
            const { runId } = EvalRunIdSchema.parse(parsed);
            value = { summary: await this.evals.cancel(runId) };
            break;
          }
          case '/v1/evals/delete': {
            const { runId } = EvalDeleteRequestSchema.parse(parsed);
            await this.evals.delete(runId);
            value = { deleted: true };
            break;
          }
          default:
            response.writeHead(404).end('{}');
            return;
        }
        response.writeHead(200).end(JSON.stringify(value));
        return;
      }
      if (request.url === '/v1/session/open' && actor.kind !== 'user') {
        response.writeHead(403).end('{"error":"user authentication required"}');
        return;
      }
      if (this.stopping) {
        response.writeHead(503).end('{"error":"LTCook runtime is stopping"}');
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
          typeof input.workspaceRoot !== 'string' ||
          !input.workspaceRoot ||
          typeof input.sessionId !== 'string' ||
          !input.sessionId ||
          typeof input.teamSelection !== 'string' ||
          !input.teamSelection ||
          (shell !== undefined &&
            (!shell ||
              typeof shell !== 'object' ||
              Array.isArray(shell) ||
              !Object.values(shell).every((value) => typeof value === 'string')))
        ) {
          response
            .writeHead(400)
            .end(
              '{"error":"workspaceRoot, sessionId and teamSelection are required; shellEnvironment must be a string mapping when supplied"}',
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
        let snapshot: SessionSnapshot | undefined;
        if (registeredWorkspace) {
          const existing = runtime.snapshot(input.sessionId);
          if (
            existing.session.teamId !==
            runtime
              .teamCatalog()
              .find(
                (team) =>
                  team.selection === input.teamSelection || team.teamId === input.teamSelection,
              )?.teamId
          )
            throw new Error('Session Team is immutable');
          if (!input.leaderAgentId) snapshot = existing;
        }
        if (!snapshot) {
          let entry = input.leaderAgentId ? undefined : this.pendingSessions.get(input.sessionId);
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
              ...(input.leaderAgentId ? { leaderAgentId: input.leaderAgentId } : {}),
              shellEnvironment: captureShellEnvironment(
                shell === undefined
                  ? this.startupShellEnvironment
                  : (shell as Record<string, string>),
              ),
            });
            entry = { workspaceRoot, pending };
            if (!input.leaderAgentId) this.pendingSessions.set(input.sessionId, entry);
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
          const selected = runtime
            .teamCatalog()
            .find(
              (team) =>
                team.selection === input.teamSelection || team.teamId === input.teamSelection,
            );
          if (!selected || snapshot.session.teamId !== selected.teamId)
            throw new Error('Session Team is immutable');
          this.setSession(workspaceRoot, snapshot.session.id);
        }
        response.writeHead(200).end(
          JSON.stringify({
            sessionId: snapshot.session.id,
            workspaceRoot: snapshot.session.workspaceRoot,
            teamId: snapshot.session.teamId,
            teamInstanceId: snapshot.session.teamInstanceId,
            leaderAgentId:
              snapshot.members.find((item) => item.member.key === snapshot.definition.leaderKey)
                ?.binding?.nativeAgentId ?? null,
          }),
        );
        return;
      }
      if (!runtime) {
        response.writeHead(503).end('{"error":"LTCook runtime is not ready"}');
        return;
      }
      if (request.url === '/v1/session/prepare') {
        if (actor.kind !== 'user') {
          response.writeHead(403).end('{"error":"user authentication required"}');
          return;
        }
        if (!this.prepareSession) throw new Error('Session preparation is not ready');
        if (
          !input.sessionId ||
          !input.workspaceRoot ||
          !input.teamSelection ||
          input.leaderAgentId !== input.sessionId
        )
          throw new Error('Explicit Session Leader identity is required');
        const snapshot = runtime.snapshot(input.sessionId);
        const team = runtime
          .teamCatalog()
          .find(
            (entry) =>
              entry.selection === input.teamSelection || entry.teamId === input.teamSelection,
          );
        const leader = snapshot.members.find(
          (item) => item.member.key === snapshot.definition.leaderKey,
        );
        if (
          !team ||
          snapshot.session.teamId !== team.teamId ||
          canonicalWorkspace(input.workspaceRoot) !== snapshot.session.workspaceRoot ||
          leader?.binding?.nativeAgentId !== input.leaderAgentId
        )
          throw new Error('Session preparation identity does not match its binding');
        const prepared = await this.prepareSession({
          sessionId: input.sessionId,
          workspaceRoot: snapshot.session.workspaceRoot,
          teamSelection: input.teamSelection,
          leaderAgentId: input.leaderAgentId!,
          shellEnvironment: this.startupShellEnvironment,
        });
        response.writeHead(200).end(JSON.stringify(prepared));
        return;
      }
      if (request.url === '/v1/team/catalog' || request.url === '/v1/session/list') {
        if (actor.kind !== 'user') {
          response.writeHead(403).end('{"error":"user authentication required"}');
          return;
        }
        if (request.url === '/v1/team/catalog') {
          response.writeHead(200).end(JSON.stringify({ teams: runtime.teamCatalog() }));
        } else {
          if (!input.workspaceRoot) throw new Error('workspaceRoot is required');
          const sessions = runtime
            .listSessions(input.workspaceRoot, input.teamSelection)
            .map((session) => {
              const snapshot = runtime.snapshot(session.id);
              return {
                sessionId: session.id,
                teamId: session.teamId,
                workspaceRoot: session.workspaceRoot,
                createdAt: session.createdAt,
                leaderAgentId:
                  snapshot.members.find((item) => item.member.key === snapshot.definition.leaderKey)
                    ?.binding?.nativeAgentId ?? null,
              };
            });
          response.writeHead(200).end(JSON.stringify({ sessions }));
        }
        return;
      }
      if (request.url === '/v1/ried') {
        if (!input.sessionId) throw new Error('RIED requires a Session');
        if ('path' in parsed || 'workspaceRoot' in parsed)
          throw new Error('RIED scan paths are derived from the Session');
        if (!['summary', 'section', 'refresh'].includes(String(input.operation)))
          throw new Error('Invalid RIED operation');
        if (
          input.operation === 'section' &&
          !['repository', 'git', 'host', 'recipes'].includes(String(input.section))
        )
          throw new Error('Invalid RIED section');
        const session = runtime.snapshot(input.sessionId);
        if (actor.kind === 'agent') {
          if (
            !session.members.some(
              (member) =>
                member.binding?.nativeAgentId === actor.nativeAgentId &&
                member.binding.state === 'bound',
            )
          ) {
            response.writeHead(403).end('{"error":"native agent is not bound to this session"}');
            return;
          }
        } else if (
          this.sessions.get(input.sessionId) !== canonicalWorkspace(session.session.workspaceRoot)
        ) {
          response.writeHead(403).end('{"error":"session is not active in this runtime"}');
          return;
        }
        const value = await runtime.ried(input.sessionId, {
          operation: input.operation as 'summary' | 'section' | 'refresh',
          ...(input.operation === 'section'
            ? { section: input.section as 'repository' | 'git' | 'host' | 'recipes' }
            : {}),
        });
        response.writeHead(200).end(JSON.stringify({ value }));
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
          const sessionId = input.sessionId;
          if (!sessionId) {
            response
              .writeHead(404)
              .end('{"error":"No session found for workspace","code":"SESSION_NOT_FOUND"}');
            return;
          }
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
          !snapshot.members.some(
            (member) =>
              member.binding?.nativeAgentId === actor.nativeAgentId &&
              member.binding.state === 'bound',
          )
        ) {
          throw new Error('Native agent is not bound to this session');
        }
        response.writeHead(200).end(JSON.stringify(snapshot));
        return;
      }
      if (request.url === '/v1/tool/authorize') {
        if (
          actor.kind !== 'agent' ||
          !input.sessionId ||
          typeof input.toolName !== 'string' ||
          !input.input ||
          typeof input.input !== 'object' ||
          Array.isArray(input.input)
        )
          throw new Error('Bound agent, Session, toolName and input mapping required');
        const authorization = runtime.authorizeTool(
          input.sessionId,
          actor.nativeAgentId,
          input.toolName,
          input.input as Record<string, unknown>,
        );
        response.writeHead(200).end(JSON.stringify(authorization));
        return;
      }
      if (!input.sessionId || !isRuntimeCommand(input.command))
        throw new Error('sessionId and a valid runtime command are required');
      const metadataRecovery =
        actor.kind === 'user' &&
        ['planning.show', 'planning.questions', 'decision.answer'].includes(input.command.type);
      const sessionSnapshot = runtime.snapshot(input.sessionId);
      if (metadataRecovery && !this.sessions.has(input.sessionId))
        this.setSession(sessionSnapshot.session.workspaceRoot, input.sessionId);
      if (actor.kind === 'agent') {
        const member = sessionSnapshot.members.find(
          (candidate) =>
            candidate.binding?.nativeAgentId === actor.nativeAgentId &&
            candidate.binding.state === 'bound',
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
