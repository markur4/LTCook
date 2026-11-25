import { useState } from 'react';
import { Text, View } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { Icon, SettingsSelect } from '@getpaseo/plugin/client/ui';
import {
  memoryDeviceRpc,
  type ActivitySnapshot,
  type MemoryUnitCounts,
} from '../../shared/activity';
import { useStoredSummaries } from '../use-stored-summaries';
import {
  ActivityButton,
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

const memoryDevices = [
  { label: 'CPU', value: 'cpu' },
  { label: 'GPU (automatic)', value: 'automatic' },
] as const;

function StoredSummaryMetadata({
  theme,
  agentId,
  onOpenSummaries,
}: {
  theme: Theme;
  agentId: string;
  onOpenSummaries: () => void;
}) {
  const { page, error, loading, loadOlder, reload } = useStoredSummaries(agentId, false);
  return (
    <>
      <ActivityButton theme={theme} label="Open stored summaries" onPress={onOpenSummaries}>
        <Icon name="ArrowUpRight" size={11} color={theme.colors.accent} />
        <ActivityText theme={theme}>Open stored summaries</ActivityText>
      </ActivityButton>
      {page?.summaries.map((summary) => {
        const date = new Date(summary.createdAt);
        const duration =
          summary.durationMs === null
            ? 'Duration unknown'
            : summary.durationMs < 1_000
              ? `Duration ${summary.durationMs.toLocaleString()} ms`
              : `Duration ${(summary.durationMs / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
        return (
          <View
            key={summary.id}
            style={{
              borderTopColor: theme.colors.border,
              borderTopWidth: 1,
              paddingVertical: 4,
              gap: 3,
            }}
          >
            <ActivityText theme={theme} strong>
              {summary.type} ·{' '}
              {Number.isNaN(date.valueOf()) ? 'Time unknown' : date.toLocaleString()}
            </ActivityText>
            <ActivityText theme={theme} tone="muted" size={10}>
              Est. tokens · Original {summary.originalTokens?.toLocaleString() ?? 'unknown'} ·
              Summary {summary.summaryTokens?.toLocaleString() ?? 'unknown'}
            </ActivityText>
            <ActivityText theme={theme} tone="muted" size={10}>
              {duration} · Source #{summary.position}
            </ActivityText>
          </View>
        );
      })}
      {loading && (
        <ActivityText theme={theme} tone="muted">
          Loading stored summaries…
        </ActivityText>
      )}
      {error && (
        <ActivityText theme={theme} tone="danger">
          {error}
        </ActivityText>
      )}
      {!loading && !error && page?.summaries.length === 0 && (
        <ActivityText theme={theme} tone="muted">
          No completed summaries for this agent.
        </ActivityText>
      )}
      {!loading && !error && page?.next && (
        <ActivityButton theme={theme} label="Load older summaries" onPress={loadOlder}>
          <ActivityText theme={theme}>Load older summaries</ActivityText>
        </ActivityButton>
      )}
      {!loading && (
        <ActivityButton theme={theme} label="Reload stored summaries" onPress={reload}>
          <ActivityText theme={theme}>Reload stored summaries</ActivityText>
        </ActivityButton>
      )}
    </>
  );
}

export function ActivityServices({
  theme,
  agentId,
  rag,
  memory,
  onCpuOnlyChange,
  onOpenSummaries,
  agentWorktree,
}: Pick<ActivitySnapshot, 'rag' | 'memory'> & {
  theme: Theme;
  agentId: string;
  onCpuOnlyChange: (cpuOnly: boolean) => void;
  onOpenSummaries: () => void;
  agentWorktree?: string;
}) {
  const [ragOpen, setRagOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [savingDevice, setSavingDevice] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [storedOpen, setStoredOpen] = useState(false);
  const saveMemoryDevice = useRpc(memoryDeviceRpc);
  async function changeMemoryDevice(cpuOnly: boolean) {
    setSavingDevice(true);
    setDeviceError(null);
    try {
      const saved = await saveMemoryDevice({ cpuOnly });
      onCpuOnlyChange(saved.cpuOnly);
    } catch (error) {
      setDeviceError(error instanceof Error ? error.message : 'Could not change inference device.');
    } finally {
      setSavingDevice(false);
    }
  }
  const ragActivity = statusLabel(rag.activity);
  const ragAvailability = statusLabel(rag.availability);
  const summarization = statusLabel(memory.summarization);
  const rate = memory.summarization === 'summarizing' ? memory.rate : null;
  const rateLabel = rate
    ? `${rate.tokensPerSecond.toLocaleString(undefined, { maximumFractionDigits: 1 })} tokens/s${rate.estimated ? ' (estimated)' : ''}`
    : null;
  const storedCounts = memory.stored ? memoryCounts(memory.stored) : 'Counts unavailable';
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
        onToggle={() => {
          if (memoryOpen) setStoredOpen(false);
          setMemoryOpen(!memoryOpen);
        }}
        summaryLabel={rateLabel ? `${rateLabel}, ${memorySummary}` : memorySummary}
        summary={
          <>
            {rateLabel && (
              <ActivityText theme={theme} tone="running" size={12} strong>
                {rateLabel}
              </ActivityText>
            )}
            <ActivityText theme={theme} tone="muted" size={10}>
              {memorySummary}
            </ActivityText>
          </>
        }
      >
        <ActivityText theme={theme} strong>
          Background summaries
        </ActivityText>
        {memory.cpuOnly !== null && (
          <SettingsSelect
            label="Inference device"
            value={memory.cpuOnly ? 'cpu' : 'automatic'}
            options={memoryDevices}
            disabled={savingDevice}
            onValueChange={(device) => {
              const cpuOnly = device === 'cpu';
              if (cpuOnly !== memory.cpuOnly) void changeMemoryDevice(cpuOnly);
            }}
            error={deviceError}
          />
        )}
        {memory.summarization !== 'disabled' && (
          <>
            <ActivityButton
              theme={theme}
              label={`Stored for this agent, ${storedCounts}`}
              expanded={storedOpen}
              onPress={() => setStoredOpen(!storedOpen)}
            >
              <Icon
                name={storedOpen ? 'ChevronDown' : 'ChevronRight'}
                size={11}
                color={theme.colors.accent}
              />
              <View style={{ flex: 1, minWidth: 0 }}>
                <ActivityText theme={theme} strong>
                  Stored for this agent
                </ActivityText>
                <ActivityText theme={theme} tone="muted">
                  {storedCounts}
                </ActivityText>
              </View>
            </ActivityButton>
            {storedOpen && (
              <StoredSummaryMetadata
                agentId={agentId}
                theme={theme}
                onOpenSummaries={onOpenSummaries}
              />
            )}
          </>
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
