import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import {
  useRpc,
  useTabState,
  type PluginAgentPanelProps,
  type PluginClientContext,
} from '@getpaseo/plugin/client';
import { Markdown, ScrollView } from '@getpaseo/plugin/client/ui';
import { z } from 'zod';
import {
  ActivityAnchorSchema,
  activitySkillDocumentRpc,
  type SkillLoad,
} from '../../shared/activity';
import type { Theme } from '../components/PanelChrome';

export const SKILL_DOCUMENT_PANEL_ID = 'activity-skill-document';

const skillSelectionSchema = z.object({
  skillId: z.string(),
  name: z.string(),
  occurrence: ActivityAnchorSchema.optional(),
});
type SkillSelection = z.infer<typeof skillSelectionSchema>;

const pendingSelections = new Map<string, SkillSelection>();

function selectionKey(hostId: string, agentId: string): string {
  return JSON.stringify([hostId, agentId]);
}

function selectSkill(skill: SkillLoad): SkillSelection {
  return { skillId: skill.id, name: skill.name, occurrence: skill.occurrences.at(-1) };
}

export function openSkillDocument(
  client: Pick<PluginClientContext, 'openPanel'>,
  hostId: string,
  workspaceId: string,
  agentId: string,
  skill: SkillLoad,
): void {
  const key = selectionKey(hostId, agentId);
  pendingSelections.set(key, selectSkill(skill));
  try {
    client.openPanel(SKILL_DOCUMENT_PANEL_ID, { workspaceId, agentId, location: 'workspace' });
  } catch (error) {
    pendingSelections.delete(key);
    throw error;
  }
}

export function clearPendingSkillDocuments(): void {
  pendingSelections.clear();
}

function SkillMarkdown({
  agentId,
  selection,
  theme,
  view,
}: {
  agentId: string;
  selection: SkillSelection;
  theme: Theme;
  view: 'preview' | 'full';
}) {
  const read = useRpc(activitySkillDocumentRpc);
  const [result, setResult] = useState<{ markdown: string } | { error: true }>();
  const { skillId, occurrence } = selection;

  useEffect(() => {
    let active = true;
    void read({ agentId, skillId, occurrence, view }).then(
      ({ markdown }) => {
        if (active) setResult({ markdown });
      },
      () => {
        if (active) setResult({ error: true });
      },
    );
    return () => {
      active = false;
    };
  }, [agentId, skillId, occurrence, read, view]);

  if (!result || 'error' in result) {
    return (
      <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>
        {result ? 'Skill document is unavailable.' : 'Loading skill…'}
      </Text>
    );
  }
  return <Markdown>{result.markdown}</Markdown>;
}

export function SkillPreview({
  agentId,
  skill,
  theme,
}: {
  agentId: string;
  skill: SkillLoad;
  theme: Theme;
}) {
  return (
    <>
      {skill.description && (
        <Text style={{ color: theme.colors.foregroundMuted }}>{skill.description}</Text>
      )}
      {skill.documentAvailable ? (
        <SkillMarkdown
          agentId={agentId}
          selection={selectSkill(skill)}
          theme={theme}
          view="preview"
        />
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted }}>Skill document is unavailable.</Text>
      )}
    </>
  );
}

export function SkillDocument({ host, params, theme, revision, tab }: PluginAgentPanelProps) {
  const key = selectionKey(host.id, params.agentId);
  const [persisted, setPersisted] = useTabState(tab, skillSelectionSchema.nullable(), null);
  const selection = pendingSelections.get(key) ?? persisted;

  useEffect(() => {
    const pending = pendingSelections.get(key);
    if (!pending) return;
    pendingSelections.delete(key);
    setPersisted(pending);
  }, [key, revision, setPersisted]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 16, gap: 8 }}
      testID="ltcook-skill-document"
    >
      {selection ? (
        <View style={{ gap: 10 }}>
          <Text
            accessibilityRole="header"
            style={{ color: theme.colors.foreground, fontWeight: '600', fontSize: 18 }}
          >
            {selection.name}
          </Text>
          <SkillMarkdown
            key={JSON.stringify(selection)}
            agentId={params.agentId}
            selection={selection}
            theme={theme}
            view="full"
          />
        </View>
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Open a skill from Activity or the chat.
        </Text>
      )}
    </ScrollView>
  );
}
