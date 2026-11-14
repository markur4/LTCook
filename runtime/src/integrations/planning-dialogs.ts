import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { createHostClient } from '@getpaseo/client/node';
import type { DecisionPresentation, RuntimeController } from '../workflow-api/index.js';
import type { PaseoHost } from './paseo.js';

type DaemonEvent = Parameters<Parameters<ReturnType<typeof createHostClient>['subscribe']>[0]>[0];
export type PlanningDialogEvent = Extract<
  DaemonEvent,
  { type: 'agent_permission_request' | 'agent_permission_resolved' }
>;
type DialogContext = Omit<DecisionPresentation, 'nativeAgentId' | 'requestId'>;
const PREFIX = '[LTCook decision ';
export function decisionTitle(context: DialogContext, prompt: string): string {
  return `${PREFIX}${Buffer.from(JSON.stringify(context)).toString('base64url')}] ${prompt}`;
}

/** Read only the bounded registered Plan for presentation; this creates no stored document revision. */
export function readPlanForApproval(filePath: string): string {
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error('Registered Plan is not a regular file');
    const buffer = Buffer.alloc(256 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length === 0 || length === buffer.length)
      throw new Error('Plan presentation requires a nonempty document of at most 256 KiB');
    return `Plan: ${filePath}\n\n${buffer.subarray(0, length).toString('utf8')}`;
  } finally {
    closeSync(descriptor);
  }
}

/** Consume only authenticated parent-host events; native tool return values are never answers. */
export function connectPlanningDialogs(
  host: Pick<PaseoHost, 'subscribePlanningDialogs'>,
  runtime: RuntimeController,
): () => void {
  const bindings = new Map<
    string,
    { sessionId: string; nativeAgentId: string; requestId: string; kind?: 'question' | 'approval' }
  >();
  return host.subscribePlanningDialogs(async (event) => {
    if (event.type === 'agent_permission_request') {
      if (event.request.kind !== 'question' || event.request.provider !== 'pi') return;
      const title = event.request.title;
      if (!title?.startsWith(PREFIX)) return;
      const end = title.indexOf('] ', PREFIX.length);
      if (end < 0) return;
      const context: unknown = JSON.parse(
        Buffer.from(title.slice(PREFIX.length, end), 'base64url').toString(),
      );
      if (!context || typeof context !== 'object') return;
      const input = context as Record<string, unknown>;
      if (
        typeof input.sessionId !== 'string' ||
        typeof input.planId !== 'string' ||
        typeof input.decisionId !== 'string' ||
        (input.kind !== 'question' && input.kind !== 'approval')
      )
        return;
      const snapshot = runtime.snapshot(input.sessionId);
      const plan = snapshot.planning.find((item) => item.id === input.planId);
      if (!plan) return;
      const prompt =
        input.kind === 'question'
          ? snapshot.decisions.find(
              (item) => item.id === input.decisionId && item.planId === input.planId,
            )?.prompt
          : `Approve Plan ${input.planId}?\n\n${readPlanForApproval(plan.plan.path)}`;
      if (!prompt || title.slice(end + 2) !== prompt) return;
      const questions = event.request.input?.questions;
      if (!Array.isArray(questions) || questions.length !== 1) return;
      const question = questions[0];
      if (!question || typeof question !== 'object' || Array.isArray(question)) return;
      if (
        question.question !== title ||
        question.header !== 'Response' ||
        question.multiSelect !== false ||
        question.allowEmpty === true
      )
        return;
      const expectedOptions = input.kind === 'approval' ? [{ label: 'Yes' }, { label: 'No' }] : [];
      if (JSON.stringify(question.options) !== JSON.stringify(expectedOptions)) return;
      const method = event.request.metadata?.extensionUiMethod;
      if (method !== (input.kind === 'approval' ? 'confirm' : 'input')) return;
      const presentation: DecisionPresentation = {
        sessionId: input.sessionId,
        planId: input.planId,
        decisionId: input.decisionId,
        kind: input.kind,
        nativeAgentId: event.agentId,
        requestId: event.request.id,
      };
      runtime.bindDecisionPresentation(presentation);
      bindings.set(`${event.agentId}:${event.request.id}`, presentation);
    } else {
      const binding = bindings.get(`${event.agentId}:${event.requestId}`);
      // > Missing request events after reconnect remain pending for authenticated CLI recovery.
      if (!binding) return;
      const response = event.resolution;
      const answers = response.behavior === 'allow' ? response.updatedInput?.answers : undefined;
      const answer =
        answers && typeof answers === 'object' && !Array.isArray(answers)
          ? (answers as Record<string, unknown>).Response
          : undefined;
      await runtime.resolveDecisionPresentation({
        ...binding,
        ...(typeof answer === 'string' && answer.trim()
          ? { answer: binding.kind === 'approval' ? answer.toLowerCase() : answer }
          : {}),
        cancelled: response.behavior === 'deny' || typeof answer !== 'string' || !answer.trim(),
      });
    }
  });
}
