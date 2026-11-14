import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ScrollView, Text, View } from 'react-native';
import { defineRpc } from '@getpaseo/plugin';
import {
  useAgent,
  useRpc,
  useWorkspace,
  type PluginClientContext,
  type PluginWorkspacePanelProps,
} from '@getpaseo/plugin/client';
import {
  SessionOpenRequestSchema,
  SessionOpenResponseSchema,
  TeamSnapshotRequestSchema,
  TeamSnapshotResponseSchema,
  type TeamStatusSnapshot,
} from './shared/panel-snapshot';

const teamSnapshot = defineRpc({
  name: 'ltcook.team.snapshot',
  input: TeamSnapshotRequestSchema,
  output: TeamSnapshotResponseSchema,
});
const openSession = defineRpc({
  name: 'ltcook.session.open',
  input: SessionOpenRequestSchema,
  output: SessionOpenResponseSchema,
});

function MemberStatus({
  member,
  navigation,
}: {
  member: TeamStatusSnapshot['members'][number];
  navigation: PluginWorkspacePanelProps['navigation'];
}) {
  const liveStatus = useAgent(member.nativeAgentId ?? '', (agent) => agent.status);
  return (
    <Text
      onPress={() => {
        if (member.nativeAgentId) navigation?.openAgent({ agentId: member.nativeAgentId });
      }}
    >
      {member.name}: {liveStatus ?? member.status}
    </Text>
  );
}

function TeamStatus(props: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(props.workspaceId, (value) => ({ directory: value.directory }));
  const callSnapshot = useRpc(teamSnapshot);
  const callOpenSession = useRpc(openSession);
  const [state, setState] = useState<
    | { root: string; status: 'loading' }
    | { root: string; status: 'empty' }
    | { root: string; status: 'ready'; snapshot: TeamStatusSnapshot }
    | { root: string; status: 'error'; message: string }
  >();
  const [pendingRoots, setPendingRoots] = useState<ReadonlySet<string>>(() => new Set());
  const requestVersion = useRef(0);
  const pendingRootsRef = useRef(new Set<string>());
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const workspaceRoot = workspace?.directory;
    if (!workspaceRoot) return;
    const version = ++requestVersion.current;
    setState({ root: workspaceRoot, status: 'loading' });
    try {
      const snapshot = await callSnapshot({ workspaceRoot });
      if (version === requestVersion.current) {
        setState(
          snapshot
            ? { root: workspaceRoot, status: 'ready', snapshot }
            : { root: workspaceRoot, status: 'empty' },
        );
      }
    } catch (error) {
      if (version === requestVersion.current) {
        setState({
          root: workspaceRoot,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, [callSnapshot, workspace?.directory]);

  const updatePending = (workspaceRoot: string, pending: boolean) => {
    const next = new Set(pendingRootsRef.current);
    if (pending) next.add(workspaceRoot);
    else next.delete(workspaceRoot);
    pendingRootsRef.current = next;
    if (mounted.current) setPendingRoots(next);
  };

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      requestVersion.current += 1;
    };
  }, [refresh]);
  const startSession = async () => {
    const workspaceRoot = workspace?.directory;
    if (!workspaceRoot || pendingRootsRef.current.has(workspaceRoot)) return;
    const version = ++requestVersion.current;
    updatePending(workspaceRoot, true);
    setState({ root: workspaceRoot, status: 'loading' });
    try {
      await callOpenSession({ workspaceRoot });
      if (version === requestVersion.current) void refresh();
    } catch (error) {
      if (version === requestVersion.current) {
        setState({
          root: workspaceRoot,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      updatePending(workspaceRoot, false);
    }
  };

  if (!workspace?.directory) return <Text>Workspace location unavailable</Text>;
  const currentState = state?.root === workspace.directory ? state : undefined;
  const starting = pendingRoots.has(workspace.directory);
  return (
    <ScrollView>
      <View>
        <Text>Team status</Text>
        {currentState?.status === 'ready' && (
          <Button title="Refresh" onPress={() => void refresh()} />
        )}
        {currentState?.status === 'loading' && (
          <Text accessibilityRole="progressbar">Loading team status…</Text>
        )}
        {currentState?.status === 'error' && (
          <Text accessibilityRole="alert">Team status unavailable: {currentState.message}</Text>
        )}
        {currentState?.status === 'error' && (
          <Button title="Retry" onPress={() => void refresh()} />
        )}
        {currentState?.status === 'empty' && (
          <View>
            <Text>No LTCook session is open for this directory.</Text>
            <Button
              title={starting ? 'Starting session…' : 'Start session'}
              onPress={() => void startSession()}
              disabled={starting}
            />
          </View>
        )}
        {currentState?.status === 'ready' && (
          <View>
            <Text>Team: {currentState.snapshot.teamId}</Text>
            <Text>Members</Text>
            {currentState.snapshot.members.map((member) => (
              <MemberStatus key={member.memberKey} member={member} navigation={props.navigation} />
            ))}
            <Text>Passes</Text>
            {currentState.snapshot.passes.map((pass) => (
              <Text key={pass.passId}>
                {pass.title}: {pass.status}
              </Text>
            ))}
            <Text>Tasks</Text>
            {currentState.snapshot.tasks.map((task) => (
              <View key={task.taskId}>
                <Text>
                  {task.title}: {task.status}
                  {task.passId ? ` · Pass: ${task.passTitle ?? 'title unavailable'}` : ' · No Pass'}
                </Text>
                {task.steps.map((step, index) => (
                  <Text key={step.stepId}>
                    {'  '}Step {index + 1}: {step.title}: {step.status}
                  </Text>
                ))}
              </View>
            ))}
            <Text>Assignments</Text>
            {currentState.snapshot.assignments.map((assignment) => (
              <Text key={assignment.assignmentId}>
                {assignment.taskTitle} → {assignment.memberName} ({assignment.status})
              </Text>
            ))}
            <Text>Issues</Text>
            {currentState.snapshot.issues.length ? (
              currentState.snapshot.issues.map((issue, index) => (
                <Text key={`${index}:${issue}`}>{issue}</Text>
              ))
            ) : (
              <Text>None</Text>
            )}
          </View>
        )}
      </View>
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
