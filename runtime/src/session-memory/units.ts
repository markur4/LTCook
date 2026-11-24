import type { MemoryMessage } from './extraction.js';
import { estimateMemoryTokens } from './extraction.js';

export type MemoryScope = {
  sessionId?: string;
  planId?: string;
  passId?: string;
  taskId?: string;
  stepId?: string;
};

export type MemorySourceMessage = MemoryMessage & {
  turnId?: string;
  messageId?: string;
  timestamp?: string;
  intermediate?: true;
  scope?: MemoryScope;
  attachment?: { name: string; text?: string; truncated?: true };
};

export type MemoryTurnOutcome = 'completed' | 'failed' | 'canceled';

export type MemoryUnit = {
  type: 'UAMP' | 'AAB';
  messages: readonly MemorySourceMessage[];
  scope?: MemoryScope;
  partial?: true;
};

function scopeKey(scope: MemoryScope | undefined): string {
  return JSON.stringify([
    scope?.sessionId,
    scope?.planId,
    scope?.passId,
    scope?.taskId,
    scope?.stepId,
  ]);
}

/** Derive boundaries from native receipts and ordered canonical timeline entries. */
export function identifyMemoryUnits(
  messages: readonly MemorySourceMessage[],
  outcomes: ReadonlyMap<string, MemoryTurnOutcome>,
  actionThreshold: number,
  flush = false,
): MemoryUnit[] {
  const units: MemoryUnit[] = [];
  const turns = new Map<string | undefined, MemorySourceMessage[]>();
  for (const message of messages) {
    const turn = turns.get(message.turnId) ?? [];
    turn.push(message);
    turns.set(message.turnId, turn);
  }
  for (const [turnId, items] of turns) {
    const outcome = turnId ? outcomes.get(turnId) : undefined;
    const responses = items.filter(
      ({ author, intermediate }) => author === 'agent' && !intermediate,
    );
    const prompts = items.filter(({ author }) => author === 'user');
    const finalResponse = responses.at(-1);
    const initiatingPrompt = items.find(
      ({ author }) => author === 'user' || author === 'runtime' || author === 'unknown',
    );
    const hasUamp =
      outcome === 'completed' &&
      initiatingPrompt?.author === 'user' &&
      finalResponse &&
      finalResponse.seq > initiatingPrompt.seq;
    let actions: MemorySourceMessage[] = [];
    let tokens = 0;
    const finishActions = () => {
      if (!actions.length) return;
      units.push({ type: 'AAB', messages: actions, scope: actions[0]?.scope });
      actions = [];
      tokens = 0;
    };
    for (const item of items) {
      if (item.author !== 'agent' && item.author !== 'tool') continue;
      if (item.author === 'agent' && !item.intermediate && (item === finalResponse || !outcome))
        continue;
      if (actions.length && scopeKey(actions[0]?.scope) !== scopeKey(item.scope)) finishActions();
      actions.push(item);
      tokens += estimateMemoryTokens(item.text);
      if (tokens >= actionThreshold) finishActions();
    }
    if (outcome === 'completed' && !hasUamp && finalResponse) {
      if (actions.length && scopeKey(actions[0]?.scope) !== scopeKey(finalResponse.scope))
        finishActions();
      actions.push(finalResponse);
    }
    if (outcome || flush) finishActions();
    if (hasUamp) {
      units.push({
        type: 'UAMP',
        messages: [...prompts.filter(({ seq }) => seq < finalResponse.seq), finalResponse],
        scope: initiatingPrompt.scope,
      });
    }
  }
  return units.sort((a, b) => a.messages.at(-1)!.seq - b.messages.at(-1)!.seq);
}
