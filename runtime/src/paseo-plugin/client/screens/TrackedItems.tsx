import { useState } from 'react';
import { View } from 'react-native';
import {
  useAgent,
  useRpc,
  useSubscription,
  type PluginClientContext,
  type PluginWorkspacePanelProps,
} from '@getpaseo/plugin/client';
import { ScrollView, TextInput, useToast } from '@getpaseo/plugin/client/ui';
import type { ActivityAnchor } from '../../shared/activity';
import {
  trackerModifyRpc,
  trackerSubscription,
  type TrackerModification,
  type TrackerSnapshot,
} from '../../shared/tracker';
import { Action, Card, Label } from '../components/PanelChrome';
import { useFocusedAgent } from '../explorer-panels';

type Props = PluginWorkspacePanelProps & { client: Pick<PluginClientContext, 'composers'> };
type Navigation = NonNullable<Props['navigation']> & {
  revealTimelineItem?: (input: {
    agentId: string;
    serverId: string;
    target: ActivityAnchor;
  }) => Promise<void>;
};
type Tracker = TrackerSnapshot['trackers'][number];
type Item = Tracker['items'][number];
type Source = Item['sources'][number];
type Editor =
  | { type: 'add'; name: string; instructions: string }
  | { type: 'edit'; id: string; name: string; instructions: string }
  | { type: 'item'; trackerId: string; itemId: string; text: string };

const statuses = {
  pending: 'Queued',
  changes: 'Changes applied',
  'no-change': 'Processed, no changes',
  incomplete: 'Incomplete coverage',
  failed: 'Extraction failed',
  paused: 'Skipped while paused or disabled',
  skipped: 'Skipped, coverage incomplete',
} as const;

const gapReasons = {
  budget:
    'The input exceeds the Tracker budget. Reduce the input or increase the budget before retrying.',
  source: 'The original message or earlier evidence is unavailable.',
  changed: 'The Tracker or an item changed during extraction.',
  configuration: 'Check the configured inference provider and model.',
  authentication: 'Restore sign-in or credentials for the configured inference provider.',
  transient: 'The inference provider could not complete the request.',
  output: 'The extraction did not return usable evidence and changes.',
} as const;

function editorFor(item: Item, tracker: Tracker): Editor {
  return { type: 'item', trackerId: tracker.id, itemId: item.id, text: item.text };
}

function ObservedTrackedItems({ agentId, theme, navigation, host }: Props & { agentId: string }) {
  const toast = useToast();
  const update = useRpc(trackerModifyRpc);
  const [snapshot, setSnapshot] = useState<TrackerSnapshot>();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<Editor>();
  const [saving, setSaving] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const stream = useSubscription(trackerSubscription, { agentId }, setSnapshot);
  const stale = stream.status === 'error' || stream.status === 'closed';
  const reveal = (navigation as Navigation | undefined)?.revealTimelineItem;
  const fields = {
    color: theme.colors.foreground,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 6,
    padding: 8,
  };

  async function modify(modification: TrackerModification, dismissEditor = false) {
    setSaving(true);
    try {
      setSnapshot(await update({ agentId, modification }));
      if (dismissEditor) setEditor(undefined);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update Tracked Items.');
    } finally {
      setSaving(false);
    }
  }

  function editForm(draft: Editor) {
    const canSave =
      draft.type === 'item'
        ? Boolean(draft.text.trim())
        : Boolean(draft.name.trim() && draft.instructions.trim());
    return (
      <Card theme={theme}>
        {draft.type === 'item' ? (
          <TextInput
            accessibilityLabel="Tracked Item text"
            multiline
            maxLength={12000}
            value={draft.text}
            onChangeText={(text) => setEditor({ ...draft, text })}
            style={fields}
          />
        ) : (
          <>
            <TextInput
              accessibilityLabel="Tracker name"
              placeholder="Tracker name"
              placeholderTextColor={theme.colors.foregroundMuted}
              maxLength={80}
              value={draft.name}
              onChangeText={(name) => setEditor({ ...draft, name })}
              style={fields}
            />
            <TextInput
              accessibilityLabel="What should this Tracker record?"
              placeholder="What should this Tracker record?"
              placeholderTextColor={theme.colors.foregroundMuted}
              multiline
              maxLength={8000}
              value={draft.instructions}
              onChangeText={(instructions) => setEditor({ ...draft, instructions })}
              style={fields}
            />
          </>
        )}
        <Action
          theme={theme}
          title="Save"
          disabled={saving || !canSave}
          onPress={() => void modify(draft, true)}
        />
        <Action
          theme={theme}
          title="Cancel"
          disabled={saving}
          onPress={() => setEditor(undefined)}
        />
      </Card>
    );
  }

  function showSource(source: Source) {
    const at = source.timestamp ? Date.parse(source.timestamp) : NaN;
    const label = `Message #${source.seq}`;
    if (!source.messageId || !source.author || !Number.isSafeInteger(at) || !reveal)
      return (
        <Label theme={theme} muted>
          {label}
        </Label>
      );
    const target: ActivityAnchor = {
      epoch: source.epoch,
      position: source.seq,
      kind: 'message',
      id: source.messageId,
      at,
    };
    return (
      <Action
        theme={theme}
        title={`Show ${label.toLowerCase()} in chat`}
        onPress={() =>
          void reveal({ agentId, serverId: host.id, target }).catch(() =>
            toast.error('This source could not be found in chat.'),
          )
        }
      />
    );
  }

  if (!snapshot) {
    return (
      <View style={{ padding: 12 }}>
        <Label theme={theme} muted>
          {stale ? 'Tracked Items are unavailable.' : 'Loading Tracked Items…'}
        </Label>
      </View>
    );
  }
  const gaps = snapshot.events.filter((event) =>
    event.trackers.some(
      ({ status }) => status === 'incomplete' || status === 'failed' || status === 'skipped',
    ),
  ).length;
  const pending = snapshot.events.filter((event) =>
    event.trackers.some(({ status }) => status === 'pending'),
  ).length;
  const coverage = snapshot.historyUnavailable
    ? 'Some conversation history is unavailable'
    : gaps
      ? `${gaps} messages with gaps`
      : 'No recorded gaps';
  const trackersById = new Map(snapshot.trackers.map((tracker) => [tracker.id, tracker]));
  const firstOutstanding = new Map<string, { seq: number; blocked: boolean }>();
  for (const { source, trackers } of snapshot.events) {
    for (const { trackerId, status } of trackers) {
      const blocked = status === 'incomplete' || status === 'failed';
      if ((blocked || status === 'pending') && !firstOutstanding.has(trackerId))
        firstOutstanding.set(trackerId, { seq: source.seq, blocked });
    }
  }
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 10 }}>
      {stale && (
        <Label theme={theme} muted>
          Updates are disconnected.
        </Label>
      )}
      <Label theme={theme} muted>
        {snapshot.mode === 'hosted'
          ? 'Hosted Tracker sends new message text, relevant earlier text, and item text to OpenAI through Codex.'
          : 'Tracker uses Local inference.'}
      </Label>
      <Action
        theme={theme}
        title={snapshot.paused ? 'Resume Tracker everywhere' : 'Pause Tracker everywhere'}
        disabled={saving || stale}
        onPress={() => void modify({ type: 'pause', paused: !snapshot.paused })}
      />
      <Action
        theme={theme}
        title="Add Tracker"
        disabled={saving || stale}
        onPress={() => setEditor({ type: 'add', name: '', instructions: '' })}
      />
      {editor?.type === 'add' && editForm(editor)}
      {snapshot.trackers.map((tracker) => (
        <Card key={tracker.id} theme={theme}>
          <Action
            theme={theme}
            title={`${tracker.name} (${tracker.items.length})${!tracker.enabled ? ' · disabled' : firstOutstanding.get(tracker.id)?.blocked ? ' · blocked' : ''}`}
            selected={Boolean(open[tracker.id])}
            onPress={() =>
              setOpen((current) => ({ ...current, [tracker.id]: !current[tracker.id] }))
            }
          />
          {open[tracker.id] && (
            <>
              <Label theme={theme} muted>
                {tracker.instructions}
              </Label>
              {editor?.type === 'edit' && editor.id === tracker.id ? (
                editForm(editor)
              ) : (
                <Action
                  theme={theme}
                  title="Edit Tracker"
                  disabled={saving || stale}
                  onPress={() =>
                    setEditor({
                      type: 'edit',
                      id: tracker.id,
                      name: tracker.name,
                      instructions: tracker.instructions,
                    })
                  }
                />
              )}
              <Action
                theme={theme}
                title={tracker.enabled ? 'Disable Tracker' : 'Enable Tracker'}
                disabled={saving || stale}
                onPress={() =>
                  void modify({ type: 'enable', id: tracker.id, enabled: !tracker.enabled })
                }
              />
              {tracker.items.map((item) => (
                <Card key={item.id} theme={theme}>
                  <Label theme={theme}>{item.text}</Label>
                  {item.manual && (
                    <Label theme={theme} muted>
                      Manually maintained
                    </Label>
                  )}
                  {item.evidenceUnavailable && (
                    <Label theme={theme} muted>
                      Original evidence was removed.
                    </Label>
                  )}
                  {item.sources.map((source) => (
                    <View key={`${source.epoch}:${source.seq}`}>{showSource(source)}</View>
                  ))}
                  {editor?.type === 'item' &&
                  editor.trackerId === tracker.id &&
                  editor.itemId === item.id ? (
                    editForm(editor)
                  ) : (
                    <Action
                      theme={theme}
                      title="Edit item"
                      disabled={saving || stale}
                      onPress={() => setEditor(editorFor(item, tracker))}
                    />
                  )}
                  <Action
                    theme={theme}
                    title="Remove item"
                    disabled={saving || stale}
                    onPress={() =>
                      void modify(
                        { type: 'item', trackerId: tracker.id, itemId: item.id, text: null },
                        true,
                      )
                    }
                  />
                </Card>
              ))}
              <Action
                theme={theme}
                title="Remove Tracker"
                disabled={saving || stale}
                onPress={() => void modify({ type: 'remove', id: tracker.id }, true)}
              />
            </>
          )}
        </Card>
      ))}
      <Action
        theme={theme}
        title={`Coverage · ${coverage}${pending ? ` · ${pending} pending` : ''}`}
        selected={coverageOpen}
        onPress={() => setCoverageOpen(!coverageOpen)}
      />
      {coverageOpen && (
        <>
          {snapshot.startsAfter !== null && (
            <Label theme={theme} muted>
              Tracking starts after message #{snapshot.startsAfter}.
            </Label>
          )}
          {!snapshot.events.length && (
            <Label theme={theme} muted>
              No new messages recorded.
            </Label>
          )}
          {[...snapshot.events].reverse().map((event) => (
            <Card key={`${event.source.epoch}:${event.source.seq}`} theme={theme}>
              {showSource(event.source)}
              {event.trackers.map(({ trackerId, status, reason, detail }) => {
                const tracker = trackersById.get(trackerId);
                const first = firstOutstanding.get(trackerId);
                const blocked = first?.seq === event.source.seq && first.blocked;
                const skipped = status === 'skipped' && (!first || event.source.seq < first.seq);
                const source = { epoch: event.source.epoch, seq: event.source.seq };
                const disabled = saving || stale || snapshot.paused || !tracker?.enabled;
                return (
                  <View key={trackerId} style={{ gap: 4 }}>
                    <Label theme={theme} muted>
                      {tracker?.name ?? 'Removed Tracker'} · {statuses[status]}
                    </Label>
                    {reason && status !== 'pending' && (
                      <Label theme={theme} muted>
                        {detail ?? gapReasons[reason]}
                      </Label>
                    )}
                    {tracker && (blocked || skipped) && (
                      <Action
                        theme={theme}
                        title="Retry message"
                        disabled={disabled}
                        onPress={() => void modify({ type: 'retry', trackerId, source })}
                      />
                    )}
                    {tracker && blocked && (
                      <Action
                        theme={theme}
                        title="Skip blocked message"
                        disabled={disabled}
                        onPress={() => void modify({ type: 'skip', trackerId, source })}
                      />
                    )}
                  </View>
                );
              })}
            </Card>
          ))}
        </>
      )}
    </ScrollView>
  );
}

export function TrackedItems(props: Props) {
  const focused = useFocusedAgent(props.client, props.host.id);
  const workspaceId = useAgent(focused ?? '', (agent) => agent.workspaceId);
  if (!focused || workspaceId !== props.workspaceId)
    return (
      <View style={{ padding: 12 }}>
        <Label theme={props.theme} muted>
          Select a conversation to view Tracked Items.
        </Label>
      </View>
    );
  return (
    <ObservedTrackedItems {...props} key={`${props.host.id}:${focused.id}`} agentId={focused.id} />
  );
}
