import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { usePaseo, useRpc } from '@getpaseo/plugin/client';
import { Markdown } from '@getpaseo/plugin/client/ui';
import {
  memoryEvidenceRpc,
  type MemoryEvidencePage,
  type StoredSummariesPage,
} from '../../shared/activity';
import { ActivityButton } from './ActivityCard';
import type { Theme } from './PanelChrome';

type MemoryRecord = StoredSummariesPage['summaries'][number];

function EvidenceList({
  agentId,
  record,
  theme,
}: {
  agentId: string;
  record: MemoryRecord;
  theme: Theme;
}) {
  const read = useRpc(memoryEvidenceRpc);
  const paseo = usePaseo();
  const generation = useRef(0);
  const [stale, setStale] = useState(false);
  const [page, setPage] = useState<MemoryEvidencePage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const { epoch, id, position } = record;
  useEffect(() => {
    const subscription = paseo.agents.ref(agentId).timeline.subscribe(({ event }) => {
      if (
        (event.type === 'replacement' && event.epoch !== epoch) ||
        event.type === 'subscription_restored'
      ) {
        generation.current++;
        setPage(undefined);
        setLoading(false);
        setStale(true);
      }
    });
    void subscription.ready.catch(() => undefined);
    return () => {
      generation.current++;
      subscription();
    };
  }, [agentId, epoch, paseo]);

  useEffect(() => {
    if (stale) return;
    const requested = ++generation.current;
    setLoading(true);
    setError(false);
    void read({ agentId, epoch, id, position }).then(
      (incoming) => {
        if (generation.current !== requested) return;
        setPage(incoming);
        setLoading(false);
      },
      () => {
        if (generation.current !== requested) return;
        setError(true);
        setLoading(false);
      },
    );
    return () => {
      generation.current++;
    };
  }, [agentId, epoch, id, position, read, stale]);

  async function load() {
    if (loading || stale) return;
    const requested = ++generation.current;
    setLoading(true);
    setError(false);
    try {
      const incoming = await read({
        agentId,
        epoch,
        id,
        position,
        after: page?.next ?? undefined,
      });
      if (generation.current !== requested) return;
      setPage({
        entries: [...(page?.entries ?? []), ...incoming.entries],
        next: incoming.next,
      });
    } catch {
      if (generation.current === requested) setError(true);
    } finally {
      if (generation.current === requested) setLoading(false);
    }
  }

  return (
    <View testID="ltcook-execution-evidence" style={{ gap: 6 }}>
      {page?.entries.map(({ seq, source }) => (
        <View key={seq} style={{ gap: 3 }}>
          <Text style={{ color: theme.colors.foregroundMuted }}>Source #{seq}</Text>
          {source ? (
            <>
              {source.kind === 'tool' && (
                <Text style={{ color: theme.colors.foreground }}>
                  {source.name} · {source.status}
                </Text>
              )}
              {(source.kind === 'agent' || source.details) && (
                <Text selectable style={{ color: theme.colors.foreground }}>
                  {source.kind === 'tool' ? source.details : source.text}
                </Text>
              )}
            </>
          ) : (
            <Text style={{ color: theme.colors.foregroundMuted }}>
              Original evidence unavailable.
            </Text>
          )}
        </View>
      ))}
      {(error || stale || (page?.entries.length === 0 && page.next === null)) && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          Original evidence unavailable.
        </Text>
      )}
      {loading && (
        <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>
          Loading original evidence…
        </Text>
      )}
      {!stale && !loading && (!page || page.next !== null) && (
        <View style={{ alignItems: 'flex-start' }}>
          <ActivityButton
            theme={theme}
            label={
              error
                ? 'Retry evidence'
                : page
                  ? 'Load more original evidence'
                  : 'Load original evidence'
            }
            onPress={() => void load()}
          >
            <Text style={{ color: theme.colors.foreground }}>
              {error
                ? 'Retry evidence'
                : page
                  ? 'Load more original evidence'
                  : 'Load original evidence'}
            </Text>
          </ActivityButton>
        </View>
      )}
    </View>
  );
}

function ExecutionCard({
  agentId,
  record,
  theme,
}: {
  agentId: string;
  record: MemoryRecord;
  theme: Theme;
}) {
  const [expanded, setExpanded] = useState(false);
  const { action } = record;
  if (!action) return null;
  const total = action.counts.reduce((sum, item) => sum + item.count, 0);
  const title = `${total} ${total === 1 ? 'action' : 'actions'} · ${action.fileCount} modified ${action.fileCount === 1 ? 'file' : 'files'} · ${action.failureCount} ${action.failureCount === 1 ? 'failure' : 'failures'}`;
  return (
    <View
      style={{
        minWidth: 0,
        padding: 10,
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
      }}
    >
      <View style={{ alignItems: 'flex-start' }}>
        <ActivityButton
          theme={theme}
          label={expanded ? 'Hide execution details' : 'Show execution details'}
          expanded={expanded}
          onPress={() => setExpanded(!expanded)}
        >
          <Text style={{ color: theme.colors.foreground }}>{title}</Text>
        </ActivityButton>
      </View>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        {action.counts.map(({ kind, count }) => `${kind} ${count}`).join(' · ')}
      </Text>
      {action.files.length > 0 && (
        <Text selectable style={{ color: theme.colors.foreground }}>
          {action.files
            .map(
              ({ path, counts }) =>
                `${path} · ${counts.map(({ kind, count }) => `${kind} ${count}`).join(' · ')}`,
            )
            .join('\n')}
          {action.pathCount > action.files.length &&
            `\n${action.pathCount - action.files.length} more paths`}
        </Text>
      )}
      {action.checks.map(({ seq, text }, index) => (
        <Text key={`${seq}:${index}`} selectable style={{ color: theme.colors.foreground }}>
          {text} · #{seq}
        </Text>
      ))}
      {action.checkCount > action.checks.length && (
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {action.checkCount - action.checks.length} more verification outcomes
        </Text>
      )}
      {expanded && <EvidenceList agentId={agentId} record={record} theme={theme} />}
    </View>
  );
}

function Discussion({ record, theme }: { record: MemoryRecord; theme: Theme }) {
  const status = {
    skipped: 'Not summarized, user-agent message pair is below 256 tokens.',
    pending: 'Summary pending.',
    failed: 'Summarization failed.',
  } as const;
  if (record.state in status) {
    return (
      <Text style={{ color: theme.colors.foregroundMuted }}>
        {status[record.state as keyof typeof status]}
      </Text>
    );
  }
  const markdown = record.parts
    .map(({ content }) => (typeof content === 'string' ? content : ''))
    .join('\n\n')
    .trim();
  if (!markdown)
    return <Text style={{ color: theme.colors.foregroundMuted }}>No details were recorded.</Text>;
  return <Markdown>{markdown}</Markdown>;
}

export function MemoryRecords({
  agentId,
  records,
  theme,
}: {
  agentId: string;
  records: readonly MemoryRecord[];
  theme: Theme;
}) {
  const discussions = new Set(records.filter(({ type }) => type === 'UAMP').map(({ id }) => id));
  const batches = new Map<string, MemoryRecord[]>();
  const independent = records.filter((record) => {
    const { discussionId } = record;
    if (record.type !== 'AAB' || !discussionId || !discussions.has(discussionId)) return true;
    const related = batches.get(discussionId) ?? [];
    related.push(record);
    batches.set(discussionId, related);
    return false;
  });
  return (
    <View style={{ gap: 10 }}>
      {independent.map((record) => (
        <View key={`${record.epoch}:${record.id}`} style={{ gap: 6 }}>
          {record.type === 'UAMP' ? (
            <>
              <Discussion record={record} theme={theme} />
              {batches
                .get(record.id)
                ?.slice()
                .reverse()
                .map((batch) => (
                  <ExecutionCard key={batch.id} agentId={agentId} record={batch} theme={theme} />
                ))}
            </>
          ) : (
            <ExecutionCard agentId={agentId} record={record} theme={theme} />
          )}
        </View>
      ))}
    </View>
  );
}
