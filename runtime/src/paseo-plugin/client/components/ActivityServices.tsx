import { useState } from 'react';
import { Text } from 'react-native';
import type { ActivitySnapshot, MemoryUnitCounts } from '../../shared/activity';
import {
  ActivityCard,
  ActivityField,
  ActivityText,
  activityColor,
  statusLabel,
} from './ActivityCard';
import type { Theme } from './PanelChrome';

const ragAvailabilityTones = {
  ready: 'success',
  'not-ready': 'warning',
  unavailable: 'danger',
  unknown: 'muted',
} as const;

const ragActivityTones = {
  idle: 'muted',
  checking: 'running',
  indexing: 'running',
  updating: 'running',
  interrupted: 'warning',
  error: 'danger',
  unknown: 'muted',
} as const;

const memoryTones = {
  summarizing: 'running',
  queued: 'warning',
  'up-to-date': 'success',
  'below-threshold': 'muted',
  failed: 'danger',
  disabled: 'muted',
  unknown: 'muted',
} as const;

function memoryCounts({ uamp, aab }: MemoryUnitCounts) {
  return `${uamp.toLocaleString()} user–agent ${uamp === 1 ? 'pair' : 'pairs'} · ${aab.toLocaleString()} action ${aab === 1 ? 'batch' : 'batches'}`;
}

export function ActivityServices({
  theme,
  rag,
  memory,
  agentWorktree,
}: Pick<ActivitySnapshot, 'rag' | 'memory'> & { theme: Theme; agentWorktree?: string }) {
  const [ragOpen, setRagOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const ragActivity = statusLabel(rag.activity);
  const ragAvailability = statusLabel(rag.availability);
  const summarization = statusLabel(memory.summarization);
  const stored = memory.stored ? memory.stored.uamp + memory.stored.aab : null;
  const memorySummary = [
    stored === null
      ? 'Background summaries'
      : `${stored.toLocaleString()} ${stored === 1 ? 'summary' : 'summaries'} stored`,
    ...(memory.lastHandoff ? ['Handoff received'] : []),
  ].join(' · ');

  return (
    <>
      <ActivityCard
        theme={theme}
        title="RAG Index"
        icon="Database"
        status={ragAvailability}
        statusTone={ragAvailabilityTones[rag.availability]}
        open={ragOpen}
        onToggle={() => setRagOpen(!ragOpen)}
        summaryLabel={`${rag.provider}, ${ragActivity}`}
        summary={
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
            {rag.provider} ·{' '}
            <Text style={{ color: activityColor(theme, ragActivityTones[rag.activity]) }}>
              {ragActivity}
            </Text>
          </Text>
        }
      >
        <ActivityField theme={theme} label="Index worktree">
          {rag.worktree?.path ?? 'Unavailable'}
        </ActivityField>
        {rag.worktree && agentWorktree && agentWorktree !== rag.worktree.path && (
          <ActivityField theme={theme} label="Agent worktree">
            {agentWorktree}
          </ActivityField>
        )}
        <ActivityField theme={theme} label="Availability">
          {ragAvailability}
        </ActivityField>
        <ActivityField theme={theme} label="Activity">
          {ragActivity}
        </ActivityField>
        {rag.diagnostic && (
          <ActivityText theme={theme} tone="muted">
            {rag.diagnostic}
          </ActivityText>
        )}
      </ActivityCard>
      <ActivityCard
        theme={theme}
        title="Session Memory"
        icon="Brain"
        status={summarization}
        statusTone={memoryTones[memory.summarization]}
        open={memoryOpen}
        onToggle={() => setMemoryOpen(!memoryOpen)}
        summaryLabel={memorySummary}
        summary={
          <ActivityText theme={theme} tone="muted" size={10}>
            {memorySummary}
          </ActivityText>
        }
      >
        <ActivityText theme={theme} strong>
          Background summaries
        </ActivityText>
        {memory.summarization !== 'disabled' && (
          <ActivityField theme={theme} label="Stored for this agent">
            {memory.stored ? memoryCounts(memory.stored) : 'Counts unavailable'}
          </ActivityField>
        )}
        {memory.pending && (
          <ActivityField theme={theme} label="Pending">
            {memoryCounts(memory.pending)}
          </ActivityField>
        )}
        {memory.lastSummaryAt !== null && (
          <ActivityField theme={theme} label="Last successful summary">
            {new Date(memory.lastSummaryAt).toLocaleString()}
          </ActivityField>
        )}
        {memory.diagnostic && (
          <ActivityText theme={theme} tone="muted">
            {memory.diagnostic}
          </ActivityText>
        )}
        <ActivityText theme={theme} strong>
          Last delegation handoff
        </ActivityText>
        {memory.lastHandoff ? (
          <>
            <ActivityField theme={theme} label="Source agent">
              {memory.lastHandoff.sourceName ?? 'Name unavailable'}
            </ActivityField>
            <ActivityField theme={theme} label="Received">
              {new Date(memory.lastHandoff.at).toLocaleString()}
            </ActivityField>
            <ActivityField theme={theme} label="Payload size">
              {`${memory.lastHandoff.bytes.toLocaleString()} bytes`}
            </ActivityField>
            <ActivityField theme={theme} label="Summaries represented">
              {memoryCounts(memory.lastHandoff.summaries)}
            </ActivityField>
          </>
        ) : (
          <ActivityText theme={theme} tone="muted">
            No acknowledged handoff available for this agent.
          </ActivityText>
        )}
      </ActivityCard>
    </>
  );
}
