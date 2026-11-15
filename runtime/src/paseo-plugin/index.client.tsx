import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import {
  useAgent,
  useWorkspace,
  type PluginClientContext,
  type PluginAgentPanelProps,
  type PluginHostProps,
} from '@getpaseo/plugin/client';
import type { TeamDetailTarget } from './shared/panel-details';
import { useTeamPanel } from './client/use-team-panel';
import { Action, Card, Label } from './client/components/PanelChrome';
import { TeamOverview } from './client/screens/TeamOverview';
import { TaskBoard } from './client/screens/TaskBoard';
import { AgentFocus } from './client/screens/AgentFocus';
import { TeamsBrowser } from './client/screens/TeamsBrowser';
import { TeamComposerItem } from './client/components/TeamComposerItem';
import { StatusBadge } from './client/components/StatusBadge';
import { useTeamCatalog } from './client/use-team-catalog';
import { defineRpc } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import { EvalRequestSchema, EvalResponseSchema } from './shared/evals';

const evalsRpc = defineRpc({
  name: 'ltcook.evals.diagnostics',
  input: EvalRequestSchema,
  output: EvalResponseSchema,
});
const evalLabels: Record<string, string> = {
  preparation: 'Preparing',
  'instruction-static': 'Instruction Audit · static',
  'instruction-semantic': 'Instruction Audit · semantic',
  static: 'Instruction Audit · static',
  semantic: 'Instruction Audit · semantic',
  behavior: 'Behavior Evaluation',
  bottlenecks: 'Bottleneck Attribution',
};
function resultSummary(report: any): string[] {
  return Object.entries(report.result?.results ?? {}).map(([name, value]: [string, any]) => {
    if (name === 'bottlenecks')
      return `Bottleneck Attribution: ${((value?.totalElapsedMs ?? 0) / 1000).toFixed(2)}s from the same executions`;
    const tasks = Array.isArray(value) ? value : value?.tasks;
    if (Array.isArray(tasks)) {
      const passed = tasks.filter((task) => task.success).length;
      return `${evalLabels[name] ?? name}: ${passed}/${tasks.length} passed; ${tasks.filter((task) => task.attempts?.length > 1).length} retried`;
    }
    if (Array.isArray(value?.findings))
      return `${evalLabels[name] ?? name}: ${value.findings.length} potential findings`;
    return `${evalLabels[name] ?? name}: ${value?.resourceCount ?? 0} resources`;
  });
}

function Diagnostics({
  theme,
  workspaceRoot,
  sessionId,
}: {
  theme: PluginHostProps['theme'];
  workspaceRoot?: string;
  sessionId?: string;
}) {
  const [setup, setSetup] = useState<'current' | 'synthetic'>('current');
  const [repetitions, setRepetitions] = useState('1');
  const [scenario, setScenario] = useState<'read-only' | 'no-op' | 'targeted-fix'>();
  const call = useRpc(evalsRpc);
  const [runs, setRuns] = useState<any[]>([]);
  const [selected, setSelected] = useState<string>();
  const [compareId, setCompareId] = useState<string>();
  const [status, setStatus] = useState<any>();
  const [report, setReport] = useState<any>();
  const [compareReport, setCompareReport] = useState<any>();
  const [showDetails, setShowDetails] = useState(false);
  const [error, setError] = useState<string>();
  const currentUnavailable = setup === 'current' && (!workspaceRoot || !sessionId);
  const refresh = useCallback(async () => {
    try {
      const result = (await call({ action: 'list' })) as { runs: any[] };
      setRuns(result.runs);
      if (selected) {
        const current = (await call({ action: 'status', runId: selected })) as any;
        setStatus(current.summary);
        setReport(await call({ action: 'report', runId: selected }));
      }
      if (compareId) setCompareReport(await call({ action: 'report', runId: compareId }));
      setError(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }, [call, compareId, selected]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [refresh]);
  const start = async (preset: 'behavior' | 'audit' | 'bottlenecks' | 'full') => {
    try {
      if (currentUnavailable)
        throw new Error('Open an LTCook Leader with a workspace to run Current Setup.');
      const count = Number(repetitions);
      if (preset !== 'audit' && (!Number.isSafeInteger(count) || count < 1))
        throw new Error('Repetitions must be a positive integer.');
      const value = (await call({
        action: 'start',
        preset,
        setup,
        repetitions: preset === 'audit' ? 1 : count,
        ...(preset !== 'audit' && scenario ? { scenario } : {}),
        ...(setup === 'current' && workspaceRoot ? { workspaceRoot } : {}),
        ...(setup === 'current' && sessionId ? { sessionId } : {}),
      })) as { runId: string };
      setSelected(value.runId);
      setReport(undefined);
      setShowDetails(false);
      await refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  const selectedRun = selected ?? runs[0]?.runId;
  return (
    <View style={{ gap: 12 }}>
      <Label theme={theme} heading>
        Agent Evals
      </Label>
      <Label theme={theme} muted>
        Local Spark evaluations. Interactive Plan approval is outside evaluation coverage.
      </Label>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {(['current', 'synthetic'] as const).map((value) => (
          <Action
            key={value}
            theme={theme}
            title={value === 'current' ? 'Current Setup' : 'Synthetic Setup'}
            selected={setup === value}
            onPress={() => setSetup(value)}
          />
        ))}
        <Action
          theme={theme}
          title="Behavior Evaluation"
          disabled={currentUnavailable}
          onPress={() => void start('behavior')}
        />
        <Action
          theme={theme}
          title="Instruction Audit"
          disabled={currentUnavailable}
          onPress={() => void start('audit')}
        />
        <Action
          theme={theme}
          title="Bottleneck Attribution"
          disabled={currentUnavailable}
          onPress={() => void start('bottlenecks')}
        />
        <Action
          theme={theme}
          title="Run all categories"
          disabled={currentUnavailable}
          onPress={() => void start('full')}
        />
        <Action theme={theme} title="Refresh history" onPress={() => void refresh()} />
      </View>
      {currentUnavailable && (
        <Label theme={theme} muted>
          Open an LTCook Leader with a workspace to run Current Setup.
        </Label>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Action
          theme={theme}
          title="All three cases"
          selected={!scenario}
          onPress={() => setScenario(undefined)}
        />
        {(['read-only', 'no-op', 'targeted-fix'] as const).map((value) => (
          <Action
            key={value}
            theme={theme}
            title={value}
            selected={scenario === value}
            onPress={() => setScenario(value)}
          />
        ))}
        <Label theme={theme}>Repetitions</Label>
        <TextInput
          accessibilityLabel="Repetitions"
          value={repetitions}
          onChangeText={setRepetitions}
          keyboardType="number-pad"
          style={{ color: theme.colors.foreground, borderWidth: 1, padding: 6, minWidth: 60 }}
        />
      </View>
      {error && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          {error}
        </Text>
      )}
      {status && (
        <Card theme={theme}>
          <Label
            theme={theme}
          >{`${status.setup} · ${status.teamSelection ?? 'Preparing team'} · ${status.preset} · ${status.repetitions} repetition(s) · ${status.status} · ${status.completed}/${status.total}`}</Label>
          <Label
            theme={theme}
            muted
          >{`${evalLabels[status.currentSuite] ?? 'Preparing'}${status.currentCase ? ` · ${status.currentCase}` : ''}`}</Label>
          {status.error && <Label theme={theme}>{status.error}</Label>}
          {status.status === 'running' && (
            <Action
              theme={theme}
              title="Cancel run"
              onPress={async () => {
                await call({ action: 'cancel', runId: selectedRun });
                await refresh();
              }}
            />
          )}
        </Card>
      )}
      <Label theme={theme}>Run history</Label>
      {runs.map((item) => (
        <View key={item.runId} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Action
            theme={theme}
            title={`${item.setup} · ${item.teamSelection ?? 'Preparing team'} · ${item.preset} · ${item.status} · ${item.completed}/${item.total} · ${item.createdAt}`}
            selected={item.runId === selectedRun}
            onPress={() => {
              setSelected(item.runId);
              setStatus(item);
            }}
          />
          <Action
            theme={theme}
            title="Compare"
            selected={item.runId === compareId}
            disabled={item.status === 'running' || item.runId === selectedRun}
            onPress={() => setCompareId(compareId === item.runId ? undefined : item.runId)}
          />
        </View>
      ))}
      {report && compareReport && (
        <Card theme={theme}>
          <Label theme={theme}>Run comparison</Label>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
            {[report, compareReport].map((item, index) => (
              <View key={item.summary.runId} style={{ flex: 1, minWidth: 220, gap: 4 }}>
                <Label
                  theme={theme}
                >{`${index ? 'Compared' : 'Selected'} · ${item.summary.preset} · ${item.summary.status}`}</Label>
                {resultSummary(item).map((line) => (
                  <Label key={line} theme={theme} muted>
                    {line}
                  </Label>
                ))}
              </View>
            ))}
          </View>
        </Card>
      )}
      {report && (
        <Card theme={theme}>
          <Label theme={theme}>Results</Label>
          {(report.summary.limitations ?? []).map((limitation: string, index: number) => (
            <Label key={index} theme={theme} muted>
              {limitation}
            </Label>
          ))}
          {Object.entries(report.result?.results ?? {}).map(([name, value]: [string, any]) => {
            if (name === 'bottlenecks')
              return (
                <View key={name} style={{ gap: 4 }}>
                  <Label theme={theme}>Bottleneck Attribution</Label>
                  <Label
                    theme={theme}
                    muted
                  >{`${((value.totalElapsedMs ?? 0) / 1000).toFixed(2)}s total task time from the same executions`}</Label>
                  {Object.entries(value.timings ?? {}).map(([category, elapsed]) => (
                    <Label
                      key={category}
                      theme={theme}
                      muted
                    >{`${category}: ${(Number(elapsed) / 1000).toFixed(2)}s`}</Label>
                  ))}
                  <Label theme={theme} muted>
                    {value.note}
                  </Label>
                </View>
              );
            const tasks = Array.isArray(value) ? value : value?.tasks;
            const findings = value?.findings;
            const passed = Array.isArray(tasks)
              ? tasks.filter((task) => task.success).length
              : undefined;
            return (
              <View key={name} style={{ gap: 4, paddingVertical: 4 }}>
                <Label theme={theme}>{evalLabels[name] ?? name.replaceAll('-', ' ')}</Label>
                <Label theme={theme} muted>
                  {Array.isArray(tasks)
                    ? `${passed}/${tasks.length} behavior cases passed after retry`
                    : Array.isArray(findings)
                      ? `${findings.length} potential findings`
                      : 'Completed'}
                </Label>
                {Array.isArray(tasks) && (
                  <Label
                    theme={theme}
                    muted
                  >{`${(tasks.reduce((total: number, task: any) => total + (task.elapsedMs ?? 0), 0) / 1000).toFixed(2)}s total task time`}</Label>
                )}
                {(tasks ?? []).map((task: any, index: number) => (
                  <View key={`${task.scenario}-${task.repetition}-${index}`} style={{ gap: 4 }}>
                    <Label
                      theme={theme}
                    >{`${task.scenario} · ${(task.elapsedMs / 1000).toFixed(2)}s${task.pending ? ' · running' : ''}`}</Label>
                    {(task.attempts ?? []).map((attempt: any, attemptIndex: number) => (
                      <View key={attemptIndex} style={{ gap: 2 }}>
                        <Label
                          theme={theme}
                          muted
                        >{`${attempt.thinking} · ${(attempt.elapsedMs / 1000).toFixed(2)}s${attempt.failure ? ` · ${attempt.failure}` : ''}`}</Label>
                        {attempt.budget && (
                          <Label
                            theme={theme}
                            muted
                          >{`Safeguard ${(attempt.budget.timeoutMs / 1000).toFixed(2)}s · expected ${attempt.budget.expectedMs === null ? 'unknown' : `${(attempt.budget.expectedMs / 1000).toFixed(2)}s`} · ${attempt.budget.referenceRuns.join(', ') || 'no successful baseline yet'}`}</Label>
                        )}
                        {attempt.diagnostics && (
                          <Text selectable style={{ color: theme.colors.foreground }}>
                            {JSON.stringify(attempt.diagnostics, null, 2)}
                          </Text>
                        )}
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            );
          })}
          <Action
            theme={theme}
            title={showDetails ? 'Hide structured data' : 'Show structured data'}
            onPress={() => setShowDetails((value) => !value)}
          />
          {showDetails && (
            <Text selectable style={{ color: theme.colors.foreground, fontFamily: 'monospace' }}>
              {JSON.stringify(report.result, null, 2)}
            </Text>
          )}
          <Action
            theme={theme}
            title="Delete selected run"
            onPress={async () => {
              await call({ action: 'delete', runId: selectedRun });
              setSelected(undefined);
              setStatus(undefined);
              setReport(undefined);
              setCompareId(undefined);
              setCompareReport(undefined);
              setRuns(((await call({ action: 'list' })) as { runs: any[] }).runs);
            }}
          />
        </Card>
      )}
    </View>
  );
}

function TeamStatus(props: PluginAgentPanelProps) {
  const agent = useAgent(props.params.agentId, (value) => ({
    provider: value.provider,
    metadata: value.metadata,
    labels: value.labels,
    workspace: value.workspace,
    title: value.title,
    status: value.status,
    lastActivityAt: value.lastActivityAt,
  }));
  const root = useWorkspace(agent?.workspace ?? props.workspaceId, (value) => value.directory);
  const teamSelection = agent?.metadata['ltcook.team'] ?? agent?.labels['ltcook.team'];
  const sessionId =
    agent?.provider === 'ltcook'
      ? props.params.agentId
      : agent?.labels['ltcook.member'] === 'leader'
        ? agent.labels['ltcook.session']
        : undefined;
  const isLeader = Boolean(sessionId) && typeof teamSelection === 'string';
  const catalog = useTeamCatalog(isLeader);
  const team = isLeader
    ? catalog.teams.find(
        (entry) => entry.selection === teamSelection || entry.teamId === teamSelection,
      )
    : undefined;
  const [view, setView] = useState<'overview' | 'tasks' | 'agent' | 'diagnostics'>('overview');
  const [memberKey, setMember] = useState<string | null>(null);
  const [taskId, setTask] = useState<string | null>(null);
  const [issuesOpen, setIssues] = useState(false);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    setView('overview');
    setMember(null);
    setTask(null);
    setIssues(false);
  }, [sessionId]);
  const target = useMemo<TeamDetailTarget | null>(
    () =>
      view === 'agent' && memberKey
        ? { kind: 'member', memberKey }
        : view === 'tasks' && taskId
          ? { kind: 'task', taskId }
          : view === 'overview' && issuesOpen
            ? { kind: 'issues' }
            : null,
    [view, memberKey, taskId, issuesOpen],
  );
  const panel = useTeamPanel(sessionId, target, props.params.agentId);
  const previousLeaderActivity = useRef({
    sessionId,
    status: agent?.status,
    lastActivityAt: agent?.lastActivityAt,
  });
  useEffect(() => {
    const previous = previousLeaderActivity.current;
    if (
      sessionId &&
      previous.sessionId === sessionId &&
      (previous.status !== agent?.status || previous.lastActivityAt !== agent?.lastActivityAt)
    )
      void panel.refresh();
    previousLeaderActivity.current = {
      sessionId,
      status: agent?.status,
      lastActivityAt: agent?.lastActivityAt,
    };
  }, [agent?.lastActivityAt, agent?.status, panel.refresh, sessionId]);
  const snapshot = panel.state?.status === 'ready' ? panel.state.value : null;
  const detail = panel.detail?.status === 'ready' ? panel.detail.value : undefined;
  const theme = props.theme;
  const compact = props.layout.compact || width < 720;
  const onOpenAgent = props.navigation
    ? (agentId: string) => props.navigation?.openAgent({ agentId })
    : undefined;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 16, gap: 16 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <Label theme={theme} heading>
        {snapshot?.teamName ?? team?.name ?? 'Team'}
      </Label>
      {!agent && (
        <Text accessibilityRole="progressbar" style={{ color: theme.colors.foreground }}>
          Loading Leader conversation…
        </Text>
      )}
      {agent && !isLeader && (
        <Label theme={theme} muted>
          Open this panel from an LTCook Leader conversation.
        </Label>
      )}
      {isLeader && (
        <Card theme={theme}>
          <Label theme={theme} heading>
            Leader
          </Label>
          <Label theme={theme}>{agent?.title ?? team?.leader.name ?? 'LTCook Leader'}</Label>
          <StatusBadge theme={theme} status={agent?.status ?? 'unknown'} />
          <Label theme={theme} muted>
            {root ?? 'Workspace location unavailable'} · Live Leader status from Paseo
          </Label>
        </Card>
      )}
      {catalog.status === 'error' && isLeader && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          Could not load the Team catalog: {catalog.message}
        </Text>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Action
          theme={theme}
          title="Team Overview"
          selected={view === 'overview'}
          onPress={() => setView('overview')}
        />
        <Action
          theme={theme}
          title="Diagnostics"
          selected={view === 'diagnostics'}
          onPress={() => setView('diagnostics')}
        />
        <Action
          theme={theme}
          title="Task Board"
          selected={view === 'tasks'}
          onPress={() => setView('tasks')}
        />
        <Action
          theme={theme}
          title="Agent Focus"
          selected={view === 'agent'}
          onPress={() => setView('agent')}
        />
        <Action
          theme={theme}
          title="Refresh"
          disabled={!sessionId}
          onPress={() => {
            catalog.refresh();
            void panel.refresh();
          }}
        />
      </View>
      {sessionId && (!panel.state || panel.state.status === 'loading') && (
        <Text accessibilityRole="progressbar" style={{ color: theme.colors.foreground }}>
          Loading team status…
        </Text>
      )}
      {sessionId && panel.state?.status === 'error' && (
        <View style={{ gap: 8 }}>
          <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
            {panel.state.message}
          </Text>
          <Action theme={theme} title="Retry" onPress={() => void panel.refresh()} />
        </View>
      )}
      {sessionId && panel.state?.status === 'ready' && !snapshot && view !== 'diagnostics' && (
        <Label theme={theme} muted>
          No coordination snapshot is available for this Leader session.
        </Label>
      )}
      {view === 'diagnostics' && (
        <Diagnostics
          theme={theme}
          workspaceRoot={root ?? undefined}
          sessionId={isLeader ? sessionId : undefined}
        />
      )}
      {snapshot && view !== 'diagnostics' && (
        <>
          {panel.detail?.status === 'loading' && (
            <Label theme={theme} muted>
              Loading selected details…
            </Label>
          )}
          {panel.detail?.status === 'error' && (
            <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
              {panel.detail.message}
            </Text>
          )}
          {panel.detail?.status === 'ready' && !detail && (
            <Label theme={theme} muted>
              Selected item is no longer available
            </Label>
          )}
          {view === 'overview' && (
            <TeamOverview
              theme={theme}
              snapshot={snapshot}
              compact={compact}
              leaderKey={snapshot.leaderKey}
              onOpenAgent={onOpenAgent}
              onMember={(key) => {
                setMember(key);
                setView('agent');
              }}
              issuesOpen={issuesOpen}
              onIssues={() => setIssues((value) => !value)}
              detail={detail}
            />
          )}
          {view === 'tasks' && (
            <TaskBoard
              theme={theme}
              snapshot={snapshot}
              compact={compact}
              selectedTask={taskId}
              onTask={setTask}
              detail={detail}
            />
          )}
          {view === 'agent' && (
            <AgentFocus
              theme={theme}
              snapshot={snapshot}
              memberKey={memberKey}
              onMember={setMember}
              detail={detail}
              navigation={props.navigation}
            />
          )}
        </>
      )}
    </ScrollView>
  );
}

export default function contribute(client: PluginClientContext) {
  const cleanup = [
    client.addScreen({ id: 'teams-browser', title: 'Teams', Component: TeamsBrowser }),
    client.addSidebarHeaderItem({
      id: 'teams-browser',
      title: 'Teams',
      Component: ({ currentScreen, openScreen }) => (
        <SidebarRow
          icon="Users"
          active={currentScreen?.screenId === 'teams-browser'}
          onPress={() => openScreen({ screenId: 'teams-browser' })}
        />
      ),
    }),
    client.addCommandCenterItem({
      id: 'browse-workspace-teams',
      title: 'Browse Teams',
      icon: 'Users',
      context: 'workspace',
      onSelect({ workspace, openScreen }) {
        openScreen({ screenId: 'teams-browser', params: { workspaceId: workspace.id } });
      },
    }),
    client.addAgentPanel({
      id: 'team-status',
      title: 'Team',
      icon: 'Users',
      Component: TeamStatus,
    }),
    client.addComposerItem({ id: 'team-selector', Component: TeamComposerItem }),
    client.addCommandCenterItem({
      id: 'open-team-panel',
      title: 'Open Team panel',
      icon: 'Users',
      context: 'agent',
      onSelect({ openPanel }) {
        openPanel('team-status');
      },
    }),
  ];
  return () => cleanup.forEach((dispose) => dispose());
}
