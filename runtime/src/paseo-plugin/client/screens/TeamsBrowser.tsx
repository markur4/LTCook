import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { defineRpc } from '@getpaseo/plugin';
import { usePaseo, useRpc, type PluginScreenProps } from '@getpaseo/plugin/client';
import type { PaseoWorkspace } from '@getpaseo/client';
import {
  SessionListRequestSchema,
  SessionListResponseSchema,
  SessionOpenRequestSchema,
  SessionOpenResponseSchema,
  type SessionListEntry,
} from '../../shared/team-catalog';
import { useTeamCatalog } from '../use-team-catalog';
import { Action, Card, Label } from '../components/PanelChrome';

const sessionListRpc = defineRpc({
  name: 'ltcook.session.list',
  input: SessionListRequestSchema,
  output: SessionListResponseSchema,
});
const sessionOpenRpc = defineRpc({
  name: 'ltcook.session.open',
  input: SessionOpenRequestSchema,
  output: SessionOpenResponseSchema,
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function latestActiveSession(sessions: SessionListEntry[], teamId: string) {
  return sessions.find(
    (session) =>
      session.teamId === teamId &&
      session.leaderAgentId !== null &&
      !session.blocker &&
      session.status?.toLocaleLowerCase() !== 'unavailable' &&
      session.status?.toLocaleLowerCase() !== 'archived',
  );
}

export function TeamsBrowser(props: PluginScreenProps) {
  const { theme } = props;
  const paseo = usePaseo();
  const catalog = useTeamCatalog();
  const callList = useRpc(sessionListRpc);
  const callOpen = useRpc(sessionOpenRpc);
  const [workspaces, setWorkspaces] = useState<PaseoWorkspace[]>([]);
  useEffect(() => {
    let mounted = true;
    void paseo.workspaces.list().then(
      (result) => {
        if (mounted) setWorkspaces(result.entries);
      },
      (failure: unknown) => {
        if (mounted) setError(errorMessage(failure));
      },
    );
    return () => {
      mounted = false;
    };
  }, [paseo]);
  const [sessions, setSessions] = useState<SessionListEntry[]>([]);
  const [sessionsState, setSessionsState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [sessionsError, setSessionsError] = useState<string>();
  const [openingSelection, setOpeningSelection] = useState<string>();

  const [error, setError] = useState<string>();
  const requestVersion = useRef(0);
  const [selectedWorkspace, setSelectedWorkspace] = useState(props.params.workspaceId);
  const uniqueRoots = new Set(workspaces.map((workspace) => workspace.workspaceDirectory));
  const workspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspace) ??
    (uniqueRoots.size === 1 ? workspaces[0] : undefined);
  const callRefresh = useCallback(async () => {
    if (!workspace?.workspaceDirectory) {
      requestVersion.current++;
      setSessions([]);
      setSessionsState('idle');
      setSessionsError(undefined);
      return;
    }
    const version = ++requestVersion.current;
    setSessionsState((state) => (state === 'ready' ? 'ready' : 'loading'));
    try {
      const result = await callList({ workspaceRoot: workspace.workspaceDirectory });
      if (requestVersion.current !== version) return;
      setSessions(result.sessions);
      setSessionsState('ready');
      setSessionsError(undefined);
    } catch (value) {
      if (requestVersion.current !== version) return;
      setSessionsState('error');
      setSessionsError(errorMessage(value));
    }
  }, [callList, workspace?.workspaceDirectory]);

  useEffect(() => {
    void callRefresh();
    if (!workspace?.workspaceDirectory) return;
    const timer = setInterval(() => void callRefresh(), 5000);
    return () => {
      requestVersion.current++;
      clearInterval(timer);
    };
  }, [callRefresh, workspace?.workspaceDirectory]);

  const openTeam = async (teamSelection: string, newSession: boolean) => {
    if (!workspace?.workspaceDirectory) return;
    setError(undefined);
    setOpeningSelection(teamSelection);
    try {
      const result = await callOpen({
        workspaceRoot: workspace.workspaceDirectory,
        teamSelection,
        ...(newSession ? { newSession: true } : {}),
      });
      if (!props.navigation) throw new Error('Native conversation navigation is unavailable');
      props.navigation.openAgent({ agentId: result.leaderAgentId });
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setOpeningSelection(undefined);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
    >
      <Label theme={theme} heading>
        Teams
      </Label>
      <Label theme={theme} muted>
        Installed Teams use local configuration. Open the most recent active Leader or start a
        separate Session.
      </Label>

      {!workspace && (
        <Card theme={theme}>
          <Label theme={theme} heading>
            Choose a workspace
          </Label>
          <Label theme={theme} muted>
            Select a native Paseo workspace or project to open its Team sessions.
          </Label>
          {workspaces.map((workspace) => (
            <Action
              key={workspace.id}
              theme={theme}
              title={`${workspace.title ?? workspace.name} · ${workspace.workspaceDirectory}`}
              onPress={() => setSelectedWorkspace(workspace.id)}
            />
          ))}
          {!workspaces.length && (
            <Label theme={theme} muted>
              Choose a project through Paseo's New workspace action, then return to Teams.
            </Label>
          )}
        </Card>
      )}

      {workspace && (
        <Card theme={theme}>
          <Label theme={theme} heading>
            {workspace.name}
          </Label>
          <Label theme={theme} muted>
            {workspace.workspaceDirectory}
          </Label>
          <Action
            theme={theme}
            title="Refresh Teams"
            onPress={() => {
              catalog.refresh();
              void callRefresh();
            }}
          />
        </Card>
      )}

      {catalog.status === 'loading' && (
        <Text accessibilityRole="progressbar" style={{ color: theme.colors.foreground }}>
          Loading local Team catalog…
        </Text>
      )}
      {catalog.status === 'error' && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          Could not load local Teams: {catalog.message}
        </Text>
      )}
      {catalog.status === 'error' && (
        <Action theme={theme} title="Retry Teams" onPress={catalog.refresh} />
      )}
      {sessionsState === 'loading' && (
        <Text accessibilityRole="progressbar" style={{ color: theme.colors.foreground }}>
          Loading Team sessions…
        </Text>
      )}
      {sessionsState === 'error' && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          Could not load Team sessions: {sessionsError}
        </Text>
      )}
      {error && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          {error}
        </Text>
      )}

      {catalog.status === 'ready' &&
        catalog.teams.map((team) => {
          const active = latestActiveSession(sessions, team.teamId);
          const blocked = sessions.find(
            (session) => session.teamId === team.teamId && session.blocker,
          );
          const opening = openingSelection === team.selection;
          return (
            <Card key={team.selection} theme={theme}>
              <Label theme={theme} heading>
                {team.name}
              </Label>
              <Label theme={theme} muted>
                {team.description}
              </Label>
              <Label theme={theme}>
                Leader: {team.leader.name} · {team.persistentMembers} persistent ·{' '}
                {team.temporaryMembers} temporary
              </Label>
              {team.status !== 'installed' && (
                <Label theme={theme} muted>
                  {team.status === 'available'
                    ? 'Available to install'
                    : `Unavailable: ${team.reason ?? 'configuration is invalid'}`}
                </Label>
              )}
              {active && (
                <Label theme={theme} muted>
                  Recent Leader: {active.title ?? team.leader.name} ·{' '}
                  {active.status ?? 'status unavailable'}
                </Label>
              )}
              {!active && blocked && (
                <Label theme={theme} muted>
                  {blocked.blocker} New Session starts a separate conversation.
                </Label>
              )}
              {!active && !blocked && sessionsState === 'ready' && workspace && (
                <Label theme={theme} muted>
                  No active Leader; opening will start a Session.
                </Label>
              )}
              {workspace && team.status === 'installed' && (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <Action
                    theme={theme}
                    title={opening ? 'Opening…' : 'Open Leader chat'}
                    disabled={
                      Boolean(openingSelection) ||
                      sessionsState === 'loading' ||
                      (!active && Boolean(blocked))
                    }
                    onPress={() => void openTeam(team.selection, false)}
                  />
                  <Action
                    theme={theme}
                    title={opening ? 'Starting…' : 'New Session'}
                    disabled={Boolean(openingSelection)}
                    onPress={() => void openTeam(team.selection, true)}
                  />
                </View>
              )}
            </Card>
          );
        })}
      {catalog.status === 'ready' && !catalog.teams.length && (
        <Label theme={theme} muted>
          No Teams are configured in the local teams directory.
        </Label>
      )}
    </ScrollView>
  );
}
