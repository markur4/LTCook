import type { Assignment, NativeBinding, Pass, Task, TeamMember } from '../workflow-api/index.js';

/** Keep error reasons useful without persisting request bodies, credentials, or private paths. */
export function sanitizeEvaluationText(value: string): string {
  let text = value.split(/\r?\n/, 1)[0] ?? '';
  for (const [key, secret] of Object.entries(process.env))
    if (
      /(?:token|password|secret|api_?key|authorization)/i.test(key) &&
      secret &&
      secret.length >= 8
    )
      text = text.replaceAll(secret, '<redacted>');
  return text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<redacted>@')
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 <redacted>')
    .replace(
      /((?:api[-_]?key|password|token|secret|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1<redacted>',
    )
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '<redacted>')
    .replace(/(["'])(?:\/|[A-Z]:\\)[^"'\r\n]*\1/g, '$1<private-path>$1')
    .replace(
      /(?:\/(?:home|Users|tmp|mnt|root)\/[^\s"'<>]+|[A-Z]:\\Users\\[^\s"'<>]+)/g,
      '<private-path>',
    )
    .replace(/\b(request|response|prompt|payload|body|arguments)\s*[:=]\s*.*$/gi, '$1=<omitted>')
    .replace(/\{.*$/, '<structured-data omitted>')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 1024);
}

/** Capture only the first error line; successful tool output and command arguments never enter diagnostics. */
export function evaluationToolError(result: unknown): string | undefined {
  if (
    !result ||
    typeof result !== 'object' ||
    !('content' in result) ||
    !Array.isArray(result.content)
  )
    return undefined;
  for (const item of result.content)
    if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string')
      return sanitizeEvaluationText(item.text);
  return undefined;
}

export function evaluationTokenUsage(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  const usage: Record<string, number> = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const)
    if (typeof fields[key] === 'number' && Number.isFinite(fields[key])) usage[key] = fields[key];
  return Object.keys(usage).length ? usage : undefined;
}

type RuntimeStateInput = {
  passes: ReadonlyArray<Pick<Pass, 'id' | 'status'>>;
  tasks: ReadonlyArray<Pick<Task, 'id' | 'status' | 'phase' | 'assigneeKey'>>;
  assignments: ReadonlyArray<Pick<Assignment, 'id' | 'taskId' | 'memberKey' | 'status'>>;
  members: ReadonlyArray<{
    member: Pick<TeamMember, 'key'>;
    binding: Pick<NativeBinding, 'state'> | null;
    nativeStatus: string | null;
  }>;
  blockers: readonly unknown[];
};
export type EvaluationRuntimeState = {
  passes: Array<Pick<Pass, 'id' | 'status'>>;
  tasks: Array<Pick<Task, 'id' | 'status' | 'phase' | 'assigneeKey'>>;
  assignments: Array<Pick<Assignment, 'id' | 'taskId' | 'memberKey' | 'status'>>;
  members: Array<{ key: string; bindingState: string | null; nativeStatus: string | null }>;
  blockerCount: number;
};
type DiagnosticEvent = {
  elapsedMs: number;
  event: string;
  agentId?: string;
  tool?: string;
  callId?: string;
  stopReason?: string;
  rawStopReason?: string;
  error?: string;
  status?: number;
  operation?: string;
  commandType?: string;
  durationMs?: number;
  taskId?: string;
  assignmentId?: string;
  memberKey?: string;
  usage?: Record<string, number>;
};
export type EvaluationDiagnostics = {
  captureIncomplete?: boolean;
  recentEvents: DiagnosticEvent[];
  modelFailures: DiagnosticEvent[];
  toolFailures: DiagnosticEvent[];
  runtimeFailures: DiagnosticEvent[];
  activeAgents: string[];
  activeModels: string[];
  activeTools: Array<{ agentId: string; callId: string; tool: string }>;
  runtime?: EvaluationRuntimeState;
  configuredModel?: { id: string; contextWindow: number; maxTokens: number; thinking: string };
};
export type EvaluationCapture = {
  diagnostics: EvaluationDiagnostics;
  toolCalls: number;
  elapsedMs: number;
};

/** Retain bounded metadata for failure diagnosis without keeping model or tool payloads. */
export class EvaluationDiagnosticCollector {
  private readonly started = performance.now();
  private readonly recentEvents: DiagnosticEvent[] = [];
  private readonly modelFailures: DiagnosticEvent[] = [];
  private readonly toolFailures: DiagnosticEvent[] = [];
  private readonly runtimeFailures: DiagnosticEvent[] = [];
  private readonly activeAgents = new Set<string>();
  private readonly activeModels = new Set<string>();
  private readonly activeTools = new Map<
    string,
    { agentId: string; callId: string; tool: string }
  >();

  observe(agentId: string, value: Record<string, unknown>): DiagnosticEvent | undefined {
    if (
      typeof value.kind !== 'string' ||
      ![
        'agent.start',
        'agent.end',
        'model.start',
        'model.end',
        'tool.start',
        'tool.end',
        'runtime.error',
      ].includes(value.kind)
    )
      return undefined;
    const event: DiagnosticEvent = {
      elapsedMs: performance.now() - this.started,
      event: value.kind,
      agentId,
    };
    for (const key of [
      'tool',
      'callId',
      'stopReason',
      'rawStopReason',
      'error',
      'operation',
      'commandType',
    ] as const)
      if (typeof value[key] === 'string') event[key] = sanitizeEvaluationText(value[key]);
    for (const key of ['durationMs', 'status'] as const)
      if (typeof value[key] === 'number' && Number.isFinite(value[key])) event[key] = value[key];
    const usage = evaluationTokenUsage(value.usage);
    if (usage) event.usage = usage;
    if (value.kind === 'agent.start') this.activeAgents.add(agentId);
    if (value.kind === 'agent.end') this.activeAgents.delete(agentId);
    if (value.kind === 'model.start') this.activeModels.add(agentId);
    if (value.kind === 'model.end') {
      this.activeModels.delete(agentId);
      if (value.stopReason === 'error' || value.stopReason === 'aborted')
        this.retain(this.modelFailures, event, 8);
    }
    if (value.kind === 'tool.start' && event.callId && event.tool)
      this.activeTools.set(`${agentId}:${event.callId}`, {
        agentId,
        callId: event.callId,
        tool: event.tool,
      });
    if (value.kind === 'tool.end') {
      this.activeTools.delete(`${agentId}:${event.callId}`);
      if (value.isError === true) this.retain(this.toolFailures, event, 16);
    }
    if (value.kind === 'runtime.error') this.retain(this.runtimeFailures, event, 16);
    this.retain(this.recentEvents, event, 64);
    return event;
  }

  runtimeEvent(value: {
    type: string;
    taskId?: string;
    assignmentId?: string;
    memberKey?: string;
  }): void {
    this.retain(
      this.recentEvents,
      {
        elapsedMs: performance.now() - this.started,
        event: value.type,
        ...(value.taskId ? { taskId: value.taskId } : {}),
        ...(value.assignmentId ? { assignmentId: value.assignmentId } : {}),
        ...(value.memberKey ? { memberKey: sanitizeEvaluationText(value.memberKey) } : {}),
      },
      64,
    );
  }

  snapshot(runtime?: RuntimeStateInput): EvaluationDiagnostics {
    return {
      recentEvents: [...this.recentEvents],
      modelFailures: [...this.modelFailures],
      toolFailures: [...this.toolFailures],
      runtimeFailures: [...this.runtimeFailures],
      activeAgents: [...this.activeAgents],
      activeModels: [...this.activeModels],
      activeTools: [...this.activeTools.values()],
      ...(runtime
        ? {
            runtime: {
              passes: runtime.passes.map(({ id, status }) => ({ id, status })),
              tasks: runtime.tasks.map(({ id, status, phase, assigneeKey }) => ({
                id,
                status,
                phase,
                assigneeKey,
              })),
              assignments: runtime.assignments.map(({ id, taskId, memberKey, status }) => ({
                id,
                taskId,
                memberKey,
                status,
              })),
              members: runtime.members.map(({ member, binding, nativeStatus }) => ({
                key: member.key,
                bindingState: binding?.state ?? null,
                nativeStatus,
              })),
              blockerCount: runtime.blockers.length,
            },
          }
        : {}),
    };
  }

  private retain(target: DiagnosticEvent[], value: DiagnosticEvent, limit: number): void {
    target.push(value);
    if (target.length > limit) target.shift();
  }
}
