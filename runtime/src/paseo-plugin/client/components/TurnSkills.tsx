import { useState } from 'react';
import { Text, View } from 'react-native';
import {
  useAgent,
  type PluginClientContext,
  type PluginTimelineItemProps,
} from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/ui';
import type { z } from 'zod';
import type { SkillLoad, TurnSkillsTimelineSchema } from '../../shared/activity';
import { openSkillDocument, SkillPreview } from '../screens/SkillDocument';
import { ActivityButton } from './ActivityCard';

export function TurnSkills({
  agentId,
  host,
  item,
  theme,
  client,
}: PluginTimelineItemProps<z.infer<typeof TurnSkillsTimelineSchema>> & {
  client: Pick<PluginClientContext, 'openPanel'>;
}) {
  const { skills } = item.data;
  const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  const toast = useToast();
  const [selectedSkillId, setSelectedSkillId] = useState<string>();
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId);

  function open(skill: SkillLoad) {
    if (!workspaceId) return;
    try {
      openSkillDocument(client, host.id, workspaceId, agentId, skill);
    } catch {
      toast.error('Could not open the skill document.');
    }
  }

  return (
    <View style={{ minWidth: 0, gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        {skills.map((skill) => (
          <ActivityButton
            key={skill.id}
            theme={theme}
            label={`Preview skill ${skill.name}`}
            expanded={selectedSkill?.id === skill.id}
            onPress={() =>
              setSelectedSkillId(selectedSkill?.id === skill.id ? undefined : skill.id)
            }
          >
            <Text style={{ color: theme.colors.foreground }}>{skill.name}</Text>
          </ActivityButton>
        ))}
      </View>
      {selectedSkill && (
        <View
          testID="ltcook-passage-skill-preview"
          style={{
            gap: 8,
            padding: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <SkillPreview
            key={selectedSkill.id}
            agentId={agentId}
            skill={selectedSkill}
            theme={theme}
          />
          {selectedSkill.documentAvailable && workspaceId && (
            <View style={{ alignItems: 'flex-start' }}>
              <ActivityButton
                theme={theme}
                label="Open in new tab"
                onPress={() => open(selectedSkill)}
              >
                <Text style={{ color: theme.colors.foreground }}>Open in new tab</Text>
              </ActivityButton>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
