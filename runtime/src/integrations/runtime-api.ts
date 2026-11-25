import type { Telemetry } from '../diagnostics/telemetry.js';
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
import { captureShellEnvironment } from './shell-environment.js';
import type { EvalRunService } from '../evals/service.js';
import type { PaseoHost } from './paseo.js';
import type { SessionMemory } from '../session-memory/service.js';
import type { MemoryScope, MemoryTaskContext } from '../session-memory/units.js';
import type { PastedDocuments } from '../session-memory/pasted-documents.js';
import type { WorkspaceMcp } from './mcp.js';
import { ActivityPreferences } from './activity-preferences.js';
import {
  activityToggleRpc,
  memoryDeviceRpc,
  memoryEvidenceRpc,
  storedSummariesRpc,
} from '../paseo-plugin/shared/activity.js';
import {
  isRepositoryTool,
  SESSION_MEMORY_TOOL_NAME,
  REPO_SEARCH_TIMEOUT_MS,
  WORKTREE_TOOL_NAME,
} from '../paseo-plugin/shared/workspace-tools.js';
import { isWebTool } from '../tools/web.js';
import { createSessionWorktreeTool } from '../tools/session-worktree.js';
import type { ToolContext } from '../tools/types.js';
import { SessionWorktrees, type WorktreeScope } from './session-worktrees.js';
import { openRepositoryWorkspace } from '../repository/workspace.js';
import { createColgrepProvider } from '../repository/providers/colgrep.js';
import { validateRiedRequest } from '../repository/requests.js';
import { z } from 'zod';
import { ResolvedModelSchema, type ResolvedModel } from '../models/aliases.js';
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
}

export interface WorkspaceSessionRequest {
  workspaceRoot: string;
  sessionId: string;
  teamSelection: string;
  shellEnvironment: Record<string, string>;
  leaderAgentId?: string;
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

export class RuntimeApi {
  private server: Server | undefined;
  private memory?: SessionMemory;
  private readonly memoryDisabled: boolean;
  private memoryContext?: (
    agentId: string,
  ) => { scope?: MemoryScope; task?: MemoryTaskContext } | undefined;
  private pastedDocuments?: PastedDocuments;
  readonly activityColgrep = createColgrepProvider();
  private activityPreferences?: ActivityPreferences;

  setActivityPreferences(file: string): void {
    const preferences = new ActivityPreferences(file);
    this.activityPreferences = preferences;
    this.activityColgrep.setIndexingEnabled(preferences.enabled('rag-index'));
    this.memory?.setSummarizationEnabled(preferences.enabled('summarizer'));
  }
  private providerSubagents?: PaseoHost['listProviderSubagents'];

  setProviderSubagents(list: PaseoHost['listProviderSubagents']): void {
    this.providerSubagents = list;
  }

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
        request: WorkspaceSessionRequest & { leaderAgentId: string; savedModel?: ResolvedModel },
      ) => Promise<{ env: Record<string, string>; mcpServers?: Record<string, unknown> }>)
    | undefined;
  setPrepareSessionHandler(handler: NonNullable<RuntimeApi['prepareSession']>): void {
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
  private stopping = false;
  private workspaceMcp: WorkspaceMcp | undefined;
  private readonly sessionWorktrees: SessionWorktrees;
  readonly worktreeTool: ReturnType<typeof createSessionWorktreeTool>;
  setSessionMemory(memory: SessionMemory, context?: RuntimeApi['memoryContext']): void {
    this.memory = memory;
    memory.setSummarizationEnabled(this.activityPreferences?.enabled('summarizer') ?? true);
    this.memoryContext = context;
  }
  setPastedDocuments(documents: PastedDocuments): void {
    this.pastedDocuments = documents;
  }

  setWorkspaceMcp(mcp: WorkspaceMcp): void {
    this.workspaceMcp = mcp;
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
    startupEnvironment: NodeJS.ProcessEnv = process.env,
    private readonly telemetry?: Telemetry,
  ) {
    this.runtime = runtime;
    this.memoryDisabled =
      Number(startupEnvironment.LTCOOK_SESSION_MEMORY_THRESHOLD ?? '3000') === 0;
    this.startupShellEnvironment = captureShellEnvironment(startupEnvironment);
    this.sessionWorktrees = new SessionWorktrees(startupEnvironment.PATH ?? '');
    this.worktreeTool = createSessionWorktreeTool(this.sessionWorktrees, (context, passId) =>
      this.worktreeScope(context, passId),
    );
  }

  private worktreeScope(
    {
      sessionId,
      agentId,
      workspaceRoot,
    }: Pick<ToolContext, 'sessionId' | 'agentId' | 'workspaceRoot'>,
    requestedPassId?: string,
  ): WorktreeScope {
    if (!sessionId) {
      if (requestedPassId) throw new Error('This agent has no LTCook Pass.');
      return { sessionId: agentId, agentId, workspaceRoot };
    }
    const snapshot = this.runtime?.snapshot(sessionId);
    if (
      !snapshot?.members.some(
        ({ binding }) => binding?.state === 'bound' && binding.nativeAgentId === agentId,
      )
    )
      throw new Error('The agent is not bound to this session.');
    if (requestedPassId && !snapshot.passes.some(({ id }) => id === requestedPassId))
      throw new Error('The Pass does not belong to this session.');

    const running = snapshot.passes.filter(({ status }) => status === 'running');
    const runningIds = new Set(running.map(({ id }) => id));
    const focused = new Set(
      snapshot.assignments.flatMap((assignment) => {
        if (assignment.nativeAgentId !== agentId || assignment.status === 'reported') return [];
        const passId = snapshot.tasks.find(({ id }) => id === assignment.taskId)?.passId;
        return passId && runningIds.has(passId) ? [passId] : [];
      }),
    );
    const passId =
      requestedPassId ??
      (focused.size === 1 ? [...focused][0] : running.length === 1 ? running[0]?.id : undefined);
    return { sessionId, agentId, workspaceRoot: snapshot.session.workspaceRoot, passId };
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
    if (!(
      (request.method === 'POST' &&
        [
          '/v1/command',
          '/v1/snapshot',
          '/v1/session/open',
          '/v1/team/catalog',
          '/v1/model/catalog',
          '/v1/model/resolve',
          '/v1/session/list',
          '/v1/session/worktrees',
          '/v1/session/prepare',
          '/v1/runtime/stop',
          '/v1/tool/authorize',
          '/v1/ried',
          '/v1/workspace-tool',
          '/v1/session-memory/observe',
          '/v1/session-memory/paste',
          '/v1/activity/services',
          '/v1/activity/toggle',
          '/v1/activity/memory-evidence',
          '/v1/activity/memory-device',
          '/v1/activity/stored-summaries',
          '/v1/mcp/grant',
          '/v1/mcp/revoke',
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
      const maxBodyLength =
        request.url === '/v1/session-memory/paste'
          ? 2_097_152
          : request.url === '/v1/session/open'
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
        force?: unknown;
        turnId?: unknown;
        outcome?: unknown;
        local?: unknown;
        closed?: unknown;
        toolArgs?: unknown;
        input?: unknown;
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
        const scope = this.worktreeScope({ ...requestScope, agentId: nativeAgentId });
        const worktrees = await this.sessionWorktrees.read(scope, AbortSignal.timeout(3500));
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
      if (request.url === '/v1/activity/toggle') {
        if (!isUser) {
          response.writeHead(403).end('{}');
          return;
        }
        const { feature, enabled } = activityToggleRpc.input.parse(parsed);
        if (!this.activityPreferences || (feature === 'summarizer' && !this.memory)) {
          response.writeHead(503).end('{"error":"This Activity control is unavailable."}');
          return;
        }
        this.activityPreferences.set(feature, enabled);
        if (feature === 'summarizer') this.memory?.setSummarizationEnabled(enabled);
        else this.activityColgrep.setIndexingEnabled(enabled);
        response.writeHead(200).end(JSON.stringify({ enabled }));
        return;
      }
      if (request.url === '/v1/activity/memory-device') {
        if (!isUser) {
          response.writeHead(403).end('{}');
          return;
        }
        const { deviceId } = memoryDeviceRpc.input.parse(parsed);
        if (!this.memory) {
          response.writeHead(503).end('{"error":"Session Memory is unavailable."}');
          return;
        }
        const device = await this.memory.device(deviceId);
        response.writeHead(200).end(JSON.stringify(device));
        return;
      }
      if (request.url === '/v1/activity/memory-evidence') {
        if (!isUser) {
          response.writeHead(403).end('{}');
          return;
        }
        if (!this.memory) {
          response.writeHead(503).end('{"error":"Session Memory is unavailable."}');
          return;
        }
        const { agentId, after, ...record } = memoryEvidenceRpc.input.parse(parsed);
        const references = await this.memory.readEvidenceReferences(agentId, record, after);
        response.writeHead(200).end(JSON.stringify(references));
        return;
      }
      if (request.url === '/v1/activity/stored-summaries') {
        if (!isUser) {
          response.writeHead(403).end('{}');
          return;
        }
        const { agentId, before, includeContent, passage } = storedSummariesRpc.input.parse(parsed);
        if (!this.memory) {
          response.writeHead(503).end('{"error":"Session Memory is unavailable."}');
          return;
        }
        const page = await this.memory.readStoredSummaries(agentId, before, {
          includeContent,
          passage,
        });
        response.writeHead(200).end(JSON.stringify(page));
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
      if (request.url === '/v1/activity/services') {
        if (actor.kind !== 'user') {
          response.writeHead(403).end('{}');
          return;
        }
        const agentId = input.nativeAgentId;
        if (typeof agentId !== 'string' || !agentId) {
          response.writeHead(400).end('{}');
          return;
        }
        const timelineEpoch =
          'timelineEpoch' in parsed && typeof parsed.timelineEpoch === 'string'
            ? parsed.timelineEpoch
            : undefined;
        const session = input.sessionId ? this.runtime?.snapshot(input.sessionId) : undefined;
        if (
          session &&
          !session.members.some(
            ({ binding }) => binding?.state === 'bound' && binding.nativeAgentId === agentId,
          )
        ) {
          response.writeHead(403).end('{}');
          return;
        }
        const registeredWorkspace = session && this.sessions.get(session.session.id);
        const workspace = session
          ? registeredWorkspace === session.session.workspaceRoot
            ? await openRepositoryWorkspace(registeredWorkspace)
                .then((opened) => (opened.root === registeredWorkspace ? opened : undefined))
                .catch(() => undefined)
            : undefined
          : await this.workspaceMcp?.repositorySearchWorkspace(agentId);
        const [rag, subagents] = await Promise.all([
          workspace
            ? this.activityColgrep.readStatus(workspace)
            : {
                availability: 'unavailable',
                activity: 'unknown',
                diagnostic: 'Repository search scope is unavailable.',
              },
          this.providerSubagents?.(agentId).catch(() => undefined),
        ]);
        const memory = this.memory?.status(session?.session.id, agentId, timelineEpoch);
        const assignment = session?.assignments.find(
          (value) =>
            value.nativeAgentId === agentId &&
            (value.status === 'sending' || value.status === 'sent'),
        );
        const task = session?.tasks.find((value) => value.id === assignment?.taskId);
        response.writeHead(200).end(
          JSON.stringify({
            rag: {
              ...rag,
              indexingEnabled: this.activityPreferences?.enabled('rag-index') ?? null,
            },
            task: task?.title,
            subagents,
            workspace: workspace && { root: workspace.root, identity: workspace.identity },
            memory,
            memoryDisabled: this.memoryDisabled,
          }),
        );
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
      if (request.url === '/v1/session/open' && actor.kind !== 'user') {
        response.writeHead(403).end('{"error":"user authentication required"}');
        return;
      }
      if (this.stopping) {
        response.writeHead(503).end('{"error":"LTCook runtime is stopping"}');
        return;
      }
      const runtime = this.runtime;
      if (request.url === '/v1/session/open') {
        await this.handleSessionOpen(input, response);
        return;
      }
      if (!runtime) {
        response.writeHead(503).end('{"error":"LTCook runtime is not ready"}');
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
          ...(Object.hasOwn(parsed, 'savedModel')
            ? {
                savedModel: ResolvedModelSchema.parse(
                  (parsed as Record<string, unknown>).savedModel,
                ),
              }
            : {}),
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
          const catalog = runtime.teamCatalog();
          const sessions = runtime
            .listSessions(input.workspaceRoot, input.teamSelection)
            .map((session) => {
              const selected = catalog.find((team) => team.teamId === session.teamId);
              if (selected?.status !== 'installed')
                return {
                  sessionId: session.id,
                  teamId: session.teamId,
                  workspaceRoot: session.workspaceRoot,
                  createdAt: session.createdAt,
                  leaderAgentId: null,
                  blocker: `Saved Team ${session.teamId} is unavailable or invalid; rebuild or reinstall its local package before resuming this Session.`,
                };
              const snapshot = runtime.snapshot(session.id);
              const leader = snapshot.members.find(
                (item) => item.member.key === snapshot.definition.leaderKey,
              )?.binding;
              return {
                sessionId: session.id,
                teamId: session.teamId,
                workspaceRoot: session.workspaceRoot,
                createdAt: session.createdAt,
                leaderAgentId: leader?.nativeAgentId ?? null,
                ...(leader?.state !== 'bound' || !leader.nativeAgentId
                  ? {
                      blocker:
                        leader?.blocker ??
                        'Leader binding is unavailable; inspect this Session before starting a replacement.',
                    }
                  : {}),
              };
            });
          response.writeHead(200).end(JSON.stringify({ sessions }));
        }
        return;
      }
      if (request.url === '/v1/workspace-tool') {
        const toolName = input.toolName;
        const repositorySearch = isRepositoryTool(toolName);
        if (
          actor.kind !== 'agent' ||
          !input.sessionId ||
          !this.workspaceMcp ||
          !(
            repositorySearch ||
            isWebTool(toolName) ||
            toolName === SESSION_MEMORY_TOOL_NAME ||
            toolName === WORKTREE_TOOL_NAME
          ) ||
          !input.toolArgs ||
          typeof input.toolArgs !== 'object' ||
          Array.isArray(input.toolArgs)
        ) {
          response.writeHead(403).end('{}');
          return;
        }
        const session = runtime.snapshot(input.sessionId);
        if (
          !session.members.some(
            (member) =>
              member.binding?.nativeAgentId === actor.nativeAgentId &&
              member.binding.state === 'bound',
          )
        ) {
          response.writeHead(403).end('{}');
          return;
        }
        const authorization = runtime.authorizeTool(
          input.sessionId,
          actor.nativeAgentId,
          toolName,
          input.toolArgs as Record<string, unknown>,
        );
        if (!authorization.allowed) {
          response.writeHead(403).end(JSON.stringify({ error: authorization.reason }));
          return;
        }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        response.once('close', cancel);
        try {
          const timeoutMs =
            toolName === SESSION_MEMORY_TOOL_NAME
              ? 5_000
              : repositorySearch
                ? REPO_SEARCH_TIMEOUT_MS + 5_000
                : 120_000;
          const result = await this.workspaceMcp.invokeTool(toolName, input.toolArgs, {
            agentId: actor.nativeAgentId,
            workspaceRoot: session.session.workspaceRoot,
            sessionId: input.sessionId,
            workspaceFileAccess: false,
            repositorySearchAccess: repositorySearch,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
          });
          response.writeHead(200).end(JSON.stringify(result));
        } finally {
          response.off('close', cancel);
        }
        return;
      }
      if (request.url === '/v1/ried') {
        if (!input.sessionId) throw new Error('RIED requires a Session');
        const {
          sessionId: _sessionId,
          nativeAgentId: _nativeAgentId,
          ...toolArgs
        } = parsed as Record<string, unknown>;
        const inventoryRequest = validateRiedRequest(toolArgs);
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
        const value = await runtime.ried(input.sessionId, inventoryRequest);
        response.writeHead(200).end(JSON.stringify({ value }));
        return;
      }
      if (request.url === '/v1/snapshot') {
        if (actor.kind === 'user') {
          const requestedWorkspace = input.workspaceRoot
            ? canonicalWorkspace(input.workspaceRoot)
            : undefined;
          const sessionId = input.sessionId;
          if (!sessionId) {
            response
              .writeHead(404)
              .end('{"error":"No session found for workspace","code":"SESSION_NOT_FOUND"}');
            return;
          }
          const registeredWorkspace = this.sessions.get(sessionId);
          if (!registeredWorkspace) {
            if (
              !requestedWorkspace ||
              typeof input.teamSelection !== 'string' ||
              !input.teamSelection ||
              typeof input.leaderAgentId !== 'string' ||
              !input.leaderAgentId
            )
              throw new Error('Session is not active in this runtime');
            const snapshot = runtime.snapshot(sessionId);
            const selected = runtime
              .teamCatalog()
              .find(
                (team) =>
                  team.status === 'installed' &&
                  (team.selection === input.teamSelection || team.teamId === input.teamSelection),
              );
            const leader = snapshot.members.find(
              (member) => member.member.key === snapshot.definition.leaderKey,
            );
            if (
              selected?.teamId !== snapshot.session.teamId ||
              requestedWorkspace !== canonicalWorkspace(snapshot.session.workspaceRoot) ||
              leader?.binding?.state !== 'bound' ||
              leader.binding.nativeAgentId !== input.leaderAgentId
            )
              throw new Error('Saved Session identity does not match its native Leader');
            // > History reads retain metadata without activating or reconciling native agents.
            response.writeHead(200).end(JSON.stringify(snapshot));
            return;
          }
          if (requestedWorkspace && registeredWorkspace !== requestedWorkspace)
            throw new Error('Session does not belong to the requested workspace');
          const snapshot = runtime.snapshot(sessionId);
          if (canonicalWorkspace(snapshot.session.workspaceRoot) !== registeredWorkspace)
            throw new Error('Session does not belong to its registered workspace');
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
  private async handleSessionOpen(
    input: {
      workspaceRoot?: string;
      sessionId?: string;
      teamSelection?: string;
      leaderAgentId?: string;
      shellEnvironment?: unknown;
    },
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    const runtime = this.runtime;
    const openWorkspace = this.openWorkspace;
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
      response.writeHead(409).end('{"error":"Session is already bound to a different workspace"}');
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
            (team) => team.selection === input.teamSelection || team.teamId === input.teamSelection,
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
          .end('{"error":"Session initialization is already requested for a different workspace"}');
        return;
      }
      if (!entry) {
        const pending = openWorkspace({
          workspaceRoot,
          sessionId: input.sessionId,
          teamSelection: input.teamSelection,
          ...(input.leaderAgentId ? { leaderAgentId: input.leaderAgentId } : {}),
          shellEnvironment: captureShellEnvironment(
            shell === undefined ? this.startupShellEnvironment : (shell as Record<string, string>),
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
          (team) => team.selection === input.teamSelection || team.teamId === input.teamSelection,
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
            this.sessions.get(request.sessionId) !== canonicalWorkspace(request.workspaceRoot)
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
