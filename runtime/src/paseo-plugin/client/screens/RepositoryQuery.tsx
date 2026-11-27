import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import {
  useSubscription,
  useTabState,
  type PluginAgentPanelProps,
  type PluginClientContext,
} from '@getpaseo/plugin/client';
import { ScrollView, SettingsSelect, TextInput } from '@getpaseo/plugin/client/ui';
import { z } from 'zod';
import { repositoryQuerySubscription } from '../../shared/repository-query';
import { Action, Card, Label, type Theme } from '../components/PanelChrome';

export const REPOSITORY_QUERY_PANEL_ID = 'rag-repository-query';

const repositoryScopeSchema = z.object({ identity: z.string().min(1), path: z.string().min(1) });
type RepositoryScope = z.infer<typeof repositoryScopeSchema>;
const pendingScopes = new Map<string, RepositoryScope>();

function scopeKey(hostId: string, workspaceId: string, agentId: string): string {
  return JSON.stringify([hostId, workspaceId, agentId]);
}

export function openRepositoryQuery(
  client: Pick<PluginClientContext, 'openPanel'>,
  hostId: string,
  workspaceId: string,
  agentId: string,
  scope: RepositoryScope,
): void {
  const key = scopeKey(hostId, workspaceId, agentId);
  pendingScopes.set(key, scope);
  try {
    client.openPanel(REPOSITORY_QUERY_PANEL_ID, { workspaceId, agentId, location: 'workspace' });
  } catch (error) {
    pendingScopes.delete(key);
    throw error;
  }
}

export function clearPendingRepositoryQueries(): void {
  pendingScopes.clear();
}

const tools = [
  { value: 'search', label: 'ltcook_repo_search' },
  { value: 'locate', label: 'ltcook_repo_locate' },
] as const;
const searchModes = [
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'semantic', label: 'Semantic' },
  { value: 'exact', label: 'Exact' },
  { value: 'literal', label: 'Literal' },
  { value: 'regex', label: 'Regular expression' },
] as const;
const toolArgumentsSchema = z.record(z.string(), z.json());
type RepositoryTool = (typeof tools)[number]['value'];
type SearchMode = (typeof searchModes)[number]['value'];
type QueryInput = z.input<typeof repositoryQuerySubscription.input>;
type QueryOutput = { result: string } | { error: string };

function RunningQuery({
  input,
  onFinish,
}: {
  input: QueryInput;
  onFinish: (output: QueryOutput) => void;
}) {
  const stream = useSubscription(repositoryQuerySubscription, input, ({ text }) =>
    onFinish({ result: text }),
  );
  useEffect(() => {
    if (stream.status === 'error') onFinish({ error: stream.error.message });
    if (stream.status === 'closed') onFinish({ error: 'The repository tool disconnected.' });
  }, [stream, onFinish]);
  return null;
}

function QueryForm({
  agentId,
  scope,
  theme,
}: {
  agentId: string;
  scope: RepositoryScope;
  theme: Theme;
}) {
  const [tool, setTool] = useState<RepositoryTool>('search');
  const [mode, setMode] = useState<SearchMode>('hybrid');
  const [query, setQuery] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [argumentsText, setArgumentsText] = useState('');
  const [pending, setPending] = useState<QueryInput>();
  const [output, setOutput] = useState<QueryOutput>();
  const running = pending !== undefined;
  const label = advanced ? 'Tool arguments (JSON)' : tool === 'search' ? 'Search query' : 'Symbol';
  const value = advanced ? argumentsText : query;
  const lexical = !advanced && tool === 'search' && mode !== 'hybrid' && mode !== 'semantic';
  const hasInput = (lexical ? value : value.trim()).length > 0;

  function submit() {
    if (running || !hasInput) return;
    let input;
    try {
      input = advanced
        ? toolArgumentsSchema.parse(JSON.parse(argumentsText))
        : tool === 'search'
          ? { query, mode }
          : { symbol: query.trim() };
    } catch {
      setOutput({ error: 'Enter a valid JSON object with the tool arguments.' });
      return;
    }
    setOutput(undefined);
    setPending({ agentId, workspaceIdentity: scope.identity, request: { tool, input } });
  }

  function finish(result: QueryOutput) {
    setPending(undefined);
    setOutput(result);
  }

  return (
    <>
      <Label theme={theme} heading>
        Query Repo
      </Label>
      <Label theme={theme} muted>
        {scope.path}
      </Label>
      <Card theme={theme}>
        <SettingsSelect<RepositoryTool>
          label="Repository tool"
          value={tool}
          options={tools}
          onValueChange={(value) => {
            setTool(value);
            setArgumentsText('');
          }}
          disabled={running}
        />
        {!advanced && tool === 'search' && (
          <SettingsSelect<SearchMode>
            label="Search mode"
            value={mode}
            options={searchModes}
            onValueChange={setMode}
            disabled={running}
          />
        )}
        <TextInput
          accessibilityLabel={label}
          placeholder={label}
          placeholderTextColor={theme.colors.foregroundMuted}
          value={value}
          maxLength={advanced ? undefined : 1024}
          multiline={advanced}
          editable={!running}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={advanced ? setArgumentsText : setQuery}
          onSubmitEditing={advanced ? undefined : submit}
          style={{
            color: theme.colors.foreground,
            borderColor: theme.colors.border,
            borderWidth: 1,
            borderRadius: 6,
            padding: 10,
            ...(advanced && { minHeight: 100, fontFamily: 'monospace', textAlignVertical: 'top' }),
          }}
        />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {pending ? (
            <Action
              theme={theme}
              title="Cancel query"
              onPress={() => finish({ error: 'Query canceled.' })}
            />
          ) : (
            <Action theme={theme} title="Run query" disabled={!hasInput} onPress={submit} />
          )}
          <Action
            theme={theme}
            title={advanced ? 'Use simple input' : 'Edit tool arguments'}
            disabled={running}
            onPress={() => {
              if (!advanced && !argumentsText)
                setArgumentsText(
                  JSON.stringify(tool === 'search' ? { query, mode } : { symbol: query }, null, 2),
                );
              setAdvanced(!advanced);
            }}
          />
        </View>
      </Card>
      {pending && <RunningQuery input={pending} onFinish={finish} />}
      <View accessibilityLiveRegion="polite">
        {running && (
          <Label theme={theme} muted>
            Waiting for the repository tool…
          </Label>
        )}
        {output &&
          ('error' in output ? (
            <Text selectable style={{ color: theme.colors.statusDanger }}>
              {output.error}
            </Text>
          ) : (
            <Text
              selectable
              testID="ltcook-repository-query-result"
              style={{ color: theme.colors.foreground, fontFamily: 'monospace', lineHeight: 20 }}
            >
              {output.result}
            </Text>
          ))}
      </View>
    </>
  );
}

export function RepositoryQuery({
  host,
  params,
  workspaceId,
  theme,
  revision,
  tab,
}: PluginAgentPanelProps) {
  const key = scopeKey(host.id, workspaceId, params.agentId);
  const [persisted, setPersisted] = useTabState(tab, repositoryScopeSchema.nullable(), null);
  const scope = pendingScopes.get(key) ?? persisted;

  useEffect(() => {
    const pending = pendingScopes.get(key);
    if (!pending) return;
    pendingScopes.delete(key);
    setPersisted(pending);
  }, [key, revision, setPersisted]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        padding: 16,
        gap: 12,
        width: '100%',
        maxWidth: 1100,
        alignSelf: 'center',
      }}
      testID="ltcook-repository-query"
    >
      {scope ? (
        <QueryForm
          key={JSON.stringify([key, scope.identity])}
          theme={theme}
          agentId={params.agentId}
          scope={scope}
        />
      ) : (
        <Label theme={theme} muted>
          Open Query Repo from the RAG Index card in Activity.
        </Label>
      )}
    </ScrollView>
  );
}
