import type { Telemetry } from '../diagnostics/telemetry.js';
import process from 'node:process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { RuntimeActor, RuntimeController } from '../workflow-api/index.js';
import { canonicalWorkspace } from '../core/workspace.js';
import type { EvalRunService } from '../evals/service.js';
import type { PaseoHost } from './paseo.js';
import type { SessionMemory } from '../session-memory/service.js';
import type { MemoryScope, MemoryTaskContext } from '../session-memory/units.js';
import type { PastedDocuments } from '../session-memory/pasted-documents.js';
import type { WorkspaceMcp } from './mcp.js';
import { handleActivityRoute, isActivityRoute, type ActivityServices } from './runtime-activity.js';
import { handleToolRoute, isToolRoute } from './runtime-tool-routes.js';
import {
  handleSessionRoute,
  isSessionRoute,
  SESSION_OPEN_PATH,
  type PrepareSession,
} from './runtime-session-routes.js';
import type { SessionActivation } from './session-activation.js';
import type { ToolCatalog } from '../tools/catalog.js';
import type { SessionWorktrees, WorktreeScopeResolver } from './session-worktrees.js';
import { z } from 'zod';
import type { ResolvedModel } from '../models/aliases.js';
import {
  ModelCatalogRequestSchema,
  type ModelCatalogResponseSchema,
} from '../paseo-plugin/shared/models.js';
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
  buildFingerprint?: string;
  idleRestart?: boolean;
}

const modelSelectionRequest = ModelCatalogRequestSchema.extend({
  workspaceRoot: z.string().min(1),
  alias: z.string().optional(),
  reasoning: z.string().optional(),
});

const worktreeRequest = z.object({
  nativeAgentId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});

export interface EvaluationExecutionScope {
  sessionId: string;
  passId: string;
}

function equalToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function agentBearer(secret: string, nativeAgentId: string): string {
  return createHmac('sha256', secret).update(nativeAgentId).digest('base64url');
}

interface RuntimeApiServices {
  activity?: ActivityServices;
  worktrees?: {
    store: SessionWorktrees;
    resolveScope: WorktreeScopeResolver;
  };
}

export class RuntimeApi {
  private server: Server | undefined;
  private memory?: SessionMemory;
  private readonly memoryDisabled: boolean;
  private memoryContext?: (
    agentId: string,
  ) => { scope?: MemoryScope; task?: MemoryTaskContext } | undefined;
  private pastedDocuments?: PastedDocuments;
  private providerSubagents?: PaseoHost['listProviderSubagents'];

  setProviderSubagents(list: PaseoHost['listProviderSubagents']): void {
    this.providerSubagents = list;
  }

  private runtime: RuntimeController | undefined;
  private prepareSession?: PrepareSession;
  setPrepareSessionHandler(handler: PrepareSession): void {
    this.prepareSession = handler;
  }
  private modelSelection:
    | {
        catalog(
          input: z.infer<typeof ModelCatalogRequestSchema>,
        ): z.infer<typeof ModelCatalogResponseSchema>;
        resolve(input: z.infer<typeof modelSelectionRequest>): Promise<ResolvedModel>;
      }
    | undefined;
  setModelSelectionHandlers(handlers: NonNullable<RuntimeApi['modelSelection']>): void {
    this.modelSelection = handlers;
  }
  private lifecycle: RuntimeLifecycleIdentity | undefined;
  private shutdown: (() => Promise<void>) | undefined;
  private reserveIdleRestart?: PaseoHost['reserveIdleRestart'];
  private reservingIdleRestart = false;
  private stopping = false;
  private workspaceMcp: WorkspaceMcp | undefined;
  private workspaceTools: ToolCatalog | undefined;
  setSessionMemory(memory: SessionMemory, context?: RuntimeApi['memoryContext']): void {
    this.memory = memory;
    const preferences = this.services.activity?.preferences;
    memory.setSummarizationEnabled(preferences?.enabled('summarizer') ?? true);
    const mode = preferences?.memoryInferenceMode();
    if (mode) memory.setInferenceMode(mode);
    this.memoryContext = context;
  }
  setPastedDocuments(documents: PastedDocuments): void {
    this.pastedDocuments = documents;
  }

  setWorkspaceMcp(mcp: WorkspaceMcp): void {
    this.workspaceMcp = mcp;
  }
  setWorkspaceTools(catalog: ToolCatalog): void {
    this.workspaceTools = catalog;
  }
  private evals: EvalRunService | undefined;
  private evaluationObserver:
    | ((agentId: string, value: Record<string, unknown>) => EvaluationExecutionScope | void)
    | undefined;
  setEvaluationObserver(
    observer: (agentId: string, value: Record<string, unknown>) => EvaluationExecutionScope | void,
  ): void {
    this.evaluationObserver = observer;
  }
  constructor(
    runtime: RuntimeController | undefined,
    private readonly secret: string,
    private readonly listenAddress: string,
    private readonly activation: SessionActivation,
    startupEnvironment: NodeJS.ProcessEnv = process.env,
    private readonly telemetry?: Telemetry,
    private readonly services: RuntimeApiServices = {},
  ) {
    this.runtime = runtime;
    this.memoryDisabled =
      Number(startupEnvironment.LTCOOK_SESSION_MEMORY_THRESHOLD ?? '3000') === 0;
    const activity = services.activity;
    if (activity) activity.colgrep.setIndexingEnabled(activity.preferences.enabled('rag-index'));
  }

  setRuntime(runtime: RuntimeController): void {
    this.runtime = runtime;
  }
  setEval(service: EvalRunService): void {
    this.evals = service;
  }
  setLifecycle(
    identity: RuntimeLifecycleIdentity,
    shutdown: () => Promise<void>,
    reserveIdleRestart?: PaseoHost['reserveIdleRestart'],
  ): void {
    this.lifecycle = { ...identity, ...(reserveIdleRestart && { idleRestart: true }) };
    this.shutdown = shutdown;
    this.reserveIdleRestart = reserveIdleRestart;
  }
  private async canStopWhenIdle(response: ServerResponse): Promise<boolean> {
    const reserve = this.reserveIdleRestart;
    if (!reserve) {
      response.writeHead(503).end('{"error":"Paseo idle reservations are unavailable"}');
      return false;
    }
    this.reservingIdleRestart = true;
    try {
      const reservation = await reserve();
      if (reservation.status === 'busy') {
        response.writeHead(423).end(JSON.stringify(reservation));
        return false;
      }

      let committed = false;
      try {
        if (response.destroyed) return false;
        if (this.stopping) {
          response.writeHead(503).end('{"error":"LTCook runtime is stopping"}');
          return false;
        }
        const result = await reservation.commit();
        if (result.status === 'busy') {
          response.writeHead(423).end(JSON.stringify(result));
          return false;
        }
        committed = true;
        return true;
      } finally {
        if (!committed) await reservation.release().catch(() => undefined);
      }
    } catch {
      if (!response.destroyed) {
        response.writeHead(503).end('{"error":"Paseo could not confirm the idle reservation"}');
      }
      return false;
    } finally {
      this.reservingIdleRestart = false;
    }
  }

  beginShutdown(): void {
    this.stopping = true;
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
    if (request.url === '/mcp') {
      if (this.stopping || !this.workspaceMcp) response.writeHead(503).end();
      else await this.workspaceMcp.handle(request, response);
      return;
    }
    const operation = (
      {
        '/v1/team/catalog': 'team.catalog',
        '/v1/session/open': 'session.open',
        '/v1/session/prepare': 'leader.adopt',
        '/v1/snapshot': 'panel.refresh',
      } as Record<string, string>
    )[request.url ?? ''];
    const telemetry = this.telemetry;
    if (operation && telemetry) {
      const started = process.hrtime.bigint();
      let recorded = false;
      const finish = () => {
        if (recorded) return;
        recorded = true;
        telemetry.duration(
          operation,
          Number(process.hrtime.bigint() - started) / 1e6,
          'runtime-api',
        );
      };
      response.once('finish', finish);
      response.once('close', finish);
    }
    response.setHeader('content-type', 'application/json');
    const activityRoute = isActivityRoute(request.url) ? request.url : undefined;
    const toolRoute = isToolRoute(request.url) ? request.url : undefined;
    const sessionRoute = isSessionRoute(request.url) ? request.url : undefined;
    const isPostRoute =
      activityRoute !== undefined ||
      toolRoute !== undefined ||
      sessionRoute !== undefined ||
      [
        '/v1/model/catalog',
        '/v1/model/resolve',
        '/v1/session/worktrees',
        '/v1/runtime/stop',
        '/v1/session-memory/observe',
        '/v1/session-memory/paste',
        '/v1/mcp/grant',
        '/v1/mcp/revoke',
        '/v1/evaluation/observe',
        '/v1/evals/start',
        '/v1/evals/status',
        '/v1/evals/list',
        '/v1/evals/report',
        '/v1/evals/cancel',
        '/v1/evals/delete',
      ].includes(request.url ?? '');
    if (
      !(request.method === 'POST' && isPostRoute) &&
      !(request.method === 'GET' && request.url === '/v1/status')
    ) {
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
      if (this.stopping || !this.lifecycle || !this.activation.ready) {
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
      const maxBodyLength =
        request.url === '/v1/session-memory/paste'
          ? 2_097_152
          : sessionRoute === SESSION_OPEN_PATH
            ? 1_048_576
            : 64_000;
      let body = '';
      request.setEncoding('utf8');
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
        if (this.stopping || !this.lifecycle || !this.shutdown || !this.activation.ready) {
          response.writeHead(503).end('{"error":"LTCook runtime is starting or stopping"}');
          return;
        }
        if (parsed.instanceId !== this.lifecycle.instanceId) {
          response.writeHead(409).end('{"error":"Runtime instance changed; probe again"}');
          return;
        }
        const whenIdle = 'whenIdle' in parsed ? parsed.whenIdle : false;
        if (typeof whenIdle !== 'boolean') {
          response.writeHead(400).end('{"error":"whenIdle must be a boolean"}');
          return;
        }
        if (this.reservingIdleRestart) {
          response.writeHead(503).end('{"error":"An idle reservation is in progress"}');
          return;
        }
        const shutdown = this.shutdown;
        if (whenIdle && !(await this.canStopWhenIdle(response))) return;
        this.beginShutdown();
        let scheduled = false;
        const scheduleShutdown = () => {
          if (scheduled) return;
          scheduled = true;
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
        };
        response.once('finish', scheduleShutdown);
        if (whenIdle) {
          response.once('close', scheduleShutdown);
          if (response.destroyed) {
            scheduleShutdown();
            return;
          }
        }
        response.writeHead(202).end('{"stopping":true}');
        return;
      }
      const input = parsed as {
        sessionId?: string;
        workspaceRoot?: string;
        nativeAgentId?: string;
        force?: unknown;
        turnId?: unknown;
        outcome?: unknown;
        local?: unknown;
        closed?: unknown;
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
      if (request.url === '/v1/session/worktrees') {
        if (!isUser) {
          response.writeHead(403).end('{}');
          return;
        }
        const { nativeAgentId, ...requestScope } = worktreeRequest.parse(parsed);
        const service = this.services.worktrees;
        if (!service) {
          response.writeHead(503).end('{"error":"Session worktrees are unavailable."}');
          return;
        }
        const scope = service.resolveScope({ ...requestScope, agentId: nativeAgentId });
        const worktrees = await service.store.read(scope, AbortSignal.timeout(3500));
        response.writeHead(200).end(
          JSON.stringify({
            agentId: scope.agentId,
            sessionId: scope.sessionId,
            original: scope.workspaceRoot,
            ...worktrees,
          }),
        );
        return;
      }
      if (activityRoute) {
        if (!isUser) {
          response.writeHead(403).end('{}');
          return;
        }
        await handleActivityRoute(activityRoute, parsed, response, {
          activity: this.services.activity,
          memoryDisabled: this.memoryDisabled,
          readMemory: () => this.memory,
          readSession: (id) => this.runtime?.snapshot(id),
          registeredWorkspace: (id) => this.activation.registeredWorkspace(id),
          readGrantedWorkspace: (id) => this.workspaceMcp?.repositorySearchWorkspace(id),
          listProviderSubagents: (id) => this.providerSubagents?.(id),
        });
        return;
      }
      if (request.url === '/v1/session-memory/paste') {
        if (!isUser) {
          response.writeHead(403).end('{}');
          return;
        }
        const input = z
          .union([
            z.object({ text: z.string().min(1).max(262_144) }),
            z.object({ discard: z.uuid() }),
          ])
          .parse(parsed);
        if (!this.pastedDocuments) {
          response.writeHead(503).end('{}');
          return;
        }
        if ('discard' in input) {
          await this.pastedDocuments.discard(input.discard);
          response.writeHead(200).end('{}');
        } else {
          response.writeHead(200).end(JSON.stringify(await this.pastedDocuments.draft(input.text)));
        }
        return;
      }
      if (request.url === '/v1/session-memory/observe') {
        const id = input.nativeAgentId;
        const session = input.sessionId;
        if (
          typeof id !== 'string' ||
          !id ||
          (actor.kind !== 'user' &&
            (!session ||
              !this.runtime
                ?.snapshot(session)
                .members.some(
                  ({ binding }) => binding?.nativeAgentId === id && binding.state === 'bound',
                )))
        ) {
          response.writeHead(403).end('{}');
          return;
        }
        const outcome = input.outcome;
        if (actor.kind === 'user' && input.closed === true) {
          this.memory?.agentClosed(id);
        } else if (
          actor.kind === 'user' &&
          typeof input.turnId === 'string' &&
          input.turnId &&
          (outcome === 'running' ||
            outcome === 'completed' ||
            outcome === 'failed' ||
            outcome === 'canceled')
        ) {
          this.memory?.turn(
            id,
            { turnId: input.turnId, outcome, ...this.memoryContext?.(id) },
            input.local === true,
          );
        } else {
          this.memory?.observe(id, actor.kind === 'user' && input.force === true);
        }
        response.writeHead(202).end(JSON.stringify({ memoryEnabled: this.memory !== undefined }));
        return;
      }
      if (request.url === '/v1/mcp/grant' || request.url === '/v1/mcp/revoke') {
        if (actor.kind !== 'user') {
          response.writeHead(403).end('{}');
          return;
        }
        if (typeof input.nativeAgentId !== 'string' || !input.nativeAgentId)
          throw new Error('A native agent identity is required.');
        if (request.url === '/v1/mcp/revoke') {
          await this.workspaceMcp?.revoke(input.nativeAgentId);
          response.writeHead(200).end('{}');
          return;
        }
        if (!this.workspaceMcp || this.stopping) {
          response.writeHead(503).end('{}');
          return;
        }
        if (typeof input.workspaceRoot !== 'string')
          throw new Error('A trusted launch workspace is required.');
        // > The authenticated Paseo launch authorizes LTCook reads in its workspace.
        const provider = 'provider' in parsed ? parsed.provider : undefined;
        const workspaceFileAccess = provider === 'pi' || provider === 'codex';
        const token = await this.workspaceMcp.grant(
          input.nativeAgentId,
          input.workspaceRoot,
          workspaceFileAccess,
          workspaceFileAccess,
        );
        response.writeHead(200).end(JSON.stringify({ token }));
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
        const scope = this.evaluationObserver(
          actor.nativeAgentId,
          parsed as Record<string, unknown>,
        );
        if ((parsed as Record<string, unknown>).kind === 'scope.request') {
          if (
            !scope ||
            scope.sessionId !== input.sessionId ||
            !this.runtime
              .snapshot(input.sessionId)
              .passes.some((pass) => pass.id === scope.passId && pass.status === 'running')
          ) {
            response.writeHead(403).end('{"error":"Evaluation execution scope is unavailable"}');
            return;
          }
          response.writeHead(200).end(JSON.stringify({ evaluationScope: scope }));
          return;
        }
        response.writeHead(200).end('{}');
        return;
      }
      if ((request.url ?? '').startsWith('/v1/evals/')) {
        if (actor.kind !== 'user') {
          response.writeHead(403).end('{"error":"user authentication required"}');
          return;
        }
        await this.handleEvals(request.url!, parsed, response);
        return;
      }
      if (sessionRoute === SESSION_OPEN_PATH && actor.kind !== 'user') {
        response.writeHead(403).end('{"error":"user authentication required"}');
        return;
      }
      if (this.stopping) {
        response.writeHead(503).end('{"error":"LTCook runtime is stopping"}');
        return;
      }
      const runtime = this.runtime;
      if (sessionRoute) {
        await handleSessionRoute(sessionRoute, parsed, response, actor, {
          runtime,
          activation: this.activation,
          prepareSession: this.prepareSession,
        });
        return;
      }
      if (!runtime) {
        response.writeHead(503).end('{"error":"LTCook runtime is not ready"}');
        return;
      }
      if (toolRoute) {
        await handleToolRoute(toolRoute, parsed, response, actor, {
          runtime,
          catalog: this.workspaceTools,
          registeredWorkspace: (id) => this.activation.registeredWorkspace(id),
        });
        return;
      }
      if (request.url === '/v1/model/catalog' || request.url === '/v1/model/resolve') {
        if (actor.kind !== 'user') {
          response.writeHead(403).end('{"error":"user authentication required"}');
          return;
        }
        if (!this.modelSelection) throw new Error('Model selection is not ready');
        const result =
          request.url === '/v1/model/catalog'
            ? this.modelSelection.catalog(ModelCatalogRequestSchema.parse(parsed))
            : await this.modelSelection.resolve(modelSelectionRequest.parse(parsed));
        response.writeHead(200).end(JSON.stringify(result));
        return;
      }
    } catch (error) {
      response
        .writeHead(400)
        .end(JSON.stringify({ error: error instanceof Error ? error.message : 'request failed' }));
    }
  }
  private async handleEvals(
    url: string,
    parsed: object,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    if (!this.evals) {
      response.writeHead(503).end('{"error":"Agent Evals service is not ready"}');
      return;
    }
    let value: unknown;
    switch (url) {
      case '/v1/evals/start': {
        const request = EvalStartRequestSchema.parse(parsed);
        let teamSelection: string | undefined;
        const limitations: string[] = [];
        const requestedTeam = request.environmentOverrides?.LTCOOK_TEAM;
        const requestedEntry =
          requestedTeam === undefined
            ? undefined
            : this.runtime
                ?.teamCatalog()
                .find(
                  (entry) =>
                    entry.status === 'installed' &&
                    (entry.selection === requestedTeam || entry.teamId === requestedTeam),
                );
        if (requestedTeam !== undefined && !requestedEntry)
          throw new Error('The requested evaluation Team is not installed');
        if (request.sessionId) {
          if (request.setup !== 'current' || !request.workspaceRoot || !this.runtime)
            throw new Error('A Current Setup workspace and active Session are required');
          const session = this.runtime.snapshot(request.sessionId).session;
          if (
            canonicalWorkspace(session.workspaceRoot) !==
              canonicalWorkspace(request.workspaceRoot) ||
            this.activation.registeredWorkspace(request.sessionId) !==
              canonicalWorkspace(request.workspaceRoot)
          )
            throw new Error('Evaluation Session does not match the registered workspace');
          const team = this.runtime
            .teamCatalog()
            .find((entry) => entry.teamId === session.teamId && entry.status === 'installed');
          if (!team) throw new Error('The Session Team is not installed');
          if (requestedEntry && requestedEntry.teamId !== team.teamId)
            throw new Error('Evaluation Team does not match the selected Session');
          teamSelection = requestedTeam ?? team.selection;
        } else if (request.setup === 'current' && request.workspaceRoot && this.runtime) {
          const teamIds = new Set(
            this.runtime.listSessions(request.workspaceRoot).map((session) => session.teamId),
          );
          if (teamIds.size > 1 && !requestedEntry)
            limitations.push(
              'Multiple Teams have Sessions in this workspace; using the configured runtime Team.',
            );
        }
        if (!teamSelection && requestedEntry) teamSelection = requestedTeam;
        value = { runId: await this.evals.start(request, teamSelection, limitations) };
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
  async close(): Promise<void> {
    await this.workspaceMcp?.close();
    if (this.server)
      await new Promise<void>((resolve, reject) =>
        this.server!.close((error) => (error ? reject(error) : resolve())),
      );
  }
}
