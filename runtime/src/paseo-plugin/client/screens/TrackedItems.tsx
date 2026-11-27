import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import {
  useAgent,
  useRpc,
  useSubscription,
  useTabState,
  type PluginAgentPanelProps,
} from '@getpaseo/plugin/client';
import { Icon, ScrollView, TextInput, useToast } from '@getpaseo/plugin/client/ui';
import { z } from 'zod';
import type { ActivityAnchor } from '../../shared/activity';
import {
  trackerModifyRpc,
  trackerSubscription,
  type TrackerModification,
  type TrackerSnapshot,
} from '../../shared/tracker';
import { activityColor } from '../components/ActivityCard';
import { TrackerButton, TrackerNotice, TrackerText } from '../components/TrackerControls';
import { presentTracker } from '../tracker-presentation';
import { TrackedItem, type TrackerSource as Source } from '../components/TrackedItem';
import { TrackerCoverage } from '../components/TrackerCoverage';
import { TrackerCopyNotes } from '../components/TrackerCopyNotes';
import {
  TrackerEditorDialog,
  TrackerServiceDialog,
  TrackerConfirmationDialog,
  trackerDraftSchema,
  type TrackerDraft as Draft,
  type TrackerConfirmation as Confirmation,
} from '../components/TrackerDialogs';

type Navigation = NonNullable<PluginAgentPanelProps['navigation']> & {
  revealTimelineItem?: (input: {
    agentId: string;
    serverId: string;
    target: ActivityAnchor;
  }) => Promise<void>;
};

const notebookStateSchema = z.object({
  trackerId: z.string().nullable(),
  view: z.enum(['notebook', 'coverage']),
  query: z.string(),
  draft: trackerDraftSchema.nullable(),
});
const row = { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 } as const;

function TrackerNotebook({ params, theme, navigation, host, tab, layout }: PluginAgentPanelProps) {
  const { agentId } = params;
  const toast = useToast();
  const title = useAgent(agentId, (agent) => agent.title) ?? 'Conversation';
  const update = useRpc(trackerModifyRpc);
  const [snapshot, setSnapshot] = useState<TrackerSnapshot>();
  const [saving, setSaving] = useState(false);
  const [width, setWidth] = useState(900);
  const [editorVisible, setEditorVisible] = useState(true);
  const [serviceOpen, setServiceOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [state, setState] = useTabState(tab, notebookStateSchema, {
    trackerId: null,
    view: 'notebook',
    query: '',
    draft: null,
  });
  const currentState = useRef(state);
  currentState.current = state;
  const stream = useSubscription(trackerSubscription, { agentId }, setSnapshot);
  const stale = stream.status === 'error' || stream.status === 'closed';
  const narrow = width < 680 || layout.compact;
  const draft = state.draft;
  const reveal = (navigation as Navigation | undefined)?.revealTimelineItem;
  const disabled = saving || stale;

  useEffect(() => {
    tab.setModified(Boolean(draft));
  }, [tab, draft]);

  async function modify(change: TrackerModification, dismissDraft = false) {
    const submittedDraft = currentState.current.draft;
    setSaving(true);
    try {
      setSnapshot(await update({ agentId, modification: change }));
      const latest = currentState.current;
      const removedDraftTracker =
        change.type !== 'remove' ||
        (submittedDraft?.type === 'edit' && submittedDraft.id === change.id) ||
        (submittedDraft?.type === 'item' && submittedDraft.trackerId === change.id);
      if (
        dismissDraft &&
        removedDraftTracker &&
        JSON.stringify(latest.draft) === JSON.stringify(submittedDraft)
      )
        setState({ ...latest, draft: null });
      setConfirmation(undefined);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update Tracker.');
    } finally {
      setSaving(false);
    }
  }
  function edit(next: Draft) {
    if (draft) toast.show('Finish or discard your current edit before starting another.');
    else setState({ ...state, draft: next });
    setEditorVisible(true);
  }
  function showSource(source: Source) {
    const at = source.timestamp ? Date.parse(source.timestamp) : NaN;
    if (!reveal || !source.messageId || !source.author || !Number.isSafeInteger(at)) return;
    void reveal({
      agentId,
      serverId: host.id,
      target: {
        epoch: source.epoch,
        position: source.seq,
        kind: 'message',
        id: source.messageId,
        at,
      },
    }).catch(() => toast.error('This source could not be found in chat.'));
  }
  if (!snapshot)
    return (
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={{ flex: 1, minWidth: 0, minHeight: 0, padding: 28, gap: 12 }}
      >
        <TrackerText theme={theme} heading size={24} strong>
          Tracker
        </TrackerText>
        <TrackerText theme={theme} muted>
          {stale
            ? 'Tracker is unavailable. Reconnect to this host to load the notebook.'
            : 'Loading your notebook…'}
        </TrackerText>
      </View>
    );

  const all = presentTracker(snapshot);
  const selected = snapshot.trackers.find(({ id }) => id === state.trackerId);
  const current = presentTracker(snapshot, selected?.id);
  const query = state.query.trim().toLocaleLowerCase();
  const groups = current.trackers.map((tracker) => ({
    tracker,
    items: tracker.items.filter((item) => !query || item.text.toLocaleLowerCase().includes(query)),
  }));
  const visibleCount = groups.reduce((sum, { items }) => sum + items.length, 0);

  function trackerNavigation(id: string | null, name: string, count: number, attention = false) {
    return (
      <View
        key={id ?? 'all'}
        style={{ gap: 3, maxWidth: '100%', alignSelf: narrow ? 'flex-start' : 'stretch' }}
      >
        <TrackerButton
          theme={theme}
          label={`${name}  ${count}`}
          icon={attention ? 'CircleAlert' : id ? 'Notebook' : 'Layers'}
          quiet
          selected={(selected?.id ?? null) === id}
          onPress={() => setState({ ...state, trackerId: id })}
        />
      </View>
    );
  }

  return (
    <View
      testID="ltcook-tracker"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, minWidth: 0, minHeight: 0, backgroundColor: theme.colors.surface0 }}
    >
      <View
        style={{
          paddingHorizontal: narrow ? 16 : 28,
          paddingTop: 14,
          paddingBottom: 10,
          gap: 10,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        <View style={{ ...row, justifyContent: 'space-between', gap: 10 }}>
          <View style={{ gap: 3, flex: 1, minWidth: 140 }}>
            <View style={row}>
              <Icon name="Notebook" size={22} color={theme.colors.accent} />
              <TrackerText theme={theme} heading strong size={24}>
                Tracker
              </TrackerText>
            </View>
            <TrackerText theme={theme} muted size={12}>
              {title} · Conversation notebook
            </TrackerText>
          </View>
          <View style={row}>
            <TrackerButton
              theme={theme}
              label="Service"
              icon="SlidersHorizontal"
              quiet
              onPress={() => setServiceOpen(true)}
            />
            <TrackerButton
              theme={theme}
              label="Add Tracker"
              icon="Plus"
              primary
              disabled={disabled}
              onPress={() => edit({ type: 'add', name: '', instructions: '' })}
            />
          </View>
        </View>
        <View style={{ ...row, justifyContent: 'space-between' }}>
          <View style={row}>
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: stale
                  ? theme.colors.statusWarning
                  : activityColor(theme, all.tone),
              }}
            />
            <TrackerText theme={theme} muted size={12}>
              {stale ? 'Disconnected · showing last received notebook' : all.stateLabel}
            </TrackerText>
            <TrackerText theme={theme} muted size={12}>
              · {all.itemCount} items in {all.trackerCount}{' '}
              {all.trackerCount === 1 ? 'Tracker' : 'Trackers'}
            </TrackerText>
          </View>
          {navigation && (
            <TrackerButton
              theme={theme}
              label="Conversation"
              icon="ArrowUpRight"
              quiet
              onPress={() => navigation.openAgent({ agentId, serverId: host.id })}
            />
          )}
        </View>
        {(snapshot.historyUnavailable || all.gapMessages > 0) && (
          <TrackerNotice
            theme={theme}
            warning
            action={
              <TrackerButton
                theme={theme}
                label="Review coverage"
                icon="ArrowRight"
                quiet
                onPress={() => setState({ ...state, view: 'coverage', trackerId: null })}
              />
            }
          >
            <TrackerText theme={theme} strong size={12}>
              {all.coverageLabel}
            </TrackerText>
            <TrackerText theme={theme} muted size={12}>
              The notebook may be missing information from this conversation.
            </TrackerText>
          </TrackerNotice>
        )}
        {draft && !editorVisible && (
          <TrackerNotice
            theme={theme}
            action={
              <View style={row}>
                <TrackerButton
                  theme={theme}
                  label="Resume edit"
                  onPress={() => setEditorVisible(true)}
                />
                <TrackerButton
                  theme={theme}
                  label="Discard draft"
                  quiet
                  onPress={() => setState({ ...state, draft: null })}
                />
              </View>
            }
          >
            <TrackerText theme={theme} size={12}>
              You have an unfinished edit.
            </TrackerText>
          </TrackerNotice>
        )}
      </View>
      <View style={{ flex: 1, minHeight: 0, flexDirection: narrow ? 'column' : 'row' }}>
        <ScrollView
          style={
            narrow
              ? { flexGrow: 0, maxHeight: 174 }
              : {
                  width: 218,
                  flexGrow: 0,
                  flexShrink: 0,
                  borderRightWidth: 1,
                  borderRightColor: theme.colors.border,
                }
          }
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingVertical: 10,
            gap: 5,
            ...(narrow ? { flexDirection: 'row', flexWrap: 'wrap' } : {}),
          }}
        >
          {!narrow && (
            <View style={{ paddingHorizontal: 11, paddingBottom: 7 }}>
              <TrackerText theme={theme} muted size={11} strong>
                TRACKERS
              </TrackerText>
            </View>
          )}
          {trackerNavigation(null, 'All items', all.itemCount)}
          {snapshot.trackers.map((tracker) =>
            trackerNavigation(
              tracker.id,
              tracker.name,
              tracker.items.length,
              all.blockedTrackerIds.includes(tracker.id),
            ),
          )}
          {!narrow && (
            <View style={{ paddingHorizontal: 11, marginTop: 10, gap: 8 }}>
              <TrackerText theme={theme} muted size={12}>
                Each Tracker follows the instructions you give it.
              </TrackerText>
              <TrackerText theme={theme} muted size={11}>
                {all.startLabel}
              </TrackerText>
            </View>
          )}
        </ScrollView>
        <ScrollView
          style={{ flex: 1, minWidth: 0 }}
          contentContainerStyle={{
            paddingHorizontal: narrow ? 16 : 28,
            paddingVertical: 12,
            gap: 12,
          }}
        >
          <View style={{ maxWidth: 960, width: '100%', alignSelf: 'center', gap: 10 }}>
            <View style={{ ...row, justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1, minWidth: 150, gap: 5 }}>
                <TrackerText theme={theme} heading strong size={20}>
                  {selected?.name ?? 'All items'}
                </TrackerText>
                <TrackerText theme={theme} muted size={12}>
                  {selected
                    ? `${selected.items.length} tracked ${selected.items.length === 1 ? 'item' : 'items'}${selected.enabled ? '' : ' · Disabled'}`
                    : 'What this conversation is keeping track of.'}
                </TrackerText>
              </View>
              {selected && (
                <TrackerButton
                  theme={theme}
                  label="Edit Tracker"
                  icon="Settings2"
                  quiet
                  disabled={disabled}
                  onPress={() =>
                    edit({
                      type: 'edit',
                      id: selected.id,
                      name: selected.name,
                      instructions: selected.instructions,
                    })
                  }
                />
              )}
            </View>
            <View
              style={{
                ...row,
                justifyContent: 'space-between',
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.border,
                paddingBottom: 8,
              }}
            >
              <View style={row}>
                <TrackerButton
                  theme={theme}
                  label="Notes"
                  icon="NotebookPen"
                  quiet
                  selected={state.view === 'notebook'}
                  onPress={() => setState({ ...state, view: 'notebook' })}
                />
                <TrackerButton
                  theme={theme}
                  label={current.gapMessages ? `Coverage · ${current.gapMessages}` : 'Coverage'}
                  icon="ListChecks"
                  quiet
                  selected={state.view === 'coverage'}
                  onPress={() => setState({ ...state, view: 'coverage' })}
                />
              </View>
              {state.view === 'notebook' && (
                <View
                  style={{
                    ...row,
                    flexGrow: narrow ? 1 : 0,
                    flexShrink: 1,
                    minWidth: 160,
                    maxWidth: narrow ? '100%' : 260,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    borderRadius: 7,
                    paddingHorizontal: 10,
                  }}
                >
                  <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
                  <TextInput
                    accessibilityLabel="Find in notes"
                    placeholder="Find in notes…"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    value={state.query}
                    onChangeText={(query) => setState({ ...state, query })}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      color: theme.colors.foreground,
                      fontSize: 12,
                      paddingVertical: 6,
                    }}
                  />
                </View>
              )}
              <TrackerCopyNotes theme={theme} trackers={snapshot.trackers} />
            </View>
            {state.view === 'notebook' ? (
              <>
                {selected && (
                  <View
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 9,
                      borderRadius: 7,
                      backgroundColor: theme.colors.surface1,
                      gap: 5,
                    }}
                  >
                    <TrackerText theme={theme} muted size={11} strong>
                      WHAT TO TRACK
                    </TrackerText>
                    <TrackerText theme={theme} size={13}>
                      {selected.instructions}
                    </TrackerText>
                  </View>
                )}
                {groups
                  .filter(({ items }) => !query || items.length > 0)
                  .map(({ tracker, items }) => (
                    <View key={tracker.id} style={{ gap: 3 }}>
                      {!selected && (
                        <View style={{ ...row, justifyContent: 'space-between' }}>
                          <View style={{ ...row, flex: 1, minWidth: 0, maxWidth: '100%' }}>
                            <TrackerText theme={theme} heading strong size={15}>
                              {tracker.name}
                            </TrackerText>
                            <TrackerText theme={theme} muted size={12}>
                              {items.length}
                              {!tracker.enabled ? ' · Disabled' : ''}
                            </TrackerText>
                          </View>
                          <TrackerButton
                            theme={theme}
                            label="Edit Tracker"
                            icon="Settings2"
                            quiet
                            disabled={disabled}
                            onPress={() =>
                              edit({
                                type: 'edit',
                                id: tracker.id,
                                name: tracker.name,
                                instructions: tracker.instructions,
                              })
                            }
                          />
                        </View>
                      )}
                      {items.map((item) => (
                        <TrackedItem
                          key={item.id}
                          item={item}
                          theme={theme}
                          disabled={disabled}
                          onReveal={reveal ? showSource : undefined}
                          onEdit={() =>
                            edit({
                              type: 'item',
                              trackerId: tracker.id,
                              itemId: item.id,
                              text: item.text,
                            })
                          }
                          onRemove={() =>
                            setConfirmation({
                              title: 'Remove item?',
                              detail:
                                'This item will be removed from the notebook. Your deletion is preserved when conversation history is replayed.',
                              label: 'Remove item',
                              change: {
                                type: 'item',
                                trackerId: tracker.id,
                                itemId: item.id,
                                text: null,
                              },
                            })
                          }
                        />
                      ))}
                      {!items.length && !query && (
                        <View style={{ paddingVertical: 22 }}>
                          <TrackerText theme={theme} muted>
                            {tracker.enabled
                              ? 'No items yet. New conversation messages will be checked against these instructions.'
                              : 'This Tracker is disabled. Enable it in Edit Tracker to process new messages.'}
                          </TrackerText>
                        </View>
                      )}
                    </View>
                  ))}
                {query && visibleCount === 0 && (
                  <TrackerNotice
                    theme={theme}
                    action={
                      <TrackerButton
                        theme={theme}
                        label="Clear search"
                        quiet
                        onPress={() => setState({ ...state, query: '' })}
                      />
                    }
                  >
                    <TrackerText theme={theme}>No items match “{state.query}”.</TrackerText>
                  </TrackerNotice>
                )}
                {snapshot.trackers.length === 0 && (
                  <View style={{ paddingVertical: 28, gap: 12 }}>
                    <Icon name="NotebookPen" size={28} color={theme.colors.foregroundMuted} />
                    <TrackerText theme={theme} heading strong size={18}>
                      Keep the details that matter
                    </TrackerText>
                    <TrackerText theme={theme} muted>
                      Add a Tracker and describe what it should record, such as decisions or open
                      questions. It will maintain items as the conversation continues.
                    </TrackerText>
                    <View style={row}>
                      <TrackerButton
                        theme={theme}
                        label="Add your first Tracker"
                        icon="Plus"
                        primary
                        disabled={disabled}
                        onPress={() => edit({ type: 'add', name: '', instructions: '' })}
                      />
                    </View>
                  </View>
                )}
              </>
            ) : (
              <TrackerCoverage
                theme={theme}
                snapshot={snapshot}
                trackerId={selected?.id}
                disabled={disabled}
                onReveal={reveal ? showSource : undefined}
                onRetry={(trackerId, source) => void modify({ type: 'retry', trackerId, source })}
                onSkip={(trackerId, source) =>
                  setConfirmation({
                    title: 'Skip this message?',
                    detail:
                      'Later messages can continue, but this message will remain a visible gap in the notebook’s coverage.',
                    label: 'Skip blocked message',
                    change: { type: 'skip', trackerId, source },
                  })
                }
              />
            )}
          </View>
        </ScrollView>
      </View>
      <TrackerEditorDialog
        theme={theme}
        draft={draft}
        trackers={snapshot.trackers}
        open={editorVisible}
        saving={saving}
        stale={stale}
        onOpenChange={setEditorVisible}
        onDraftChange={(next) => setState({ ...state, draft: next })}
        onModify={modify}
        onConfirm={setConfirmation}
      />
      <TrackerServiceDialog
        theme={theme}
        snapshot={snapshot}
        open={serviceOpen}
        disabled={disabled}
        onOpenChange={setServiceOpen}
        onModify={modify}
      />
      <TrackerConfirmationDialog
        theme={theme}
        confirmation={confirmation}
        saving={saving}
        disabled={disabled}
        onCancel={() => setConfirmation(undefined)}
        onConfirm={() => {
          if (confirmation) void modify(confirmation.change, confirmation.change.type === 'remove');
        }}
      />
    </View>
  );
}

export function TrackedItems(props: PluginAgentPanelProps) {
  return <TrackerNotebook {...props} key={`${props.host.id}:${props.params.agentId}`} />;
}
