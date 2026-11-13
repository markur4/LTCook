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
import { z } from 'zod';
import { TeamStatusSnapshotSchema, type TeamStatusSnapshot } from './shared/panel-snapshot';

const teamSnapshot = defineRpc({
  name: 'ltcook.team.snapshot',
  input: z.object({ workspaceRoot: z.string() }),
  output: TeamStatusSnapshotSchema,
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
  const call = useRpc(teamSnapshot);
  const [snapshot, setSnapshot] = useState<TeamStatusSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const requestVersion = useRef(0);
  const refresh = useCallback(async () => {
    const workspaceRoot = workspace?.directory;
    if (!workspaceRoot) return;
    const version = ++requestVersion.current;
    setRefreshing(true);
    setError(false);
    try {
      const current = await call({ workspaceRoot });
      if (version === requestVersion.current) setSnapshot(current);
    } catch {
      if (version === requestVersion.current) setError(true);
    } finally {
      if (version === requestVersion.current) setRefreshing(false);
    }
  }, [call, workspace?.directory]);
  useEffect(() => {
    void refresh();
    return () => {
      requestVersion.current += 1;
    };
  }, [refresh]);

  if (!workspace?.directory) return <Text>Workspace location unavailable</Text>;
  return (
    <ScrollView>
      <View>
        <Text>Team status</Text>
        <Button
          title={refreshing ? 'Refreshing…' : 'Refresh'}
          onPress={() => {
            void refresh();
          }}
          disabled={refreshing}
        />
        {error && <Text>Team status unavailable</Text>}
        {!snapshot && !error && <Text>Loading team status…</Text>}
        {snapshot && (
          <View>
            <Text>Team: {snapshot.teamId}</Text>
            <Text>Members</Text>
            {snapshot.members.map((member) => (
              <MemberStatus key={member.memberKey} member={member} navigation={props.navigation} />
            ))}
            <Text>Passes</Text>
            {snapshot.passes.map((pass) => (
              <Text key={pass.passId}>
                {pass.title}: {pass.status}
              </Text>
            ))}
            <Text>Tasks</Text>
            {snapshot.tasks.map((task) => (
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
            {snapshot.assignments.map((assignment) => (
              <Text key={assignment.assignmentId}>
                {assignment.taskTitle} → {assignment.memberName} ({assignment.status})
              </Text>
            ))}
            <Text>Issues</Text>
            {snapshot.issues.length ? (
              snapshot.issues.map((issue, index) => <Text key={`${index}:${issue}`}>{issue}</Text>)
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
