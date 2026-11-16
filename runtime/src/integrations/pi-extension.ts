import type { GuidanceInspection } from '../guidance-api/index.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { setTimeout } from 'node:timers';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentRuntimeCommandInputSchema } from '../workflow-api/commands.js';
import { Type } from 'typebox';
import { RiedService, type RiedRequest } from '../ried.js';
import { loadTeam } from './team-loader.js';
import { nativeToolAllowed } from './native-policy.js';
import { decisionTitle, readPlanForApproval } from './planning-dialogs.js';
import { evaluationToolError, sanitizeEvaluationText } from '../evals/diagnostics.js';
import { EVAL_MODEL, EVALUATION_EXECUTION_CONTEXT } from '../evals/setup.js';
import { ollamaCoordinationPayload } from '../evals/ollama-schema.js';
const require = createRequire(import.meta.url);
async function activateOptionalBrowser(pi: ExtensionAPI): Promise<void> {
  if (process.env.LTCOOK_BROWSER_ENABLED !== 'true') return;
  try {
    const extensionPath =
      require.resolve('pi-agent-browser-native/dist/extensions/agent-browser/index.js');
    const extension = (await import(pathToFileURL(extensionPath).href)) as {
      default?: (api: ExtensionAPI) => void | Promise<void>;
    };
    if (typeof extension.default !== 'function')
      throw new Error('Native browser extension entrypoint unavailable');
    await extension.default(pi);
  } catch {
    console.warn(
      'Optional native browser extension failed to load; core chat and search remain available.',
    );
  }
}

export default async function activate(
  pi: ExtensionAPI,
  inspection?: () => GuidanceInspection,
): Promise<void> {
  const nativeAgentId = process.env.LTCOOK_NATIVE_AGENT_ID;
  const sessionId = process.env.LTCOOK_SESSION_ID;
  const teamInstanceId = process.env.LTCOOK_TEAM_INSTANCE_ID;
  const teamId = process.env.LTCOOK_TEAM_ID;
  const memberKey = process.env.LTCOOK_MEMBER_KEY;
  const endpoint = process.env.LTCOOK_RUNTIME_API_URL;
  const token = process.env.LTCOOK_AGENT_API_TOKEN;
  const teamSelection = process.env.LTCOOK_TEAM;
  if (
    !nativeAgentId ||
    !sessionId ||
    !teamInstanceId ||
    !teamId ||
    !memberKey ||
    !endpoint ||
    !token ||
    !teamSelection
  ) {
    if (nativeAgentId)
      throw new Error('Managed native identity and authenticated runtime context are incomplete.');
    return;
  }

  const team = await loadTeam(teamSelection);
  if (team.definition.id !== teamId)
    throw new Error('Selected native team does not match the active session');
  const rpc = async (
    pathname: string,
    payload: Record<string, unknown>,
    timeoutMs = 3000,
  ): Promise<Response> =>
    fetch(`${endpoint}${pathname}`, {
      signal: globalThis.AbortSignal.timeout(
        pathname === '/v1/ried' ? 30000 : timeoutMs,
      ) as NonNullable<Parameters<typeof fetch>[1]>['signal'],
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, nativeAgentId, ...payload }),
    });
  const evaluation = Boolean(process.env.LTCOOK_EVAL_ARM);
  const observe = async (value: Record<string, unknown>) => {
    const response = await rpc('/v1/evaluation/observe', value);
    if (!response.ok) throw new Error('Evaluation observation unavailable');
  };
  if (evaluation) {
    let compacting = false;
    let providerStreamError: string | undefined;
    pi.on('session_before_compact', async (event) => {
      compacting = true;
      await observe({
        kind: 'compaction.start',
        phase: 'compaction',
        reason: event.reason,
        willRetry: event.willRetry,
        tokensBefore: event.preparation.tokensBefore,
      });
    });
    pi.on('session_compact', async (event) => {
      compacting = false;
      await observe({
        kind: 'compaction.end',
        phase: 'compaction',
        reason: event.reason,
        willRetry: event.willRetry,
        fromExtension: event.fromExtension,
        tokensBefore: event.compactionEntry.tokensBefore,
        usage: event.compactionEntry.usage,
      });
    });
    pi.on('session_compact_failed', async (event, context) => {
      compacting = false;
      try {
        await observe({
          kind: 'compaction.failed',
          phase: 'compaction',
          reason: event.reason,
          willRetry: event.willRetry,
          fromExtension: event.fromExtension,
          aborted: event.aborted,
          error: sanitizeEvaluationText(
            event.errorMessage ?? (event.aborted ? 'Compaction aborted' : 'Compaction failed'),
          ),
        });
      } finally {
        context.abort();
      }
    });
    // > Validation rejects before tool_result hooks; bound their feedback before the next request.
    pi.on('context', async (event) => ({
      messages: event.messages.map((message) => {
        if (message.role !== 'toolResult' || !message.isError) return message;
        const reason = evaluationToolError(message);
        if (!reason?.startsWith('Validation failed for tool ')) return message;
        return { ...message, content: [{ type: 'text' as const, text: reason }] };
      }),
    }));
    pi.on('agent_start', async (_event, context) => {
      await observe({ kind: 'agent.start' });
      await observe({ kind: 'prompt', prompt: context.getSystemPrompt() });
    });
    pi.on('agent_end', async () => {
      await observe({ kind: 'agent.end' });
    });
    pi.on('agent_settled', async () => {
      await observe({ kind: 'agent.settled' });
    });
    pi.on('before_provider_request', async (event, context) => {
      if (
        context.model?.id !== EVAL_MODEL ||
        context.model.provider !== 'ollama' ||
        context.model.baseUrl !== `${process.env.LTCOOK_EVAL_ENDPOINT}/v1`
      )
        throw new Error('Evaluation model pin violation');
      if (!compacting) {
        const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
        const effort = 'reasoning_effort' in payload ? payload.reasoning_effort : undefined;
        const outputLimit = 'max_tokens' in payload ? payload.max_tokens : undefined;
        const tools =
          'tools' in payload && Array.isArray(payload.tools) ? payload.tools : undefined;
        const messages =
          'messages' in payload && Array.isArray(payload.messages) ? payload.messages : undefined;
        await observe({
          kind: 'model.start',
          reasoningEffort:
            effort === 'none' || effort === 'low' || effort === 'high'
              ? effort
              : effort === undefined
                ? 'omitted'
                : 'other',
          ...(typeof outputLimit === 'number' ? { outputLimit } : {}),
          ...(tools ? { toolCount: tools.length } : {}),
          ...(messages ? { messageCount: messages.length } : {}),
        });
      }
      return ollamaCoordinationPayload(event.payload);
    });
    pi.on('before_provider_headers', (event) => {
      providerStreamError = undefined;
      event.headers['x-ltcook-member'] = memberKey;
    });
    pi.on('after_provider_response', async (event) => {
      await observe({ kind: 'model.response', status: event.status });
    });
    pi.on('provider_stream_event', async (event) => {
      if (!event.data || typeof event.data !== 'object') return;
      const data = event.data as Record<string, unknown>;
      let streamError: string | undefined;
      if (data.error) {
        const error = data.error;
        streamError = sanitizeEvaluationText(
          typeof error === 'string'
            ? error
            : typeof error === 'object' && 'message' in error && typeof error.message === 'string'
              ? error.message
              : 'Provider stream returned an error without a message',
        );
        providerStreamError = streamError;
      }
      const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
      const rawStopReason =
        choice && typeof choice === 'object' && typeof choice.finish_reason === 'string'
          ? choice.finish_reason
          : typeof data.done_reason === 'string'
            ? data.done_reason
            : undefined;
      const usage =
        data.usage && typeof data.usage === 'object'
          ? (data.usage as Record<string, unknown>)
          : undefined;
      if (!streamError && !rawStopReason && !usage && data.done !== true) return;
      await observe({
        kind: 'model.stream',
        ...(rawStopReason ? { rawStopReason } : {}),
        ...(streamError ? { error: streamError } : {}),
        ...(usage
          ? {
              usage: {
                input: usage.prompt_tokens,
                output: usage.completion_tokens,
                totalTokens: usage.total_tokens,
              },
            }
          : {}),
      });
    });
    pi.on('message_end', async (event) => {
      if (event.message.role === 'assistant')
        await observe({
          kind: 'model.end',
          usage: event.message.usage,
          stopReason: event.message.stopReason,
          rawStopReason: event.message.rawStopReason,
          ...(event.message.errorMessage
            ? {
                error: sanitizeEvaluationText(
                  `${event.message.errorMessage}${providerStreamError ? `; provider stream: ${providerStreamError}` : ''}`,
                ),
              }
            : {}),
        });
    });
    const fixtureVerifications = new Set<string>();
    pi.on('tool_execution_start', async (event) => {
      if (
        event.toolName === 'bash' &&
        typeof event.args?.command === 'string' &&
        /(?:^|&&|;)\s*node\s+\.ltcook-evals\/verify\.cjs(?=\s|;|$)/.test(event.args.command)
      )
        fixtureVerifications.add(event.toolCallId);
      await observe({ kind: 'tool.start', tool: event.toolName, callId: event.toolCallId });
    });
    pi.on('tool_execution_end', async (event) => {
      await observe({
        kind: 'tool.end',
        tool: event.toolName,
        callId: event.toolCallId,
        durationMs: event.durationMs,
        fixtureVerification:
          fixtureVerifications.delete(event.toolCallId) &&
          Array.isArray(event.result.content) &&
          event.result.content.some(
            (block: unknown) =>
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'text' &&
              'text' in block &&
              typeof block.text === 'string' &&
              block.text.includes('LTCook fixture verification passed'),
          ),
        isError: event.isError,
        ...(event.isError ? { error: evaluationToolError(event.result) } : {}),
      });
    });
  }
  const member = team.definition.members.find((candidate) => candidate.key === memberKey);
  if (!member) throw new Error('Native agent identity is not a member of the selected team');
  const publishGuidance = async (waitUntilReady = false) => {
    if (!inspection) throw new Error('Managed native guidance inspection is unavailable.');
    const response = await rpc(
      '/v1/command',
      {
        command: {
          type: 'guidance.loaded',
          inspection: inspection(),
          ...(waitUntilReady ? { waitUntilReady: true } : {}),
        },
      },
      waitUntilReady ? 25_000 : 3000,
    );
    if (!response.ok) throw new Error(`Native guidance registration failed (${response.status}).`);
  };
  pi.on('session_start', () => {
    // > Agent creation precedes Core binding. Retry only this idempotent inspection publication.
    let attempts = 0;
    const publish = async () => {
      try {
        await publishGuidance();
      } catch {
        attempts += 1;
        if (attempts < 5)
          setTimeout(() => {
            void publish();
          }, 1000);
        else
          console.error(
            'Native guidance loaded, but runtime inspection publication is unavailable.',
          );
      }
    };
    void publish();
  });
  pi.on('input', async (_event, context) => {
    try {
      await publishGuidance(true);
    } catch {
      // > Pi reports before_agent_start exceptions and continues; handled input stops this prompt.
      context.ui.notify(
        'LTCook Session initialization is unavailable. Check the Team status and retry your message.',
        'error',
      );
      return { action: 'handled' };
    }
    return undefined;
  });
  pi.on('before_agent_start', async (event) => {
    await publishGuidance(true);
    if (!evaluation) return;
    try {
      const response = await rpc('/v1/evaluation/observe', { kind: 'scope.request' });
      if (!response.ok)
        throw new Error(`Evaluation scope confirmation failed (${response.status})`);
      const confirmation: unknown = await response.json();
      const scope =
        confirmation && typeof confirmation === 'object' && 'evaluationScope' in confirmation
          ? confirmation.evaluationScope
          : undefined;
      if (
        !scope ||
        typeof scope !== 'object' ||
        !('sessionId' in scope) ||
        scope.sessionId !== sessionId ||
        !('passId' in scope) ||
        typeof scope.passId !== 'string' ||
        !scope.passId
      )
        throw new Error('Evaluation scope confirmation does not match this disposable session');
      return {
        systemPrompt: `${event.systemPrompt}\n\n${EVALUATION_EXECUTION_CONTEXT}\nSession: ${sessionId}. Pass: ${scope.passId}.`,
      };
    } catch {
      const reason = 'Authenticated evaluation execution scope confirmation failed';
      // > Native hooks log exceptions; notify the worker so it can terminate the failed case.
      await observe({ kind: 'runtime.error', operation: 'evaluation.scope', error: reason }).catch(
        () => undefined,
      );
      throw new Error(reason);
    }
  });
  pi.on('tool_call', async (event, ctx) => {
    if (!nativeToolAllowed(member.readOnly, event.toolName))
      return { block: true, reason: 'This team member is restricted to read-only exploration.' };
    try {
      // > Native new/resume may change cwd; authorize exactly the path the tool will use.
      const input =
        ['write', 'edit'].includes(event.toolName) &&
        'path' in event.input &&
        typeof event.input.path === 'string' &&
        !path.isAbsolute(event.input.path)
          ? { ...event.input, path: path.resolve(ctx.cwd, event.input.path) }
          : event.input;
      const response = await rpc('/v1/tool/authorize', {
        toolName: event.toolName,
        input,
      });
      if (!response.ok)
        return { block: true, reason: `Runtime authorization unavailable (${response.status}).` };
      const authorization = (await response.json()) as { allowed?: boolean; reason?: string };
      if (authorization.allowed !== true)
        return { block: true, reason: authorization.reason ?? 'Runtime denied tool execution.' };
    } catch {
      return {
        block: true,
        reason: 'Runtime authorization unavailable; tool execution is blocked.',
      };
    }
    return undefined;
  });
  pi.registerTool({
    name: 'ltcook_team',
    label: 'Team coordination',
    description:
      'Coordinate LTCook work through the runtime. Call this native tool directly with one command object; command.type selects the operation. task.create registers work and requires title, description, acceptance and the active passId for execution. For scheduled work, submit report.create with assignmentId, summary, evidence and outcome="success" or "failure"; the runtime owns its Task status. task.update can complete the unscheduled leader handoff using taskId and status="completed". guidance.inspect reads loaded guidance. Shell commands do not submit coordination operations. Runtime authorization and member restrictions still apply.',
    parameters: AgentRuntimeCommandInputSchema,
    async execute(_id, input, _signal, _onUpdate, ctx) {
      // > Native Pi validates the narrower projection of the shared command schema.
      const command = input.command;
      const response = await rpc('/v1/command', { command });
      if (evaluation)
        await observe({
          kind: 'runtime.command',
          commandType: command.type,
          status: response.status,
          ...(command.type === 'task.update' && command.status
            ? { taskStatus: command.status }
            : {}),
          hasPassId:
            'passId' in command && typeof command.passId === 'string' && command.passId.length > 0,
        });
      if (!response.ok) {
        let reason: string | undefined;
        if (evaluation) {
          const error: unknown = await response.json().catch(() => undefined);
          if (
            error &&
            typeof error === 'object' &&
            'error' in error &&
            typeof error.error === 'string'
          )
            reason = sanitizeEvaluationText(error.error);
          await observe({
            kind: 'runtime.error',
            operation: 'coordination',
            commandType: command.type,
            status: response.status,
            hasPassId:
              'passId' in command &&
              typeof command.passId === 'string' &&
              command.passId.length > 0,
            ...(reason ? { error: reason } : {}),
          });
        }
        throw new Error(
          `Coordination request failed (${response.status})${reason ? `: ${reason}` : ''}`,
        );
      }
      const result: unknown = await response.json();
      const value = (
        result as {
          value?: { id?: string; stage?: string; answer?: string; plan?: { path?: string } };
        }
      ).value;
      if (command.type === 'decision.create' && value?.id && value.answer === undefined) {
        await ctx.ui.input(
          decisionTitle(
            { sessionId, planId: command.planId, decisionId: value.id, kind: 'question' },
            command.prompt,
          ),
        );
      } else if (command.type === 'planning.submit' && value?.stage === 'awaiting-approval') {
        if (!value.plan?.path)
          throw new Error('Registered Plan path is unavailable; approval remains pending.');
        await ctx.ui.confirm(
          decisionTitle(
            { sessionId, planId: command.planId, decisionId: '', kind: 'approval' },
            `Approve Plan ${command.planId}?`,
          ),
          readPlanForApproval(value.plan.path),
        );
      }
      const serialized = JSON.stringify(result);
      if (serialized === undefined) throw new Error('Coordination response could not be encoded.');
      return { content: [{ type: 'text', text: serialized }], details: result };
    },
  });
  registerRiedTool(pi, async (input) => {
    const response = await rpc('/v1/ried', input);
    if (!response.ok) throw new Error(`RIED request failed (${response.status})`);
    return response.json();
  });
  await activateOptionalBrowser(pi);
}

/** Register the same read-only inventory contract for managed and standalone Pi. */
function registerRiedTool(
  pi: ExtensionAPI,
  read: (request: RiedRequest) => Promise<unknown>,
): void {
  pi.registerTool({
    name: 'ltcook_ried',
    label: 'Repository and environment inventory',
    description: 'Read a bounded inventory of this chat workspace or refresh it.',
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal('summary'),
        Type.Literal('section'),
        Type.Literal('refresh'),
      ]),
      section: Type.Optional(
        Type.Union([
          Type.Literal('repository'),
          Type.Literal('git'),
          Type.Literal('host'),
          Type.Literal('recipes'),
        ]),
      ),
    }),
    async execute(_id, input) {
      const result = await read(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}

/** Bind standalone inventory to the native runtime workspace, without Team authority. */
export function activateStandaloneRied(
  pi: ExtensionAPI,
  workspaceRoot: string,
  sessionId: string,
): void {
  const cache = process.env.LTCOOK_RIED_CACHE_DIR;
  const brief = process.env.LTCOOK_BRIEF_EXECUTABLE;
  if (!cache || !path.isAbsolute(cache) || !brief || !path.isAbsolute(brief)) return;
  const service = new RiedService(cache, brief, () => ({ PATH: process.env.PATH ?? '' }));
  registerRiedTool(pi, async (request) => ({
    value: await service.get({ id: sessionId, workspaceRoot }, request),
  }));
}
