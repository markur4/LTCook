import { defineRpc } from '@getpaseo/plugin';
import { useRpc, type PluginHostProps } from '@getpaseo/plugin/client';
import { useCallback, useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { EvalRequestSchema, EvalResponseSchema } from '../../shared/evals';
import { Action, Card, Label } from '../components/PanelChrome';

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
  summarization: 'Summarization evaluations',
};
function resultSummary(report: any): string[] {
  return Object.entries(report.result?.results ?? {}).map(([name, value]: [string, any]) => {
    if (name === 'summarization')
      return `Summarization qualification · ${value?.complete ? value.verdict : 'in progress'}`;
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

export function Diagnostics({
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
  const [scenario, setScenario] = useState<
    'read-only' | 'no-op' | 'targeted-fix' | 'summarization'
  >();
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
        Local Bonsai evaluations. Interactive Plan approval is outside evaluation coverage.
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
          disabled={currentUnavailable || scenario === 'summarization'}
          onPress={() => void start('bottlenecks')}
        />
        <Action
          theme={theme}
          title={scenario === 'summarization' ? 'Run full qualification' : 'Run all categories'}
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
          title="All cases"
          selected={!scenario}
          onPress={() => setScenario(undefined)}
        />
        {(['read-only', 'no-op', 'targeted-fix', 'summarization'] as const).map((value) => (
          <Action
            key={value}
            theme={theme}
            title={value === 'summarization' ? 'Summarization only' : value}
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
          {status.summarizationQualification && (
            <Label theme={theme}>
              Summarization qualification · {status.summarizationQualification}
            </Label>
          )}
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
            if (name === 'summarization')
              return (
                <View key={name} style={{ gap: 4 }}>
                  <Label theme={theme}>{evalLabels.summarization}</Label>
                  <Label theme={theme} muted>
                    {`${value.scope} · ${value.complete ? value.verdict : 'in progress'}`}
                  </Label>
                  {(value.blockers ?? []).map((blocker: string, index: number) => (
                    <Label key={index} theme={theme} muted>
                      {blocker}
                    </Label>
                  ))}
                  {(value.attempts ?? []).map((attempt: any) => (
                    <Label
                      key={`${attempt.id}-${attempt.input}-${attempt.attempt}`}
                      theme={theme}
                      muted
                    >
                      {`${attempt.id} · ${attempt.input} · attempt ${attempt.attempt} · ${attempt.verdict}${attempt.reason ? ` · ${attempt.reason}` : ''}`}
                    </Label>
                  ))}
                  {value.downstream && (
                    <Label theme={theme} muted>
                      {`Behavior Evaluation · downstream decision · ${value.downstream.verdict}`}
                    </Label>
                  )}
                </View>
              );
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
