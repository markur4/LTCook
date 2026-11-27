import { Fragment, memo, useEffect, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import {
  useSubscription,
  useTabState,
  type PluginAgentPanelProps,
  type PluginClientContext,
  type PluginWorkspacePanelProps,
} from '@getpaseo/plugin/client';
import { ScrollView, SettingsSelect, TextInput } from '@getpaseo/plugin/client/ui';
import { z } from 'zod';
import {
  repositoryQuerySubscription,
  repositoryQueryWorkspaceSubscription,
} from '../../shared/repository-query';
import { Action, Card, Label, type Theme } from '../components/PanelChrome';
import type { RepositoryFilterInput } from '../../../repository/filter';

export const REPOSITORY_QUERY_PANEL_ID = 'rag-repository-query';
export const WORKSPACE_QUERY_PANEL_ID = 'workspace-repository-query';

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
const filterFields = [
  { key: 'includePaths', label: 'Include paths', placeholder: 'src/**' },
  { key: 'excludePaths', label: 'Exclude paths', placeholder: '**/generated/**' },
  { key: 'includeText', label: 'Include literal text', placeholder: 'restoreSession' },
  { key: 'excludeText', label: 'Exclude literal text', placeholder: '__main__' },
  { key: 'includeRegex', label: 'Include regex', placeholder: '\\bsession\\b' },
  { key: 'excludeRegex', label: 'Exclude regex', placeholder: '^import ' },
] as const;
type FilterDraft = Partial<Record<keyof RepositoryFilterInput, string>>;
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

// > Repository evidence emits one JSON object per metadata line. Numbered source stays plain.
const jsonToken = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;

function HighlightedJsonLine({ line, theme }: { line: string; theme: Theme }) {
  const fragments: ReactNode[] = [];
  let offset = 0;
  for (const { 0: token, index } of line.matchAll(jsonToken)) {
    const end = index + token.length;
    const color =
      token[0] === '"'
        ? line[end] === ':'
          ? theme.colors.accent
          : theme.colors.statusSuccess
        : /^-?\d/.test(token)
          ? theme.colors.statusWarning
          : theme.colors.foregroundMuted;
    fragments.push(
      <Fragment key={index}>
        {line.slice(offset, index)}
        <Text style={{ color }}>{token}</Text>
      </Fragment>,
    );
    offset = end;
  }
  return (
    <>
      {fragments}
      {line.slice(offset)}
    </>
  );
}

const QueryResult = memo(function QueryResult({ text, theme }: { text: string; theme: Theme }) {
  return (
    <Text
      selectable
      testID="ltcook-repository-query-result"
      style={{ color: theme.colors.foreground, fontFamily: 'monospace', lineHeight: 20 }}
    >
      {text.split('\n').map((line, index) => (
        <Fragment key={index}>
          {index > 0 && '\n'}
          {line.startsWith('{') && line.endsWith('}') ? (
            <HighlightedJsonLine line={line} theme={theme} />
          ) : (
            line
          )}
        </Fragment>
      ))}
    </Text>
  );
});

function QueryForm({
  target,
  scope,
  theme,
}: {
  target: { agentId: string } | { workspaceId: string };
  scope: RepositoryScope;
  theme: Theme;
}) {
  const [tool, setTool] = useState<RepositoryTool>('search');
  const [mode, setMode] = useState<SearchMode>('hybrid');
  const [query, setQuery] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [filterDraft, setFilterDraft] = useState<FilterDraft>({});
  const [argumentsText, setArgumentsText] = useState('');
  const [pending, setPending] = useState<QueryInput>();
  const [output, setOutput] = useState<QueryOutput>();
  const running = pending !== undefined;
  const label = advanced ? 'Tool arguments (JSON)' : tool === 'search' ? 'Search query' : 'Symbol';
  const value = advanced ? argumentsText : query;
  const lexical = !advanced && tool === 'search' && mode !== 'hybrid' && mode !== 'semantic';
  const hasInput = (lexical ? value : value.trim()).length > 0;

  function simpleInput() {
    const filter: RepositoryFilterInput = {};
    for (const { key } of filterFields) {
      const rules = filterDraft[key]?.split(/\r?\n/).filter((rule) => rule.length > 0);
      if (rules?.length) filter[key] = rules;
    }
    return {
      ...(tool === 'search' ? { query, mode } : { symbol: query.trim() }),
      ...(Object.keys(filter).length && { filter }),
    };
  }

  function submit() {
    if (running || !hasInput) return;
    let input;
    try {
      input = advanced ? toolArgumentsSchema.parse(JSON.parse(argumentsText)) : simpleInput();
    } catch {
      setOutput({ error: 'Enter a valid JSON object with the tool arguments.' });
      return;
    }
    setOutput(undefined);
    setPending({ ...target, workspaceIdentity: scope.identity, request: { tool, input } });
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
            onValueChange={(value) => {
              setMode(value);
              setArgumentsText('');
            }}
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
          onChangeText={(value) => {
            if (advanced) setArgumentsText(value);
            else {
              setQuery(value);
              setArgumentsText('');
            }
          }}
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
        {!advanced && showFilters && (
          <>
            <Label theme={theme} muted>
              Enter one rule per line.
            </Label>
            {filterFields.map(({ key, label, placeholder }) => (
              <View key={key} style={{ gap: 4 }}>
                <Label theme={theme}>{label}</Label>
                <TextInput
                  accessibilityLabel={label}
                  placeholder={placeholder}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  value={filterDraft[key] ?? ''}
                  onChangeText={(value) => {
                    setFilterDraft((draft) => ({ ...draft, [key]: value }));
                    setArgumentsText('');
                  }}
                  editable={!running}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{
                    color: theme.colors.foreground,
                    borderColor: theme.colors.border,
                    borderWidth: 1,
                    borderRadius: 6,
                    padding: 8,
                  }}
                />
              </View>
            ))}
          </>
        )}
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
          {!advanced && (
            <Action
              theme={theme}
              title={showFilters ? 'Hide filters' : 'Filters'}
              disabled={running}
              onPress={() => setShowFilters((visible) => !visible)}
            />
          )}
          <Action
            theme={theme}
            title={advanced ? 'Use simple input' : 'Edit tool arguments'}
            disabled={running}
            onPress={() => {
              if (!advanced && !argumentsText)
                setArgumentsText(JSON.stringify(simpleInput(), null, 2));
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
            <QueryResult text={output.result} theme={theme} />
          ))}
      </View>
    </>
  );
}

function QueryTab({ theme, children }: { theme: Theme; children: ReactNode }) {
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
      {children}
    </ScrollView>
  );
}

export function WorkspaceRepositoryQuery({ workspaceId, theme }: PluginWorkspacePanelProps) {
  const [scope, setScope] = useState<RepositoryScope | null>();
  const stream = useSubscription(repositoryQueryWorkspaceSubscription, { workspaceId }, setScope);
  const unavailable = scope === null || stream.status === 'closed' || stream.status === 'error';

  return (
    <QueryTab theme={theme}>
      {scope && !unavailable ? (
        <QueryForm key={scope.identity} theme={theme} target={{ workspaceId }} scope={scope} />
      ) : (
        <Label theme={theme} muted>
          {unavailable
            ? 'Repository search is unavailable for this workspace.'
            : 'Opening repository…'}
        </Label>
      )}
    </QueryTab>
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
    <QueryTab theme={theme}>
      {scope ? (
        <QueryForm
          key={JSON.stringify([key, scope.identity])}
          theme={theme}
          target={{ agentId: params.agentId }}
          scope={scope}
        />
      ) : (
        <Label theme={theme} muted>
          Open Query Repo from the RAG Index card in Activity.
        </Label>
      )}
    </QueryTab>
  );
}
