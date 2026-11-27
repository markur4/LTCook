import { useRef, useState, type ElementRef } from 'react';
import { Text, View } from 'react-native';
import { useSubscription, type PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { Icon, ScrollView, useToast } from '@getpaseo/plugin/client/ui';
import { bugHunterSubscription, type BugHunterSnapshot as Snapshot } from '../../shared/bughunter';
import {
  ActivityButton,
  ActivityStatus,
  ActivityText,
  statusLabel,
} from '../components/ActivityCard';
import { Card, Label, type Theme } from '../components/PanelChrome';

export const BUG_HUNTER_PANEL_ID = 'bughunter';

type Hunt = Snapshot['hunts'][number];
type Conversation = Hunt['conversations'][number];

const row = { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 } as const;

function huntLabel(hunt: Hunt): string {
  if (!hunt.components.length) return 'General investigation';
  return hunt.components.join(', ');
}

function humanStatus(status: string): string {
  return statusLabel(status.replaceAll('-', ' '));
}

function statusTone(status: string) {
  if (status === 'running' || status === 'queued') return 'running';
  if (status === 'completed') return 'success';
  if (['blocked', 'failed', 'budget-exhausted'].includes(status)) return 'warning';
  return 'muted';
}

function conversationLabel(conversation: Conversation): string {
  const stage = conversation.stage === 'scan' ? 'BugScan' : 'BugFix';
  return `${stage} · ${humanStatus(conversation.role)}`;
}

function HuntChat({
  workspaceId,
  huntId,
  conversation,
  theme,
}: {
  workspaceId: string;
  huntId: string;
  conversation: Conversation;
  theme: Theme;
}) {
  const [chat, setChat] = useState<Snapshot['chat']>();
  const timeline = useRef<ElementRef<typeof ScrollView>>(null);
  const followLatest = useRef(true);
  const stream = useSubscription(
    bugHunterSubscription,
    { workspaceId, huntId, agentId: conversation.id },
    (event) => {
      setChat(
        event.available && event.chat?.agentId === conversation.id
          ? event.chat
          : { agentId: conversation.id, unavailable: true, messages: [] },
      );
    },
  );
  const stale = stream.status === 'closed' || stream.status === 'error';

  if (!chat?.messages.length) {
    return (
      <ActivityText theme={theme} size={14} tone={stale || chat?.unavailable ? 'warning' : 'muted'}>
        {stale || chat?.unavailable
          ? 'Chat history is unavailable.'
          : chat
            ? 'No messages yet.'
            : 'Loading chat…'}
      </ActivityText>
    );
  }

  return (
    <>
      {(stale || chat.unavailable) && (
        <ActivityText theme={theme} size={13} tone="warning">
          Chat updates are disconnected.
        </ActivityText>
      )}
      <ScrollView
        style={{ maxHeight: 480 }}
        contentContainerStyle={{ gap: 8 }}
        nestedScrollEnabled
        scrollEventThrottle={16}
        onScroll={({ nativeEvent }) => {
          const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
          followLatest.current =
            contentSize.height - contentOffset.y - layoutMeasurement.height < 40;
        }}
        onContentSizeChange={() => {
          if (followLatest.current) timeline.current?.scrollToEnd({ animated: false });
        }}
        ref={timeline}
      >
        {chat.messages.map((message) => (
          <View
            key={message.id}
            style={{ backgroundColor: theme.colors.surface2, borderRadius: 6, gap: 5, padding: 10 }}
          >
            <ActivityText theme={theme} size={12} strong tone="muted">
              {message.role === 'assistant' ? conversationLabel(conversation) : 'Request'}
            </ActivityText>
            <Text
              selectable
              style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 21 }}
            >
              {message.text}
            </Text>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

function HuntDetails({
  hunt,
  workspaceId,
  theme,
  host,
  navigation,
}: Pick<PluginWorkspacePanelProps, 'workspaceId' | 'theme' | 'host' | 'navigation'> & {
  hunt: Hunt;
}) {
  const [agentId, setAgentId] = useState<string>();
  const toast = useToast();
  const conversation = hunt.conversations.find(({ id }) => id === agentId) ?? hunt.conversations[0];
  const fix = hunt.fix;
  const delivery = [
    fix?.implemented && 'Implemented',
    fix?.verified && 'Verified',
    fix?.integrated && 'Integrated',
    fix?.installed && 'Installed',
    fix?.recovered && 'Recovery verified',
  ].filter(Boolean);
  return (
    <View style={{ flex: 1, minWidth: 0, gap: 12 }}>
      <Card theme={theme}>
        <View style={row}>
          <Label theme={theme} heading>
            {huntLabel(hunt)}
          </Label>
          <ActivityStatus
            theme={theme}
            label={humanStatus(hunt.status)}
            tone={statusTone(hunt.status)}
          />
        </View>
        <ActivityText theme={theme} size={13} tone="muted">
          {hunt.automatic ? 'Automatic hunt' : 'Manual hunt'} ·{' '}
          {new Date(hunt.createdAt).toLocaleString()}
        </ActivityText>
        {hunt.failure && (
          <ActivityText theme={theme} size={14} tone="warning">
            {hunt.failure}
          </ActivityText>
        )}
        {fix && (
          <>
            <ActivityText theme={theme} size={14} strong>
              BugFix · {humanStatus(fix.status)}
            </ActivityText>
            <ActivityText theme={theme} size={13} tone="muted">
              {delivery.join(' · ') || 'Delivery pending'}
            </ActivityText>
            {fix.failure && (
              <ActivityText theme={theme} size={14} tone="warning">
                {fix.failure}
              </ActivityText>
            )}
          </>
        )}
      </Card>
      <Card theme={theme}>
        <View style={{ ...row, justifyContent: 'space-between' }}>
          <Label theme={theme} heading>
            Chat
          </Label>
          {conversation && navigation && (
            <ActivityButton
              theme={theme}
              label="Open native chat"
              onPress={() => {
                try {
                  navigation.openAgent({ agentId: conversation.id, serverId: host.id });
                } catch {
                  toast.error('Could not open the native chat.');
                }
              }}
            >
              <ActivityText theme={theme}>Open native chat</ActivityText>
              <Icon name="ArrowUpRight" color={theme.colors.foregroundMuted} size={13} />
            </ActivityButton>
          )}
        </View>
        {conversation ? (
          <>
            <View style={row}>
              {hunt.conversations.map((item) => {
                const peers = hunt.conversations.filter(
                  ({ role, stage }) => role === item.role && stage === item.stage,
                );
                const role = conversationLabel(item);
                const label =
                  peers.length > 1
                    ? `${role} ${peers.findIndex(({ id }) => id === item.id) + 1}`
                    : role;
                return (
                  <ActivityButton
                    key={item.id}
                    theme={theme}
                    label={label}
                    selected={item.id === conversation.id}
                    onPress={() => setAgentId(item.id)}
                  >
                    <ActivityText theme={theme} size={12}>
                      {label}
                    </ActivityText>
                  </ActivityButton>
                );
              })}
            </View>
            <HuntChat
              key={conversation.id}
              workspaceId={workspaceId}
              huntId={hunt.id}
              conversation={conversation}
              theme={theme}
            />
          </>
        ) : (
          <ActivityText theme={theme} size={14} tone="muted">
            No agent conversations recorded.
          </ActivityText>
        )}
      </Card>
      <Card theme={theme}>
        <Label theme={theme} heading>
          Findings
        </Label>
        {hunt.findings.length === 0 && (
          <ActivityText theme={theme} size={14} tone="muted">
            No findings recorded.
          </ActivityText>
        )}
        {hunt.findings.map((finding, index) => (
          <View key={`${hunt.id}:${index}`} style={{ gap: 5, paddingVertical: 5 }}>
            <ActivityText theme={theme} strong size={13}>
              {finding.confidence === 'demonstrated' ? 'Confirmed cause' : 'Hypothesis'}
            </ActivityText>
            <Label theme={theme}>{finding.cause}</Label>
            <ActivityText theme={theme} size={14}>
              Expected behavior · {finding.expectedBehavior}
            </ActivityText>
            <ActivityText theme={theme} size={14}>
              How it failed · {finding.mechanism}
            </ActivityText>
            {finding.remedy && (
              <ActivityText theme={theme} size={14}>
                Remedy · {finding.remedy}
              </ActivityText>
            )}
            {finding.acceptanceCriteria.map((criterion, index) => (
              <ActivityText key={index} theme={theme} size={13} tone="muted">
                Verify · {criterion}
              </ActivityText>
            ))}
            {finding.technicalDebt.map((debt, debtIndex) => (
              <ActivityText key={debtIndex} theme={theme} size={13} tone="muted">
                {debt.decision === 'immediate' ? 'Address now' : 'Deferred'} · {debt.problem} ·{' '}
                {debt.rationale}
              </ActivityText>
            ))}
          </View>
        ))}
      </Card>
    </View>
  );
}

function BugHunterWorkspace(props: PluginWorkspacePanelProps) {
  const { theme, workspaceId, layout } = props;
  const [width, setWidth] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [huntId, setHuntId] = useState<string>();
  const stream = useSubscription(bugHunterSubscription, { workspaceId }, setSnapshot);
  const stale = stream.status === 'closed' || stream.status === 'error';
  const hunts =
    snapshot?.hunts.slice().sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)) ??
    [];
  const hunt =
    hunts.find(({ id }) => id === huntId) ??
    hunts.find(({ status }) => status === 'running') ??
    hunts[0];
  const wide = width >= 760 && !layout.compact;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ gap: 14, padding: layout.compact ? 12 : 20 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <View style={row}>
        <Icon name="Bug" size={20} color={theme.colors.accent} />
        <Label theme={theme} heading>
          BugHunter
        </Label>
        {snapshot?.available && snapshot.enabled === false && (
          <ActivityStatus theme={theme} label="Disabled" />
        )}
      </View>
      {stale && (
        <ActivityText theme={theme} size={14} tone="warning">
          {snapshot ? 'BugHunter updates are disconnected.' : 'Could not load BugHunter.'}
        </ActivityText>
      )}
      {!snapshot && !stale && (
        <Label theme={theme} muted>
          Loading BugHunter…
        </Label>
      )}
      {snapshot && !snapshot.available && (
        <Label theme={theme} muted>
          BugHunter is unavailable for this workspace.
        </Label>
      )}
      {snapshot?.available && !hunt && (
        <Label theme={theme} muted>
          No hunts recorded yet.
        </Label>
      )}
      {snapshot?.available && hunt && (
        <View style={{ flexDirection: wide ? 'row' : 'column', gap: 14 }}>
          <View style={{ width: wide ? 230 : undefined }}>
            <Card theme={theme}>
              <Label theme={theme} heading>
                Hunt history
              </Label>
              <ScrollView
                style={{ maxHeight: wide ? 580 : 200 }}
                contentContainerStyle={{ gap: 6 }}
                nestedScrollEnabled
              >
                {hunts.map((item) => (
                  <ActivityButton
                    theme={theme}
                    key={item.id}
                    label={`${huntLabel(item)}, ${humanStatus(item.status)}, ${new Date(item.createdAt).toLocaleString()}`}
                    selected={item.id === hunt.id}
                    onPress={() => setHuntId(item.id)}
                  >
                    <View style={{ flex: 1, minWidth: 0, padding: 4, gap: 3 }}>
                      <ActivityText theme={theme} strong size={13} lines={2}>
                        {huntLabel(item)}
                      </ActivityText>
                      <ActivityText theme={theme} tone="muted" size={12}>
                        {new Date(item.createdAt).toLocaleString()}
                      </ActivityText>
                      <ActivityStatus
                        theme={theme}
                        label={humanStatus(item.status)}
                        tone={statusTone(item.status)}
                      />
                    </View>
                  </ActivityButton>
                ))}
              </ScrollView>
            </Card>
          </View>
          <HuntDetails key={hunt.id} {...props} hunt={hunt} />
        </View>
      )}
    </ScrollView>
  );
}

export function BugHunter(props: PluginWorkspacePanelProps) {
  return <BugHunterWorkspace key={`${props.host.id}:${props.workspaceId}`} {...props} />;
}
