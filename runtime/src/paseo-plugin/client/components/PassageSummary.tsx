import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import {
  useAgent,
  useRpc,
  useSubscription,
  type PluginClientContext,
  type PluginTimelineItemProps,
} from '@getpaseo/plugin/client';
import { Modal, useToast } from '@getpaseo/plugin/client/ui';
import type { z } from 'zod';
import {
  storedSummariesRpc,
  activitySubscription,
  memoryRedoRpc,
  type ActivitySnapshot,
  type MemorySummariesTimelineSchema,
  type StoredSummariesPage,
  type SkillLoad,
} from '../../shared/activity';
import { ActivityButton } from './ActivityCard';
import type { Theme } from './PanelChrome';
import { MemoryRecords } from './MemoryRecords';
import { openSkillDocument, SkillPreview } from '../screens/SkillDocument';

type TimelineData = z.infer<typeof MemorySummariesTimelineSchema>;
type Passage = NonNullable<TimelineData['passage']>;
type Summaries = StoredSummariesPage['summaries'];
type SummaryRead =
  | { status: 'loading' | 'error' }
  | { status: 'ready'; summaries: Summaries; next: StoredSummariesPage['next'] };

function PassageRedoProgress({
  agentId,
  requestId,
  theme,
  onComplete,
  onFailure,
}: {
  agentId: string;
  requestId: string;
  theme: Theme;
  onComplete: () => void;
  onFailure: (message: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>();
  const callbacks = useRef({ onComplete, onFailure });
  callbacks.current = { onComplete, onFailure };
  const stream = useSubscription(activitySubscription, { agentId }, (next) => {
    if (next.selectedAgentId !== agentId || next.agent.id !== agentId) return;
    setSnapshot((current) => (!current || next.revision > current.revision ? next : current));
  });
  const status =
    snapshot?.memory.redos.find(({ id }) => id === requestId) ??
    (snapshot?.memory.redo?.id === requestId ? snapshot.memory.redo : undefined);
  const unavailable = stream.status === 'closed' || stream.status === 'error';

  useEffect(() => {
    if (status?.id === requestId && status.state === 'completed') {
      callbacks.current.onComplete();
    } else if (status?.id === requestId && status.state === 'failed') {
      callbacks.current.onFailure(status.error ?? 'Session Memory could not complete this redo.');
    } else if (unavailable) {
      callbacks.current.onFailure('Could not track this redo. Reopen the summary to check it.');
    }
  }, [requestId, status, unavailable]);

  return (
    <Text
      accessibilityLiveRegion="polite"
      style={{
        color:
          status?.state === 'failed' ? theme.colors.statusDanger : theme.colors.foregroundMuted,
      }}
    >
      {status?.id !== requestId || status.state === 'queued'
        ? 'Redo queued…'
        : status.state === 'running'
          ? 'Redo in progress…'
          : status.state === 'completed'
            ? 'Redo complete.'
            : (status.error ?? 'Session Memory redo failed.')}
    </Text>
  );
}

function PassageSummaryCard({
  agentId,
  passage,
  skills,
  onOpenSkill,
  theme,
}: {
  agentId: string;
  passage?: Passage;
  skills: SkillLoad[];
  onOpenSkill?: (skill: SkillLoad) => void;
  theme: Theme;
}) {
  const read = useRpc(storedSummariesRpc);
  const startRedo = useRpc(memoryRedoRpc);
  const [expanded, setExpanded] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string>();
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId);
  const [result, setResult] = useState<SummaryRead>();
  const sendingRedo = useRef(false);
  const [startingRedo, setStartingRedo] = useState(false);
  const [redoRequestId, setRedoRequestId] = useState<string>();
  const [redoError, setRedoError] = useState<string>();
  const [redoComplete, setRedoComplete] = useState(false);
  const request = useRef(0);
  const summaries = result?.status === 'ready' ? result.summaries : [];
  const empty = result?.status === 'ready' && summaries.length === 0;
  const hasOlderRecords = result?.status === 'ready' && !!result.next;
  const openLabel = hasOlderRecords ? 'Open loaded summaries' : 'Open complete summary';
  const modalTitle = hasOlderRecords ? 'Loaded passage summaries' : 'Complete passage summary';
  const toggleLabel = expanded ? 'Hide summary' : 'Show summary';

  async function loadSummary(older = false) {
    if (!passage) return;
    const previous = older && result?.status === 'ready' ? result : undefined;
    const current = ++request.current;
    setResult({ status: 'loading' });
    try {
      const page = await read({
        agentId,
        includeContent: true,
        passage,
        before: previous?.next ?? undefined,
      });
      if (current !== request.current) return;
      setResult({
        status: 'ready',
        summaries: [...(previous?.summaries ?? []), ...page.summaries],
        next: page.next,
      });
    } catch {
      if (current === request.current) setResult({ status: 'error' });
    }
  }

  function toggleSummary() {
    setExpanded(!expanded);
    if (!expanded) void loadSummary();
  }

  async function redoPassage() {
    if (!passage || sendingRedo.current || redoRequestId) return;
    sendingRedo.current = true;
    setStartingRedo(true);
    setRedoError(undefined);
    setRedoComplete(false);
    try {
      const request = await startRedo({ agentId, scope: 'passage', passage });
      setRedoRequestId(request.id);
    } catch (error) {
      setRedoError(error instanceof Error ? error.message : 'Could not start Session Memory redo.');
    } finally {
      sendingRedo.current = false;
      setStartingRedo(false);
    }
  }

  return (
    <View style={{ minWidth: 0, gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        {passage && (
          <ActivityButton
            theme={theme}
            label={toggleLabel}
            expanded={expanded}
            onPress={toggleSummary}
          >
            <Text style={{ color: theme.colors.foreground }}>{toggleLabel}</Text>
          </ActivityButton>
        )}
        {skills.map((skill) => (
          <ActivityButton
            key={skill.id}
            theme={theme}
            label={`Preview skill ${skill.name}`}
            expanded={selectedSkill?.id === skill.id}
            onPress={() =>
              setSelectedSkillId(selectedSkill?.id === skill.id ? undefined : skill.id)
            }
          >
            <Text style={{ color: theme.colors.foreground }}>{skill.name}</Text>
          </ActivityButton>
        ))}
      </View>
      {selectedSkill && (
        <View
          testID="ltcook-passage-skill-preview"
          style={{
            gap: 8,
            padding: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <SkillPreview
            key={selectedSkill.id}
            agentId={agentId}
            skill={selectedSkill}
            theme={theme}
          />
          {selectedSkill.documentAvailable && onOpenSkill && (
            <View style={{ alignItems: 'flex-start' }}>
              <ActivityButton
                theme={theme}
                label="Open in new tab"
                onPress={() => onOpenSkill(selectedSkill)}
              >
                <Text style={{ color: theme.colors.foreground }}>Open in new tab</Text>
              </ActivityButton>
            </View>
          )}
        </View>
      )}
      {(expanded || startingRedo || redoRequestId) && (
        <View
          testID="ltcook-passage-summary-preview"
          style={{
            display: expanded ? 'flex' : 'none',
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
          {hasOlderRecords && (
            <View style={{ alignItems: 'flex-start' }}>
              <ActivityButton
                theme={theme}
                label="Load older passage records"
                onPress={() => void loadSummary(true)}
              >
                <Text style={{ color: theme.colors.foreground }}>Load older passage records</Text>
              </ActivityButton>
            </View>
          )}
          {summaries.length > 0 && (
            <>
              <MemoryRecords agentId={agentId} records={summaries} theme={theme} />
              <View style={{ alignItems: 'flex-start' }}>
                <ActivityButton
                  theme={theme}
                  label={openLabel}
                  onPress={() => setCompleteOpen(true)}
                >
                  <Text style={{ color: theme.colors.foreground }}>{openLabel}</Text>
                </ActivityButton>
              </View>
            </>
          )}
          {redoRequestId && (
            <PassageRedoProgress
              agentId={agentId}
              requestId={redoRequestId}
              theme={theme}
              onComplete={() => {
                setRedoRequestId(undefined);
                setRedoComplete(true);
                void loadSummary();
              }}
              onFailure={(message) => {
                setRedoRequestId(undefined);
                setRedoError(message);
              }}
            />
          )}
          {startingRedo && (
            <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>
              Starting redo…
            </Text>
          )}
          {redoError && (
            <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
              {redoError}
            </Text>
          )}
          {redoComplete && (
            <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>
              Redo complete.
            </Text>
          )}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {summaries.length > 0 && !startingRedo && !redoRequestId && (
              <ActivityButton
                theme={theme}
                label="Redo this passage summary"
                onPress={() => void redoPassage()}
              >
                <Text style={{ color: theme.colors.foreground }}>Redo</Text>
              </ActivityButton>
            )}
            <ActivityButton
              theme={theme}
              label="Hide summary"
              expanded
              onPress={() => setExpanded(false)}
            >
              <Text style={{ color: theme.colors.foreground }}>Hide summary</Text>
            </ActivityButton>
          </View>
        </View>
      )}
      {completeOpen && (
        <Modal title={modalTitle} open={completeOpen} onOpenChange={setCompleteOpen}>
          <Modal.Content contentContainerStyle={{ padding: 12 }}>
            <View testID="ltcook-passage-summary-complete">
              <MemoryRecords agentId={agentId} records={summaries} theme={theme} />
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
  client,
}: PluginTimelineItemProps<TimelineData> & { client: Pick<PluginClientContext, 'openPanel'> }) {
  const { passage, skills = [] } = item.data;
  const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  const toast = useToast();
  if (!passage && skills.length === 0) return null;

  function open(skill: SkillLoad) {
    if (!workspaceId) return;
    try {
      openSkillDocument(client, host.id, workspaceId, agentId, skill);
    } catch {
      toast.error('Could not open the skill document.');
    }
  }

  return (
    <PassageSummaryCard
      key={JSON.stringify([host.id, agentId, passage?.epoch, passage?.start, passage?.position])}
      agentId={agentId}
      passage={passage}
      skills={skills}
      onOpenSkill={workspaceId ? open : undefined}
      theme={theme}
    />
  );
}
