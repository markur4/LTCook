import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import {
  useWorkspace,
  type PluginClientContext,
  type PluginWorkspacePanelProps,
} from '@getpaseo/plugin/client';
import type { TeamDetailTarget } from './shared/panel-details';
import { useTeamPanel } from './client/use-team-panel';
import { Action, Card, Label } from './client/components/PanelChrome';
import { TeamOverview } from './client/screens/TeamOverview';
import { TaskBoard } from './client/screens/TaskBoard';
import { AgentFocus } from './client/screens/AgentFocus';
import { defineRpc } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import { EvalRequestSchema, EvalResponseSchema } from './shared/evals';

const evalsRpc = defineRpc({
  name: 'ltcook.evals.diagnostics',
  input: EvalRequestSchema,
  output: EvalResponseSchema,
});
function resultSummary(report: any): string[] {
  return Object.entries(report.result?.results ?? {}).map(([name, value]: [string, any]) => {
    const tasks = Array.isArray(value) ? value : value?.tasks;
    if (Array.isArray(tasks)) {
      const passed = tasks.filter((task) => task.success).length;
      return `${name}: ${passed}/${tasks.length} passed; ${tasks.filter((task) => task.attempts?.length > 1).length} retried`;
    }
    if (Array.isArray(value?.findings))
      return `${name}: ${value.findings.length} potential findings`;
    return `${name}: ${value?.resourceCount ?? 0} resources`;
  });
}

function Diagnostics({
  theme,
  workspaceRoot,
}: {
  theme: PluginWorkspacePanelProps['theme'];
  workspaceRoot?: string;
}) {
  const [setup, setSetup] = useState<'current' | 'synthetic'>('current');
  const call = useRpc(evalsRpc);
  const [runs, setRuns] = useState<any[]>([]);
  const [selected, setSelected] = useState<string>();
  const [compareId, setCompareId] = useState<string>();
  const [status, setStatus] = useState<any>();
  const [report, setReport] = useState<any>();
  const [compareReport, setCompareReport] = useState<any>();
  const [showDetails, setShowDetails] = useState(false);
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      const result = (await call({ action: 'list' })) as { runs: any[] };
      setRuns(result.runs);
      if (selected) {
        const current = (await call({ action: 'status', runId: selected })) as any;
        setStatus(current.summary);
        if (current.summary.status !== 'running')
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
  const start = async (preset: 'quick' | 'full') => {
    try {
      const value = (await call({
        action: 'start',
        preset,
        setup,
        ...(setup === 'current' && workspaceRoot ? { workspaceRoot } : {}),
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
        <Action theme={theme} title="Run quick check" onPress={() => void start('quick')} />
        <Action theme={theme} title="Run full Agent Evals" onPress={() => void start('full')} />
        <Action theme={theme} title="Refresh history" onPress={() => void refresh()} />
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
          >{`${status.setup} · ${status.teamSelection ?? 'Preparing team'} · ${status.preset} · ${status.status} · ${status.completed}/${status.total}`}</Label>
          <Label
            theme={theme}
            muted
          >{`${status.currentSuite ?? 'Preparing'}${status.currentCase ? ` · ${status.currentCase}` : ''}`}</Label>
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
          {Object.entries(report.result?.results ?? {}).map(([name, value]: [string, any]) => {
            const tasks = Array.isArray(value) ? value : value?.tasks;
            const findings = value?.findings;
            const passed = Array.isArray(tasks)
              ? tasks.filter((task) => task.success).length
              : undefined;
            return (
              <View key={name} style={{ gap: 4, paddingVertical: 4 }}>
                <Label theme={theme}>
                  {{
                    static: 'Instruction Audit · static',
                    semantic: 'Instruction Audit · semantic',
                    behavior: 'Behavior Evaluation',
                    bottlenecks: 'Bottleneck Attribution',
                  }[name] ?? name.replaceAll('-', ' ')}
                </Label>
                <Label theme={theme} muted>
                  {Array.isArray(tasks)
                    ? `${passed}/${tasks.length} behavior cases passed after retry`
                    : Array.isArray(findings)
                      ? `${findings.length} potential findings`
                      : 'Completed'}
                </Label>
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

function TeamStatus(props: PluginWorkspacePanelProps) {
  const root = useWorkspace(props.workspaceId, (value) => value.directory);
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
  }, [root]);
  const target: TeamDetailTarget | null =
    view === 'agent' && memberKey
      ? { kind: 'member', memberKey }
      : view === 'tasks' && taskId
        ? { kind: 'task', taskId }
        : view === 'overview' && issuesOpen
          ? { kind: 'issues' }
          : null;
  const panel = useTeamPanel(root ?? undefined, target);
  const snapshot = panel.state?.status === 'ready' ? panel.state.value : null;
  const detail = panel.detail?.status === 'ready' ? panel.detail.value : undefined;
  const theme = props.theme;
  const compact = props.layout.compact || width < 720;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 16, gap: 16 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <Label theme={theme} heading>
        {snapshot?.teamName ?? 'Team status'}
      </Label>
      <Label theme={theme} muted>
        {root ?? 'Workspace location unavailable'}
      </Label>
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
          disabled={!root || panel.starting}
          onPress={() => void panel.refresh()}
        />
      </View>
      {root && (!panel.state || panel.state.status === 'loading') && (
        <Text accessibilityRole="progressbar" style={{ color: theme.colors.foreground }}>
          Loading team status…
        </Text>
      )}
      {panel.state?.status === 'error' && (
        <View style={{ gap: 8 }}>
          <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
            {panel.state.message}
          </Text>
          <Action theme={theme} title="Retry" onPress={() => void panel.refresh()} />
          <Action
            theme={theme}
            title="Start session"
            disabled={panel.starting}
            onPress={() => void panel.startSession()}
          />
        </View>
      )}
      {panel.state?.status === 'ready' && !snapshot && view !== 'diagnostics' && (
        <View style={{ gap: 8 }}>
          <Label theme={theme}>No LTCook session is open for this directory.</Label>
          <Action
            theme={theme}
            title={panel.starting ? 'Starting session…' : 'Start session'}
            disabled={panel.starting}
            onPress={() => void panel.startSession()}
          />
        </View>
      )}
      {view === 'diagnostics' && <Diagnostics theme={theme} workspaceRoot={root ?? undefined} />}
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
  client.addWorkspacePanel({
    id: 'team-status',
    title: 'Team status',
    icon: 'Users',
    context: 'workspace',
    locations: ['workspace', 'explorer'],
    Component: TeamStatus,
  });
  client.addCommandCenterItem({
    id: 'open-team-status',
    title: 'Open team status',
    icon: 'Users',
    context: 'workspace',
    onSelect({ openPanel }) {
      openPanel('team-status');
    },
  });
  return () => undefined;
}
