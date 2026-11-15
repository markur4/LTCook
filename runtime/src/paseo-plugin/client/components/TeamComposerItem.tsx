import { useEffect, useState } from 'react';
import { useComposer } from '@getpaseo/plugin/client';
import { Action, Select } from '@getpaseo/plugin/client/ui';
import { Text, View } from 'react-native';
import type { PluginComposerItemProps } from '@getpaseo/plugin/client';
import { useTeamCatalog } from '../use-team-catalog';

const teamMetadataKey = 'ltcook.team';

function selectedTeam(metadata: Readonly<Record<string, unknown>>): string | undefined {
  const selection = metadata[teamMetadataKey];
  return typeof selection === 'string' ? selection : undefined;
}

export function TeamComposerItem({ theme, layout }: PluginComposerItemProps) {
  const composer = useComposer();
  const isLtcook = composer.agent.provider === 'ltcook';
  const canChooseTeam = isLtcook && composer.context !== 'agent';
  const isRunningLtcook = isLtcook && composer.context === 'agent';
  const catalog = useTeamCatalog(canChooseTeam || isRunningLtcook);
  const [error, setError] = useState<string>();

  const installed = catalog.teams
    .filter((team) => team.status === 'installed')
    .sort((left, right) => left.name.localeCompare(right.name));
  const stored = selectedTeam(composer.agent.metadata);
  const knownTeam = catalog.teams.find((team) => team.selection === stored);
  const selected = installed.some((team) => team.selection === stored)
    ? stored!
    : installed.some((team) => team.selection === 'default')
      ? 'default'
      : installed.length === 1
        ? installed[0]!.selection
        : '';
  const saveSelection = (value: string) =>
    composer.setMetadata({ [teamMetadataKey]: value }).then(
      () => setError(undefined),
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    );
  useEffect(() => {
    if (!canChooseTeam || catalog.status !== 'ready' || !selected || stored === selected) return;
    void composer.setMetadata({ [teamMetadataKey]: selected }).then(
      () => setError(undefined),
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, [canChooseTeam, catalog.status, composer.setMetadata, selected, stored]);
  if (isRunningLtcook) {
    const label = knownTeam
      ? `${knownTeam.name} · ${knownTeam.status}`
      : stored
        ? `${stored} · ${catalog.status === 'loading' ? 'loading details' : 'unavailable'}`
        : 'not set';
    return (
      <View
        accessibilityRole="text"
        accessibilityLabel={`Team ${label}; read only for a running conversation`}
        style={{
          alignSelf: 'flex-start',
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
          borderRadius: 12,
          borderWidth: 1,
          paddingHorizontal: 10,
          paddingVertical: 5,
        }}
      >
        <Text style={{ color: theme.colors.foreground }}>Team · {label}</Text>
      </View>
    );
  }
  if (!canChooseTeam) return null;

  const options = installed.map((team) => ({
    value: team.selection,
    label: team.name,
    description: team.description,
  }));
  if (options.length === 0)
    options.push({ value: '', label: 'No installed Teams', description: '' });

  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>Team</Text>
      <Text style={{ color: theme.colors.foreground }}>
        Selected Team:{' '}
        {installed.find((team) => team.selection === selected)?.name ?? 'Choose a Team'}
      </Text>
      {layout.compact ? (
        <View style={{ gap: 4 }}>
          {installed.map((team) => (
            <Action
              key={team.selection}
              title={team.name}
              icon={selected === team.selection ? 'Check' : 'Users'}
              disabled={catalog.status !== 'ready'}
              onPress={() => saveSelection(team.selection)}
            />
          ))}
        </View>
      ) : (
        <Select
          title={catalog.status === 'loading' ? 'Loading Teams' : 'Team'}
          icon="Users"
          value={selected}
          options={options}
          disabled={catalog.status !== 'ready' || installed.length === 0}
          onValueChange={({ value }) => saveSelection(value)}
        />
      )}
      {catalog.status === 'error' && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          Could not load Teams: {catalog.message}
        </Text>
      )}
      {catalog.status === 'error' && (
        <Action icon="RefreshCw" title="Retry Teams" onPress={catalog.refresh} />
      )}
      {error && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          Could not save Team selection: {error}
        </Text>
      )}
    </View>
  );
}
