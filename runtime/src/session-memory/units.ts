import type { PaseoMemoryMessage } from '../paseo-plugin/server/memory-source.js';
import { estimateMemoryTokens } from '../paseo-plugin/server/memory-text.js';
import type { MemoryAttachment } from './pasted-documents.js';

export type MemoryScope = {
  sessionId?: string;
  planId?: string;
  passId?: string;
  taskId?: string;
  stepId?: string;
};

export type MemorySourceMessage = PaseoMemoryMessage & {
  intermediate?: true;
  scope?: MemoryScope;
  task?: MemoryTaskContext;
  attachments?: MemoryAttachment[];
};

export type MemoryTurnOutcome = 'completed' | 'failed' | 'canceled';

export type MemoryTaskContext = {
  title: string;
  description: string;
  acceptance: readonly string[];
  assignment?: string;
};

export type MemoryUnit = {
  type: 'UAMP' | 'AAB';
  messages: readonly MemorySourceMessage[];
  scope?: MemoryScope;
  task?: MemoryTaskContext;
  instructions?: readonly MemorySourceMessage[];
};

export function observedMemoryChecks(messages: readonly MemorySourceMessage[]) {
  const checks = new Map<string, { seq: number; text: string }>();
  for (const { author, seq, text } of messages) {
    if (author !== 'tool') continue;
    // > Keep explicit named check outcomes from the original tool result.
    for (const [outcome, name, status] of text.matchAll(
      /\b([A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)+)[\t ]+([A-Za-z]+)\b/g,
    )) {
      if (!/^(?:PASS(?:ED)?|FAIL(?:ED)?|SKIP(?:PED)?)$/i.test(status!)) continue;
      checks.set(JSON.stringify([seq, name, status]), { seq, text: outcome.replace(/\s+/g, ' ') });
    }
  }
  return [...checks.values()];
}

export function scopeKey(scope: MemoryScope | undefined): string {
  return JSON.stringify([
    scope?.sessionId,
    scope?.planId,
    scope?.passId,
    scope?.taskId,
    scope?.stepId,
  ]);
}

export function isMemoryInstruction(source: MemorySourceMessage, task?: MemoryTaskContext) {
  return source.author === 'user' || (source.runtimeAssignment === true && !task?.assignment);
}

/** Derive boundaries from native receipts and ordered canonical timeline entries. */
export function identifyMemoryUnits(
  messages: readonly MemorySourceMessage[],
  outcomes: ReadonlyMap<string, MemoryTurnOutcome>,
  actionThreshold: number,
  flush = false,
  recordedActions: ReadonlySet<number> = new Set(),
): MemoryUnit[] {
  const units: MemoryUnit[] = [];
  const regions: MemorySourceMessage[][] = [];
  for (const message of messages) {
    const previous = regions.at(-1);
    const prompt =
      message.author === 'user' || message.author === 'runtime' || message.author === 'unknown';
    if (!previous || previous[0]?.turnId !== message.turnId || (!message.turnId && prompt))
      regions.push([message]);
    else previous.push(message);
  }

  let actions: MemorySourceMessage[] = [];
  let context: MemorySourceMessage[] = [];
  let tokens = 0;
  const finishActions = () => {
    if (actions.length)
      units.push({
        type: 'AAB',
        scope: actions[0]?.scope,
        messages: actions,
        task: actions[0]?.task,
        instructions: context,
      });
    actions = [];
    context = [];
    tokens = 0;
  };
  for (const [index, items] of regions.entries()) {
    const turnId = items[0]?.turnId;
    const outcome = turnId ? outcomes.get(turnId) : undefined;
    const initiatingPrompt = items.find(
      ({ author }) => author === 'user' || author === 'runtime' || author === 'unknown',
    );
    const lastAction = items.findLastIndex(
      ({ author, intermediate }) => author === 'tool' || !!intermediate,
    );
    const finalResponses = items
      .slice(lastAction + 1)
      .filter(
        ({ author, intermediate, seq }) =>
          author === 'agent' && !intermediate && seq > (initiatingPrompt?.seq ?? -1),
      );
    const hasUamp =
      outcome === 'completed' && initiatingPrompt?.author === 'user' && finalResponses.length > 0;
    const finalResponseSet = new Set(finalResponses);
    if (index > 0 && (!turnId || !regions[index - 1]?.[0]?.turnId)) finishActions();
    for (const item of items) {
      if (recordedActions.has(item.seq)) continue;
      if (item.author !== 'agent' && item.author !== 'tool') continue;
      if (
        item.author === 'agent' &&
        !item.intermediate &&
        (!outcome || (finalResponseSet.has(item) && (hasUamp || outcome !== 'completed')))
      )
        continue;
      const current = actions[0]?.scope;
      if (
        actions.length &&
        ((!current?.taskId && actions.at(-1)?.turnId !== turnId) ||
          scopeKey(current) !== scopeKey(item.scope))
      )
        finishActions();
      const instructions = items.filter(
        (source) => source.seq < item.seq && isMemoryInstruction(source, item.task),
      );
      context = [
        ...new Map([...context, ...instructions].map((source) => [source.seq, source])).values(),
      ];
      actions.push(item);
      tokens += estimateMemoryTokens(item.text);
      if (tokens >= actionThreshold) finishActions();
    }
    if (hasUamp) {
      finishActions();
      const last = finalResponses.at(-1)!.seq;
      units.push({
        type: 'UAMP',
        messages: [
          ...items.filter(({ author, seq }) => author === 'user' && seq < last),
          ...finalResponses,
        ].sort((a, b) => a.seq - b.seq),
        scope: initiatingPrompt.scope,
        task: initiatingPrompt.task,
      });
    } else if (
      outcome === 'canceled' ||
      outcome === 'failed' ||
      (!actions[0]?.scope?.taskId && index < regions.length - 1)
    ) {
      finishActions();
    }
  }
  if (
    flush ||
    (!actions[0]?.scope?.taskId &&
      regions.some(
        (items) =>
          items[0]?.turnId === actions.at(-1)?.turnId &&
          !!items[0]?.turnId &&
          outcomes.has(items[0].turnId),
      ))
  )
    finishActions();
  return units.sort((a, b) => a.messages.at(-1)!.seq - b.messages.at(-1)!.seq);
}
