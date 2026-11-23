import { useState } from 'react';
import { useComposer } from '@getpaseo/plugin/client';
import { Action, Select } from '@getpaseo/plugin/client/ui';
import { Text, View } from 'react-native';
import type { PluginComposerItemProps } from '@getpaseo/plugin/client';
import {
  MODEL_ALIAS_METADATA_KEY,
  MODEL_REASONING_METADATA_KEY,
  RESOLVED_MODEL_METADATA_KEY,
  ResolvedModelSchema,
  type ReasoningEffort,
  type ResolvedModel,
} from '../../shared/models';
import { useModelCatalog } from '../use-model-catalog';

const TEAM_METADATA_KEY = 'ltcook.team';
const USE_PRESET = 'inherit';

function stringMetadata(metadata: Readonly<Record<string, unknown>>, key: string) {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function reasoningLabel(reasoning: ReasoningEffort | undefined) {
  if (reasoning === 'none') return 'off';
  return reasoning ?? 'provider default';
}

function resolutionLabel(model: ResolvedModel) {
  const effort = reasoningLabel(model.reasoning);
  if (model.reasoningSource === 'session')
    return `${effort} · Session setting overrides alias preset`;
  if (model.reasoningSource === 'team')
    return model.preset && model.preset !== model.reasoning
      ? `${effort} · Team setting overrides alias preset`
      : `${effort} · Team setting`;
  if (model.reasoningSource === 'default') return effort;
  return `${effort} · alias preset`;
}

function ModelBadge({
  theme,
  model,
}: {
  theme: PluginComposerItemProps['theme'];
  model: ResolvedModel;
}) {
  const label = `@${model.alias} · ${model.provider}/${model.model} · ${resolutionLabel(model)}`;
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`Model ${label}; read only for a running conversation`}
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
      <Text style={{ color: theme.colors.foreground }}>Model · {label}</Text>
    </View>
  );
}

export function ModelComposerItem({ theme }: PluginComposerItemProps) {
  const composer = useComposer();
  const isLtcook = composer.agent.provider === 'ltcook';
  const canChooseModel = isLtcook && composer.context !== 'agent';
  const teamSelection = stringMetadata(composer.agent.metadata, TEAM_METADATA_KEY);
  const catalog = useModelCatalog(teamSelection, canChooseModel);
  const [error, setError] = useState<string>();
  const storedModel = ResolvedModelSchema.safeParse(
    composer.agent.metadata[RESOLVED_MODEL_METADATA_KEY],
  );

  if (composer.context === 'agent' && storedModel.success)
    return <ModelBadge theme={theme} model={storedModel.data} />;
  if (!canChooseModel) return null;

  const selectedAlias = stringMetadata(composer.agent.metadata, MODEL_ALIAS_METADATA_KEY);
  const selectedReasoning = stringMetadata(composer.agent.metadata, MODEL_REASONING_METADATA_KEY);
  const selected =
    catalog.status === 'ready'
      ? (selectedAlias ?? catalog.catalog.teamAlias)
      : (selectedAlias ?? '');
  const alias =
    catalog.status === 'ready'
      ? catalog.catalog.aliases.find((item) => item.alias === selected)
      : undefined;
  const options =
    catalog.status === 'ready'
      ? [
          {
            value: '',
            label: 'Team assignment',
            description: `Use @${catalog.catalog.teamAlias} for the Leader`,
          },
          ...catalog.catalog.aliases.map((item) => ({
            value: item.alias,
            label: `@${item.alias}`,
            description: `${item.provider}/${item.model}`,
          })),
          ...(selectedAlias && !catalog.catalog.aliases.some((item) => item.alias === selectedAlias)
            ? [
                {
                  value: selectedAlias,
                  label: `@${selectedAlias} · unavailable`,
                  description: 'Choose an installed model alias',
                },
              ]
            : []),
        ]
      : [{ value: '', label: 'Loading models', description: '' }];

  const reasoningOptions = alias?.reasoningOptions ?? [];
  const reasoningValue = selectedReasoning ?? USE_PRESET;
  const availableReasoningOptions = [
    {
      value: USE_PRESET,
      label: 'Alias and Team settings',
      description: 'Keep the preset reasoning effort',
    },
    ...reasoningOptions.map((reasoning) => ({
      value: reasoning,
      label: reasoning === 'none' ? 'Off' : reasoning,
      description: `Set ${reasoning === 'none' ? 'reasoning off' : `${reasoning} reasoning`} for this Session`,
    })),
    ...(selectedReasoning && !reasoningOptions.includes(selectedReasoning as ReasoningEffort)
      ? [
          {
            value: selectedReasoning,
            label: `${selectedReasoning} · unsupported`,
            description: 'Choose a supported effort or clear this Session override',
          },
        ]
      : []),
  ];

  const saveMetadata = (key: string, value: string | null) =>
    composer.setMetadata({ [key]: value }).then(
      () => setError(undefined),
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    );
  const chooseAlias = (value: string) => saveMetadata(MODEL_ALIAS_METADATA_KEY, value || null);
  const chooseReasoning = (value: string) =>
    saveMetadata(MODEL_REASONING_METADATA_KEY, value === USE_PRESET ? null : value);

  const preview = alias
    ? selectedReasoning
      ? {
          ...alias,
          reasoning: selectedReasoning as ReasoningEffort,
          reasoningSource: 'session' as const,
        }
      : alias
    : undefined;
  const validSessionReasoning =
    selectedReasoning !== undefined &&
    reasoningOptions.includes(selectedReasoning as ReasoningEffort);
  const overrideError = Boolean(selectedReasoning && !validSessionReasoning);
  const configurationError =
    !validSessionReasoning && alias?.configurationError ? alias.configurationError : undefined;

  return (
    <View style={{ gap: 4 }}>
      <Select
        title="Model"
        icon="Cpu"
        value={selectedAlias ?? ''}
        options={options}
        disabled={catalog.status !== 'ready'}
        onValueChange={({ value }) => chooseAlias(value)}
      />
      {alias && (
        <Select
          title="Reasoning"
          icon="Brain"
          value={reasoningValue}
          options={availableReasoningOptions}
          disabled={catalog.status !== 'ready'}
          onValueChange={({ value }) => chooseReasoning(value)}
        />
      )}
      {preview && (
        <Text style={{ color: theme.colors.foregroundMuted }}>
          @{preview.alias} · {preview.provider}/{preview.model} · {resolutionLabel(preview)}
        </Text>
      )}
      {overrideError && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          This reasoning override is unavailable for @{selected}. Choose a supported effort or clear
          the override.
        </Text>
      )}
      {configurationError && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          {configurationError}
        </Text>
      )}
      {selectedAlias && !alias && catalog.status === 'ready' && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          @{selectedAlias} is not available. Choose a model alias or use the Team assignment.
        </Text>
      )}
      {catalog.status === 'error' && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          Could not load model aliases: {catalog.message}
        </Text>
      )}
      {catalog.status === 'error' && (
        <Action icon="RefreshCw" title="Retry models" onPress={catalog.refresh} />
      )}
      {error && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          Could not save model selection: {error}
        </Text>
      )}
    </View>
  );
}
