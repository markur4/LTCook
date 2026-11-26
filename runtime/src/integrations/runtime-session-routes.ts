import type { ServerResponse } from 'node:http';
import { canonicalWorkspace } from '../core/workspace.js';
import { ResolvedModelSchema, type ResolvedModel } from '../models/aliases.js';
import { isRuntimeCommand } from '../workflow-api/commands.js';
import type { CreateAgentOptions, RuntimeActor, RuntimeController } from '../workflow-api/index.js';
import type { SessionActivation } from './session-activation.js';

export const SESSION_OPEN_PATH = '/v1/session/open';

export type PrepareSession = (
  options: CreateAgentOptions,
  leaderAgentId: string,
  savedModel?: ResolvedModel,
) => Promise<{ env: Record<string, string>; mcpServers?: Record<string, unknown> }>;

type SessionRuntime = Pick<
  RuntimeController,
  'snapshot' | 'teamCatalog' | 'listSessions' | 'execute'
>;

interface SessionRouteBody {
  sessionId?: string;
  workspaceRoot?: string;
  teamSelection?: string;
  leaderAgentId?: string;
  shellEnvironment?: unknown;
  savedModel?: unknown;
  command?: unknown;
}

interface SessionRouteServices {
  runtime: SessionRuntime;
  activation: SessionActivation;
  prepareSession?: PrepareSession;
}

type SessionHandler = (
  input: SessionRouteBody,
  response: ServerResponse,
  actor: RuntimeActor,
  services: SessionRouteServices,
) => void | Promise<void>;

const sessionRoutes = {
  async [SESSION_OPEN_PATH](input, response, _actor, { runtime, activation }) {
    const { workspaceRoot, sessionId, teamSelection, leaderAgentId, shellEnvironment } = input;
    if (
      typeof workspaceRoot !== 'string' ||
      !workspaceRoot ||
      typeof sessionId !== 'string' ||
      !sessionId ||
      typeof teamSelection !== 'string' ||
      !teamSelection ||
      (shellEnvironment !== undefined &&
        (!shellEnvironment ||
          typeof shellEnvironment !== 'object' ||
          Array.isArray(shellEnvironment) ||
          !Object.values(shellEnvironment).every((value) => typeof value === 'string')))
    ) {
      response
        .writeHead(400)
        .end(
          '{"error":"workspaceRoot, sessionId and teamSelection are required; shellEnvironment must be a string mapping when supplied"}',
        );
      return;
    }
    const result = await activation.open(runtime, {
      workspaceRoot,
      sessionId,
      teamSelection,
      leaderAgentId,
      shellEnvironment: shellEnvironment as Record<string, string> | undefined,
    });
    if ('conflict' in result) {
      response.writeHead(409).end(JSON.stringify({ error: result.conflict }));
      return;
    }
    const { snapshot } = result;
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
  },
  async '/v1/session/prepare'(input, response, actor, { runtime, prepareSession }) {
    if (actor.kind !== 'user') {
      response.writeHead(403).end('{"error":"user authentication required"}');
      return;
    }
    if (!prepareSession) throw new Error('Session preparation is not ready');
    const { sessionId, workspaceRoot, teamSelection, leaderAgentId } = input;
    if (!sessionId || !workspaceRoot || !teamSelection || leaderAgentId !== sessionId)
      throw new Error('Explicit Session Leader identity is required');
    const snapshot = runtime.snapshot(sessionId);
    const team = runtime
      .teamCatalog()
      .find((entry) => entry.selection === teamSelection || entry.teamId === teamSelection);
    const leader = snapshot.members.find(
      (item) => item.member.key === snapshot.definition.leaderKey,
    );
    if (
      !team ||
      snapshot.session.teamId !== team.teamId ||
      canonicalWorkspace(workspaceRoot) !== snapshot.session.workspaceRoot ||
      !leader ||
      leader.binding?.nativeAgentId !== leaderAgentId
    )
      throw new Error('Session preparation identity does not match its binding');
    const savedModel = Object.hasOwn(input, 'savedModel')
      ? ResolvedModelSchema.parse(input.savedModel)
      : undefined;
    const prepared = await prepareSession(
      {
        member: leader.member,
        sessionId: snapshot.session.id,
        teamInstanceId: snapshot.session.teamInstanceId,
        teamId: snapshot.session.teamId,
        workspaceRoot: snapshot.session.workspaceRoot,
      },
      leaderAgentId,
      savedModel,
    );
    response.writeHead(200).end(JSON.stringify(prepared));
  },
  '/v1/team/catalog'(_input, response, actor, { runtime }) {
    if (actor.kind !== 'user') {
      response.writeHead(403).end('{"error":"user authentication required"}');
      return;
    }
    response.writeHead(200).end(JSON.stringify({ teams: runtime.teamCatalog() }));
  },
  '/v1/session/list'(input, response, actor, { runtime }) {
    if (actor.kind !== 'user') {
      response.writeHead(403).end('{"error":"user authentication required"}');
      return;
    }
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
  },
  '/v1/snapshot'(input, response, actor, { runtime, activation }) {
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
      const registeredWorkspace = activation.registeredWorkspace(sessionId);
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
    const snapshot = runtime.snapshot(input.sessionId);
    if (
      !snapshot.members.some(
        (member) =>
          member.binding?.nativeAgentId === actor.nativeAgentId && member.binding.state === 'bound',
      )
    )
      throw new Error('Native agent is not bound to this session');
    response.writeHead(200).end(JSON.stringify(snapshot));
  },
  async '/v1/command'(input, response, actor, { runtime, activation }) {
    if (!input.sessionId || !isRuntimeCommand(input.command))
      throw new Error('sessionId and a valid runtime command are required');
    const metadataRecovery =
      actor.kind === 'user' &&
      ['planning.show', 'planning.questions', 'decision.answer'].includes(input.command.type);
    const snapshot = runtime.snapshot(input.sessionId);
    if (metadataRecovery && activation.registeredWorkspace(input.sessionId) === undefined)
      activation.register(snapshot.session.workspaceRoot, input.sessionId);
    if (actor.kind === 'agent') {
      const bound = snapshot.members.some(
        (member) =>
          member.binding?.nativeAgentId === actor.nativeAgentId && member.binding.state === 'bound',
      );
      if (!bound) {
        response.writeHead(403).end('{"error":"native agent is not bound to this session"}');
        return;
      }
    } else if (
      activation.registeredWorkspace(input.sessionId) !==
      canonicalWorkspace(snapshot.session.workspaceRoot)
    ) {
      response.writeHead(403).end('{"error":"session is not active in this runtime"}');
      return;
    }
    const value = await runtime.execute(input.sessionId, actor, input.command);
    response.writeHead(200).end(JSON.stringify({ value }));
  },
} satisfies Record<string, SessionHandler>;

type SessionRoute = keyof typeof sessionRoutes;

export function isSessionRoute(path: string | undefined): path is SessionRoute {
  return path !== undefined && Object.hasOwn(sessionRoutes, path);
}

export function handleSessionRoute(
  route: SessionRoute,
  parsed: object,
  response: ServerResponse,
  actor: RuntimeActor,
  services: Omit<SessionRouteServices, 'runtime'> & { runtime: SessionRuntime | undefined },
): void | Promise<void> {
  const { runtime, activation } = services;
  if (route === SESSION_OPEN_PATH && (!runtime || !activation.ready)) {
    response.writeHead(503).end('{"error":"Runtime session activation is not ready"}');
    return;
  }
  if (!runtime) {
    response.writeHead(503).end('{"error":"LTCook runtime is not ready"}');
    return;
  }
  return sessionRoutes[route](parsed as SessionRouteBody, response, actor, {
    ...services,
    runtime,
  });
}
