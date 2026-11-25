import { useState } from 'react';
import { Text, View } from 'react-native';
import { useRpc, type PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { Modal } from '@getpaseo/plugin/client/ui';
import type { z } from 'zod';
import {
  storedSummariesRpc,
  type MemorySummariesTimelineSchema,
  type StoredSummariesPage,
} from '../../shared/activity';
import { ActivityButton } from './ActivityCard';
import type { Theme } from './PanelChrome';

type TimelineData = z.infer<typeof MemorySummariesTimelineSchema>;
type Passage = NonNullable<TimelineData['passage']>;
type Summaries = StoredSummariesPage['summaries'];
type SummaryValue = Summaries[number]['parts'][number]['content'];
type SummaryRow = { fields: string[]; text: string; bullet: boolean };
type SummaryRead = { status: 'loading' | 'error' } | { status: 'ready'; summaries: Summaries };

const previewRowLimit = 6;

function fieldTitle(field: string): string {
  const words = field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field;
}

function* valueRows(value: SummaryValue, fields: string[], bullet = false): Generator<SummaryRow> {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const itemFields =
        item !== null && typeof item === 'object' ? [...fields, `Item ${index + 1}`] : fields;
      yield* valueRows(item, itemFields, true);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [field, item] of Object.entries(value)) {
      yield* valueRows(item, [...fields, fieldTitle(field)]);
    }
    return;
  }
  if (value === null) return;
  const text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value).trim();
  if (text) yield { fields, text, bullet };
}

function* summaryRows(summaries: Summaries): Generator<SummaryRow> {
  for (const summary of summaries) {
    const fields = summaries.length > 1 ? [summary.type] : [];
    for (const [index, part] of summary.parts.entries()) {
      const partFields = summary.parts.length > 1 ? [...fields, `Part ${index + 1}`] : fields;
      yield* valueRows(part.content, partFields);
    }
  }
}

function SummaryContent({
  summaries,
  theme,
  preview = false,
}: {
  summaries: Summaries;
  theme: Theme;
  preview?: boolean;
}) {
  const rows: SummaryRow[] = [];
  for (const row of summaryRows(summaries)) {
    rows.push(row);
    if (preview && rows.length === previewRowLimit) break;
  }
  if (rows.length === 0) {
    return <Text style={{ color: theme.colors.foregroundMuted }}>No details were recorded.</Text>;
  }

  return (
    <View style={{ gap: 5 }}>
      {rows.map(({ fields, text, bullet }, index) => {
        const heading = fields.join(' › ');
        const showHeading = heading && heading !== rows[index - 1]?.fields.join(' › ');
        return (
          <View key={index} style={{ gap: 3 }}>
            {showHeading ? (
              <Text
                accessibilityRole="header"
                numberOfLines={preview ? 2 : undefined}
                style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: '600' }}
              >
                {heading}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {bullet && (
                <Text accessibilityElementsHidden style={{ color: theme.colors.foregroundMuted }}>
                  •
                </Text>
              )}
              <Text
                selectable={!preview}
                numberOfLines={preview ? 3 : undefined}
                style={{
                  color: theme.colors.foreground,
                  fontSize: 14,
                  lineHeight: 20,
                  flexShrink: 1,
                }}
              >
                {text}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function PassageSummaryCard({
  agentId,
  passage,
  theme,
}: {
  agentId: string;
  passage: Passage;
  theme: Theme;
}) {
  const read = useRpc(storedSummariesRpc);
  const [expanded, setExpanded] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [result, setResult] = useState<SummaryRead>();
  const summaries = result?.status === 'ready' ? result.summaries : [];
  const empty = result?.status === 'ready' && summaries.length === 0;
  const toggleLabel = expanded ? 'Hide summary' : 'Show summary';

  async function loadSummary() {
    setResult({ status: 'loading' });
    try {
      const page = await read({ agentId, includeContent: true, passage });
      setResult({ status: 'ready', summaries: page.summaries });
    } catch {
      setResult({ status: 'error' });
    }
  }

  function toggleSummary() {
    setExpanded(!expanded);
    if (!expanded && (!result || empty || result.status === 'error')) void loadSummary();
  }

  return (
    <View style={{ minWidth: 0, gap: 8 }}>
      <View style={{ alignItems: 'flex-start' }}>
        <ActivityButton
          theme={theme}
          label={toggleLabel}
          expanded={expanded}
          onPress={toggleSummary}
        >
          <Text style={{ color: theme.colors.foreground }}>{toggleLabel}</Text>
        </ActivityButton>
      </View>
      {expanded && (
        <View
          testID="ltcook-passage-summary-preview"
          style={{
            gap: 8,
            padding: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          }}
        >
          {result?.status === 'loading' && (
            <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>
              Loading summary…
            </Text>
          )}
          {result?.status === 'error' && (
            <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
              This passage’s summary could not be loaded.
            </Text>
          )}
          {empty && (
            <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>
              No stored summary for this passage yet.
            </Text>
          )}
          {(empty || result?.status === 'error') && (
            <View style={{ alignItems: 'flex-start' }}>
              <ActivityButton
                theme={theme}
                label="Retry summary"
                onPress={() => void loadSummary()}
              >
                <Text style={{ color: theme.colors.foreground }}>Retry summary</Text>
              </ActivityButton>
            </View>
          )}
          {summaries.length > 0 && (
            <>
              <SummaryContent summaries={summaries} theme={theme} preview />
              <View style={{ alignItems: 'flex-start' }}>
                <ActivityButton
                  theme={theme}
                  label="Open complete summary"
                  onPress={() => setCompleteOpen(true)}
                >
                  <Text style={{ color: theme.colors.foreground }}>Open complete summary</Text>
                </ActivityButton>
              </View>
            </>
          )}
        </View>
      )}
      {completeOpen && (
        <Modal title="Complete passage summary" open={completeOpen} onOpenChange={setCompleteOpen}>
          <Modal.Content contentContainerStyle={{ padding: 12 }}>
            <View testID="ltcook-passage-summary-complete">
              <SummaryContent summaries={summaries} theme={theme} />
            </View>
          </Modal.Content>
        </Modal>
      )}
    </View>
  );
}

export function PassageSummary({
  agentId,
  host,
  item,
  theme,
}: PluginTimelineItemProps<TimelineData>) {
  const { passage } = item.data;
  if (!passage) return null;
  return (
    <PassageSummaryCard
      key={JSON.stringify([host.id, agentId, passage.epoch, passage.position])}
      agentId={agentId}
      passage={passage}
      theme={theme}
    />
  );
}
