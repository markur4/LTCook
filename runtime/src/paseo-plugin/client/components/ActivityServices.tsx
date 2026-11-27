import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/ui';
import { activityToggleRpc, bugScanRunRpc, type ActivitySnapshot } from '../../shared/activity';
import {
  ActivityButton,
  ActivityCard,
  ActivityField,
  ActivityStatus,
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
  queued: 'muted',
  indexing: 'running',
  updating: 'running',
  paused: 'muted',
  retrying: 'warning',
  error: 'danger',
  unknown: 'muted',
} as const;

function ActivitySwitch({
  theme,
  label,
  enabled,
  feature = 'rag-index',
}: {
  theme: Theme;
  label: string;
  enabled: boolean | null;
  feature?: 'rag-index' | 'bughunter';
}) {
  const toggle = useRpc(activityToggleRpc);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setPending(true);
    setError(null);
    try {
      await toggle({ feature, enabled: next });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this setting.');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <ActivityText theme={theme} strong>
          {label}
        </ActivityText>
        <Switch
          accessibilityLabel={label}
          accessibilityHint="Applies to the LTCook runtime for this Paseo host."
          value={enabled === true}
          disabled={pending || enabled === null}
          onValueChange={(value) => void change(value)}
        />
      </View>
      {error && (
        <ActivityText theme={theme} tone="danger">
          {error}
        </ActivityText>
      )}
    </>
  );
}

function ActivityTimestamp({
  theme,
  label,
  at,
  description,
}: {
  theme: Theme;
  label: string;
  at?: string;
  description: string;
}) {
  const [open, setOpen] = useState(false);
  const value = at ? new Date(at).toLocaleString() : 'Not recorded';
  return (
    <View style={{ gap: 4 }}>
      <ActivityButton
        theme={theme}
        label={`${label}, ${value}`}
        expanded={open}
        onPress={() => setOpen(!open)}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <ActivityText theme={theme} strong>
            {label}
          </ActivityText>
          <ActivityText theme={theme} tone="muted">
            {value}
          </ActivityText>
        </View>
        <Icon
          name={open ? 'ChevronUp' : 'ChevronDown'}
          size={12}
          color={theme.colors.foregroundMuted}
        />
      </ActivityButton>
      {open && (
        <ActivityText theme={theme} tone="muted">
          {description}
        </ActivityText>
      )}
    </View>
  );
}

export function BugHunterActivity({
  theme,
  agentId,
  scan,
  onOpen,
}: {
  theme: Theme;
  agentId?: string;
  scan?: ActivitySnapshot['bugScan'];
  onOpen: () => void;
}) {
  const run = useRpc(bugScanRunRpc);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canControl = Boolean(agentId && scan?.enabled && !pending);
  const canRun = canControl && scan?.status !== 'running' && scan?.status !== 'queued';
  const fix = scan?.fix;
  const fixRunning = fix?.status === 'queued' || fix?.status === 'running';
  async function trigger(
    action: 'run' | 'pause' | 'resume' | 'pause-fix' | 'resume-fix',
    id?: string,
  ) {
    if (!agentId) return;
    setPending(true);
    setError(null);
    try {
      await run({ agentId, action, id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start BugScan.');
    } finally {
      setPending(false);
    }
  }
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 6,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingRight: scan ? 5 : 0 }}>
        <ActivityButton theme={theme} label="Open BugHunter" onPress={onOpen} header>
          <Icon name="Bug" size={15} color={theme.colors.accent} />
          <View style={{ flex: 1, gap: 3 }}>
            <ActivityText theme={theme} strong size={12}>
              BugHunter
            </ActivityText>
            {scan && (
              <ActivityText theme={theme} tone="muted">
                {scan.findings.length === 1 ? '1 finding' : `${scan.findings.length} findings`}
              </ActivityText>
            )}
          </View>
          {scan && (
            <ActivityStatus
              theme={theme}
              label={scan.enabled ? statusLabel(scan.status) : 'Disabled'}
              tone={scan.status === 'running' ? 'running' : scan.failure ? 'warning' : 'muted'}
            />
          )}
          <Icon name="ArrowUpRight" size={13} color={theme.colors.foregroundMuted} />
        </ActivityButton>
        {scan && (
          <ActivityButton
            theme={theme}
            label="BugHunter controls"
            expanded={open}
            onPress={() => setOpen((value) => !value)}
          >
            <Icon
              name={open ? 'ChevronDown' : 'ChevronRight'}
              size={13}
              color={theme.colors.foregroundMuted}
            />
          </ActivityButton>
        )}
      </View>
      {open && scan && (
        <View style={{ paddingHorizontal: 10, paddingBottom: 10, gap: 6 }}>
          <ActivitySwitch
            theme={theme}
            label="BugHunter execution"
            enabled={scan.enabled}
            feature="bughunter"
          />
          {canRun && (
            <ActivityButton theme={theme} label="Run BugScan" onPress={() => void trigger('run')}>
              <ActivityText theme={theme} strong>
                Run BugScan
              </ActivityText>
            </ActivityButton>
          )}
          {canControl && scan.status === 'running' && (
            <ActivityButton
              theme={theme}
              label="Pause BugScan"
              onPress={() => void trigger('pause')}
            >
              <ActivityText theme={theme}>Pause BugScan</ActivityText>
            </ActivityButton>
          )}
          {canControl && scan.status === 'paused' && scan.id && (
            <ActivityButton
              theme={theme}
              label="Resume BugScan"
              onPress={() => void trigger('resume', scan.id)}
            >
              <ActivityText theme={theme}>Resume BugScan</ActivityText>
            </ActivityButton>
          )}
          {fix && (
            <>
              <ActivityField theme={theme} label="BugFix">
                {statusLabel(fix.status)}
              </ActivityField>
              <ActivityField theme={theme} label="Delivery">
                {[
                  fix.implemented && 'Implemented',
                  fix.verified && 'Verified',
                  fix.integrated && 'Integrated',
                  fix.installed && 'Installed',
                  fix.recovered && 'Recovery verified',
                ]
                  .filter(Boolean)
                  .join(' · ') || 'Pending'}
              </ActivityField>
              {fix.failure && (
                <ActivityText theme={theme} tone="warning">
                  {fix.failure}
                </ActivityText>
              )}
              {canControl && ['queued', 'running', 'paused', 'blocked'].includes(fix.status) && (
                <ActivityButton
                  theme={theme}
                  label={fixRunning ? 'Pause BugFix' : 'Resume BugFix'}
                  onPress={() => void trigger(fixRunning ? 'pause-fix' : 'resume-fix', fix.id)}
                >
                  <ActivityText theme={theme}>
                    {fixRunning ? 'Pause BugFix' : 'Resume BugFix'}
                  </ActivityText>
                </ActivityButton>
              )}
            </>
          )}
          {(error || scan.failure) && (
            <ActivityText theme={theme} tone="warning">
              {error || scan.failure}
            </ActivityText>
          )}
        </View>
      )}
    </View>
  );
}

export function ActivityServices({
  theme,
  rag,
  lastHandoff,
  agentWorktree,
  onQueryRepo,
}: Pick<ActivitySnapshot, 'rag' | 'lastHandoff'> & {
  theme: Theme;
  agentWorktree?: string;
  onQueryRepo?: () => void;
}) {
  const [ragOpen, setRagOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const activity = rag.indexingEnabled === false ? 'paused' : rag.activity;
  const ragActivity = {
    idle: 'Idle',
    queued: 'Queued',
    indexing: 'Building first index',
    updating: 'Refreshing',
    paused: 'Paused',
    retrying: 'Retrying',
    error: 'Needs attention',
    unknown: 'Unknown',
  }[activity];
  const ragAvailability = statusLabel(rag.availability);
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
            <Text style={{ color: activityColor(theme, ragActivityTones[activity]) }}>
              {ragActivity}
            </Text>
          </Text>
        }
      >
        <ActivitySwitch theme={theme} label="Index updates" enabled={rag.indexingEnabled} />
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
        {onQueryRepo && (
          <ActivityButton theme={theme} label="Query Repo" onPress={onQueryRepo}>
            <Icon name="Search" size={13} color={theme.colors.foreground} />
            <ActivityText theme={theme} strong>
              Query Repo
            </ActivityText>
          </ActivityButton>
        )}
        <ActivityTimestamp
          theme={theme}
          label="Last checked"
          at={rag.lastCheckedAt}
          description="The last completed index check for this worktree. A check can finish without publishing a new index."
        />
        <ActivityTimestamp
          theme={theme}
          label="Last queried"
          at={rag.lastQueriedAt}
          description="The last successful query using this worktree’s published index, including queries with zero matches."
        />
        {rag.publishedAt && (
          <ActivityField theme={theme} label="Last completed index">
            {new Date(rag.publishedAt).toLocaleString()}
          </ActivityField>
        )}
        {rag.retryAt && (
          <ActivityField theme={theme} label="Next attempt">
            {new Date(rag.retryAt).toLocaleTimeString()}
          </ActivityField>
        )}
        {rag.diagnostic && (
          <ActivityText theme={theme} tone="muted">
            {rag.diagnostic}
          </ActivityText>
        )}
      </ActivityCard>
      {lastHandoff && (
        <ActivityCard
          theme={theme}
          title="Last delegation handoff"
          icon="MessageSquare"
          status="Received"
          statusTone="success"
          open={handoffOpen}
          onToggle={() => setHandoffOpen(!handoffOpen)}
          summaryLabel={lastHandoff.sourceName ?? 'Name unavailable'}
          summary={
            <ActivityText theme={theme}>
              {lastHandoff.sourceName ?? 'Name unavailable'}
            </ActivityText>
          }
        >
          <ActivityField theme={theme} label="Received">
            {new Date(lastHandoff.at).toLocaleString()}
          </ActivityField>
          <ActivityField theme={theme} label="Payload size">
            {`${lastHandoff.bytes.toLocaleString()} bytes`}
          </ActivityField>
          <ActivityField theme={theme} label="Action batches represented">
            {lastHandoff.aab.toLocaleString()}
          </ActivityField>
        </ActivityCard>
      )}
    </>
  );
}
