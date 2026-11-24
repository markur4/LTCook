import { useState } from 'react';
import { Text, View } from 'react-native';
import type { ActivitySnapshot, SessionMemoryStatus } from '../../shared/activity';
import {
  ActivityCard,
  ActivityField,
  ActivityText,
  activityColor,
  contextDescription,
  contextObservation,
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

function countText(count: number | null) {
  return count === null ? '—' : count.toLocaleString();
}

function memoryRatio(counts: SessionMemoryStatus['uamp'], units: string) {
  return `${countText(counts.inContext)}/${countText(counts.stored)} ${units}`;
}

function MemoryCounts({ theme, memory }: { theme: Theme; memory: SessionMemoryStatus }) {
  const rows = [
    { label: 'User>Agent Message Pairs (UAMP)', counts: memory.uamp },
    { label: 'Agent Action Batches (AAB)', counts: memory.aab },
  ];
  const rowStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 5,
    borderBottomColor: theme.colors.border,
    borderBottomWidth: 1,
  } as const;
  const cellStyle = {
    width: 51,
    textAlign: 'right',
    fontSize: 10,
  } as const;
  return (
    <View style={{ marginTop: 4 }}>
      <View style={rowStyle}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <ActivityText theme={theme} tone="muted" size={10}>
            Memory units
          </ActivityText>
        </View>
        <Text style={{ ...cellStyle, color: theme.colors.foregroundMuted }}>In context</Text>
        <Text style={{ ...cellStyle, color: theme.colors.foregroundMuted }}>Total stored</Text>
      </View>
      {rows.map(({ label, counts }) => (
        <View
          key={label}
          accessible
          accessibilityLabel={`${label}, in context ${counts.inContext ?? 'unknown'}, total stored ${counts.stored ?? 'unknown'}`}
          style={rowStyle}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <ActivityText theme={theme}>{label}</ActivityText>
          </View>
          <Text style={{ ...cellStyle, color: theme.colors.accent }}>
            {countText(counts.inContext)}
          </Text>
          <Text style={{ ...cellStyle, color: theme.colors.foreground }}>
            {countText(counts.stored)}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function ActivityServices({
  theme,
  rag,
  memory,
}: Pick<ActivitySnapshot, 'rag' | 'memory'> & { theme: Theme }) {
  const [ragOpen, setRagOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const ragActivity = statusLabel(rag.activity);
  const ragAvailability = statusLabel(rag.availability);
  const summarization = statusLabel(memory.summarization);
  const uamp = memoryRatio(memory.uamp, 'UAMPs');
  const aab = memoryRatio(memory.aab, 'AABs');

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
        <ActivityField theme={theme} label="Worktree">
          {rag.worktree?.path ?? 'Unavailable'}
        </ActivityField>
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
        context={memory.context}
        contextLabel="Memory context"
        summaryLabel={`${uamp}, ${aab}, in context over total stored`}
        summary={
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 5 }}>
            <ActivityText theme={theme} tone="muted" size={10}>
              {uamp}
            </ActivityText>
            <ActivityText theme={theme} tone="muted" size={10}>
              {aab}
            </ActivityText>
          </View>
        }
      >
        <ActivityField theme={theme} label="Memory context">
          {contextDescription(memory.context)}
        </ActivityField>
        <ActivityField theme={theme} label="Context stage">
          {statusLabel(memory.contextStage)}
        </ActivityField>
        {memory.context && (
          <ActivityField theme={theme} label="Observed">
            {contextObservation(memory.context)}
          </ActivityField>
        )}
        <ActivityField theme={theme} label="Scope">
          {memory.scopeLabel}
        </ActivityField>
        {memory.sourceLabel && (
          <ActivityField theme={theme} label="Source">
            {memory.sourceLabel}
          </ActivityField>
        )}
        {memory.recipientLabel && (
          <ActivityField theme={theme} label="Recipient">
            {memory.recipientLabel}
          </ActivityField>
        )}
        <ActivityField theme={theme} label="Summarization">
          {summarization}
        </ActivityField>
        <ActivityField theme={theme} label="Last summary">
          {memory.lastSummaryAt === null
            ? 'Unknown'
            : new Date(memory.lastSummaryAt).toLocaleString()}
        </ActivityField>
        {(memory.pendingUamp !== null || memory.pendingAab !== null) && (
          <ActivityField theme={theme} label="Pending">
            {`${countText(memory.pendingUamp)} UAMPs · ${countText(memory.pendingAab)} AABs`}
          </ActivityField>
        )}
        {memory.lastDelivery && (
          <>
            <ActivityField theme={theme} label="Last delivery">
              {new Date(memory.lastDelivery.at).toLocaleString()}
            </ActivityField>
            <ActivityField theme={theme} label="Delivered payload">
              {`${countText(memory.lastDelivery.bytes)} bytes · ${countText(memory.lastDelivery.uamp)} UAMPs · ${countText(memory.lastDelivery.aab)} AABs`}
            </ActivityField>
          </>
        )}
        <MemoryCounts theme={theme} memory={memory} />
        {memory.diagnostic && (
          <ActivityText theme={theme} tone="muted">
            {memory.diagnostic}
          </ActivityText>
        )}
      </ActivityCard>
    </>
  );
}
