import type { Assignment, NativeBinding, Pass, Task, TeamMember } from '../workflow-api/index.js';

/** Keep error reasons useful without persisting request bodies, credentials, or private paths. */
export function sanitizeEvaluationText(value: string): string {
  const response = /^(\d{3}):?\s*(\{[\s\S]*\})\s*$/.exec(value.trim());
  if (response) {
    try {
      const parsed: unknown = JSON.parse(response[2]!);
      if (parsed && typeof parsed === 'object') {
        const error = 'error' in parsed ? parsed.error : parsed;
        const reason =
          typeof error === 'string'
            ? error
            : error &&
                typeof error === 'object' &&
                'message' in error &&
                typeof error.message === 'string'
              ? error.message
              : undefined;
        if (reason) value = `${response[1]}: ${reason}`;
      }
    } catch {
      // > Invalid response bodies remain omitted by the structured-data filter below.
    }
  }
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

/** Preserve bounded schema field failures while excluding received arguments and successful output. */
export function evaluationToolError(result: unknown): string | undefined {
  if (
    !result ||
    typeof result !== 'object' ||
    !('content' in result) ||
    !Array.isArray(result.content)
  )
    return undefined;
  for (const item of result.content) {
    if (!item || typeof item !== 'object' || item.type !== 'text' || typeof item.text !== 'string')
      continue;
    const lines = item.text.split(/\r?\n/);
    const header = sanitizeEvaluationText(lines[0] ?? '');
    if (!/^Validation failed for tool "[^"\r\n]+":\s*$/.test(lines[0] ?? '')) return header;
    const failures: string[] = [];
    for (const line of lines.slice(1)) {
      if (/^\s*Received arguments:/.test(line)) break;
      const match = /^\s*-\s+([\w.~/-]{1,160}):\s+(.+)$/.exec(line);
      if (!match) continue;
      const field = sanitizeEvaluationText(match[1]).slice(0, 128);
      const reason = sanitizeEvaluationText(match[2]).slice(0, 160);
      failures.push(`[${field}] ${reason}`);
      if (failures.length === 6) break;
    }
    let commandType: string | undefined;
    let knownFields: string[] = [];
    let status: string | undefined;
    let statusShape: string | undefined;
    if (lines[0] === 'Validation failed for tool "ltcook_team":') {
      const marker = lines.findIndex((line: string) => /^\s*Received arguments:/.test(line));
      if (marker >= 0) {
        try {
          const args: unknown = JSON.parse(lines.slice(marker + 1).join('\n'));
          if (args && typeof args === 'object' && 'command' in args) {
            const command = args.command;
            if (
              command &&
              typeof command === 'object' &&
              'type' in command &&
              (command.type === 'task.create' || command.type === 'task.update')
            ) {
              commandType = command.type;
              knownFields = [
                'taskId',
                'passId',
                'workType',
                'status',
                'title',
                'description',
                'acceptance',
                'assigneeKey',
              ].filter((field) => field in command);
              if ('status' in command)
                statusShape =
                  command.status === null
                    ? 'null'
                    : Array.isArray(command.status)
                      ? 'array'
                      : typeof command.status;
              if (
                'status' in command &&
                typeof command.status === 'string' &&
                ['pending', 'running', 'blocked', 'completed', 'failed', 'cancelled'].includes(
                  command.status,
                )
              )
                status = command.status;
            }
          }
        } catch {
          // > A malformed error must never expose the original argument text.
        }
      }
    }
    return [
      header,
      ...(commandType ? [`Command type: ${commandType}.`] : []),
      ...(commandType ? [`Present fields: ${knownFields.join(', ') || '(none)'}.`] : []),
      ...(status ? [`Status: ${status}.`] : []),
      ...(statusShape ? [`Status value type: ${statusShape}.`] : []),
      ...failures,
    ]
      .join(' ')
      .slice(0, 1024);
  }
  return undefined;
}

/** A length stop is terminal; its source may be context or output limits and is not guessed here. */
export function evaluationModelFailed(stopReason: unknown): boolean {
  return stopReason === 'error' || stopReason === 'aborted' || stopReason === 'length';
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
  phase?: string;
  reason?: string;
  willRetry?: boolean;
  fromExtension?: boolean;
  aborted?: boolean;
  tokensBefore?: number;
  commandType?: string;
  hasPassId?: boolean;
  durationMs?: number;
  taskId?: string;
  assignmentId?: string;
  memberKey?: string;
  reasoningEffort?: string;
  outputLimit?: number;
  toolCount?: number;
  messageCount?: number;
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
  configuredModel?: {
    id: string;
    contextWindow: number;
    maxTokens: number;
    thinking: string;
    compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
    compat?: { supportsDeveloperRole: boolean; maxTokensField?: 'max_tokens' };
  };
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
        'model.response',
        'model.stream',
        'compaction.start',
        'compaction.end',
        'compaction.failed',
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
      'phase',
      'reason',
      'commandType',
    ] as const)
      if (typeof value[key] === 'string') event[key] = sanitizeEvaluationText(value[key]);
    if (['none', 'low', 'high', 'omitted', 'other'].includes(String(value.reasoningEffort)))
      event.reasoningEffort = String(value.reasoningEffort);
    for (const key of [
      'durationMs',
      'status',
      'tokensBefore',
      'outputLimit',
      'toolCount',
      'messageCount',
    ] as const)
      if (typeof value[key] === 'number' && Number.isFinite(value[key])) event[key] = value[key];
    for (const key of ['willRetry', 'fromExtension', 'aborted'] as const)
      if (typeof value[key] === 'boolean') event[key] = value[key];
    if (typeof value.hasPassId === 'boolean') event.hasPassId = value.hasPassId;
    const usage = evaluationTokenUsage(value.usage);
    if (usage) event.usage = usage;
    if (value.kind === 'agent.start') this.activeAgents.add(agentId);
    if (value.kind === 'agent.end') this.activeAgents.delete(agentId);
    if (value.kind === 'model.start') this.activeModels.add(agentId);
    if (value.kind === 'compaction.start') this.activeModels.add(agentId);
    if (value.kind === 'compaction.end' || value.kind === 'compaction.failed')
      this.activeModels.delete(agentId);
    if (value.kind === 'compaction.failed') this.retain(this.modelFailures, event, 8);
    if (value.kind === 'model.end') {
      this.activeModels.delete(agentId);
      if (evaluationModelFailed(value.stopReason)) this.retain(this.modelFailures, event, 8);
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
