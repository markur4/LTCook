import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/ui';
import {
  storedSummariesRpc,
  type ActivitySnapshot,
  type MemoryUnitCounts,
  type StoredSummariesPage,
} from '../../shared/activity';
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

type SummaryReader =
  { status: 'loading' | 'ready'; page: StoredSummariesPage } | { status: 'error'; message: string };

export function ActivityServices({
  theme,
  agentId,
  rag,
  memory,
  agentWorktree,
}: Pick<ActivitySnapshot, 'rag' | 'memory'> & {
  theme: Theme;
  agentId: string;
  agentWorktree?: string;
}) {
  const [ragOpen, setRagOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [reader, setReader] = useState<SummaryReader | null>(null);
  const request = useRef(0);
  const fetchSummaries = useRpc(storedSummariesRpc);
  function closeReader() {
    request.current++;
    setReader(null);
  }
  async function readSummaries(before?: NonNullable<StoredSummariesPage['next']>) {
    const version = ++request.current;
    const summaries = before && reader?.status === 'ready' ? reader.page.summaries : [];
    setReader({ status: 'loading', page: { summaries, next: null } });
    try {
      const page = await fetchSummaries({ agentId, before });
      if (version === request.current)
        setReader({
          status: 'ready',
          page: { ...page, summaries: [...summaries, ...page.summaries] },
        });
    } catch (error) {
      if (version === request.current)
        setReader({
          status: 'error',
          message: error instanceof Error ? error.message : 'Stored summaries are unavailable.',
        });
    }
  }
  const ragActivity = statusLabel(rag.activity);
  const ragAvailability = statusLabel(rag.availability);
  const summarization = statusLabel(memory.summarization);
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
          if (memoryOpen) closeReader();
          setMemoryOpen(!memoryOpen);
        }}
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
          <ActivityButton
            theme={theme}
            label={`Stored for this agent, ${storedCounts}`}
            expanded={reader !== null}
            onPress={() => (reader ? closeReader() : void readSummaries())}
          >
            <Icon
              name={reader ? 'ChevronDown' : 'ChevronRight'}
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
        )}
        {reader?.status === 'error' && (
          <>
            <ActivityText theme={theme} tone="danger">
              {reader.message}
            </ActivityText>
            <ActivityButton
              theme={theme}
              label="Retry stored summaries"
              onPress={() => void readSummaries()}
            >
              <ActivityText theme={theme}>Retry</ActivityText>
            </ActivityButton>
          </>
        )}
        {reader && reader.status !== 'error' && (
          <>
            {reader.page.summaries.map((summary) => (
              <View
                key={summary.id}
                style={{
                  borderColor: theme.colors.border,
                  borderWidth: 1,
                  borderRadius: 5,
                  padding: 7,
                  gap: 5,
                }}
              >
                <ActivityText theme={theme} strong>
                  {summary.type === 'UAMP'
                    ? 'UAMP · User–agent message pair'
                    : 'AAB · Agent action batch'}
                </ActivityText>
                <ActivityText theme={theme} tone="muted" size={10}>
                  {new Date(summary.createdAt).toLocaleString()}
                </ActivityText>
                {summary.parts.map((part, index) => (
                  <View key={index} style={{ gap: 3 }}>
                    <ActivityText theme={theme} size={12}>
                      {part.text}
                    </ActivityText>
                    {part.sources.length > 0 && (
                      <ActivityText theme={theme} tone="muted" size={10}>
                        Sources {part.sources.map((source) => `#${source}`).join(', ')}
                      </ActivityText>
                    )}
                  </View>
                ))}
              </View>
            ))}
            {reader.status === 'loading' ? (
              <ActivityText theme={theme} tone="muted">
                Loading stored summaries…
              </ActivityText>
            ) : reader.page.summaries.length === 0 ? (
              <ActivityText theme={theme} tone="muted">
                No completed summaries for this agent.
              </ActivityText>
            ) : reader.page.next ? (
              <ActivityButton
                theme={theme}
                label="Load older summaries"
                onPress={() => void readSummaries(reader.page.next ?? undefined)}
              >
                <ActivityText theme={theme}>Load older summaries</ActivityText>
              </ActivityButton>
            ) : null}
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
