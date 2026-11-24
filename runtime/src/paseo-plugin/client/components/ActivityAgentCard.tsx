import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { Icon } from '@getpaseo/plugin/client/ui';
import type { AgentActivity, SkillLoad, ToolCall } from '../../shared/activity';
import {
  ActivityButton,
  ActivityCard,
  ActivityField,
  ActivityStatus,
  ActivityText,
  activityColor,
  contextDescription,
  contextObservation,
  statusLabel,
} from './ActivityCard';
import type { Theme } from './PanelChrome';

const RECENT_LIMIT = 5;

type Preview = { kind: 'tool' | 'skill'; id: string };

const agentTones = {
  running: 'running',
  finished: 'success',
  waiting: 'warning',
  failed: 'danger',
  idle: 'muted',
  unknown: 'muted',
} as const satisfies Record<AgentActivity['status'], string>;

const toolIcons = {
  running: 'CircleDot',
  success: 'Check',
  failed: 'X',
  cancelled: 'Minus',
  unknown: 'CircleHelp',
} as const;

const toolTones = {
  running: 'running',
  success: 'success',
  failed: 'danger',
  cancelled: 'muted',
  unknown: 'muted',
} as const;

function orderTools(calls: ToolCall[]) {
  const unique = [...new Map(calls.map((call) => [call.id, call])).values()];
  const running = unique
    .filter((call) => call.status === 'running')
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  const recent = unique
    .filter((call) => call.status !== 'running')
    .sort(
      (a, b) =>
        (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt) || a.id.localeCompare(b.id),
    );
  return { running, recent };
}

function orderSkills(loads: SkillLoad[]) {
  const latest = new Map<string, SkillLoad>();
  for (const load of loads) {
    if ((latest.get(load.id)?.loadedAt ?? -1) <= load.loadedAt) latest.set(load.id, load);
  }
  return [...latest.values()].sort((a, b) => b.loadedAt - a.loadedAt || a.id.localeCompare(b.id));
}

function ActivityChips<T>({
  theme,
  label,
  items,
  recentOffset = 0,
  expanded,
  onToggle,
  empty,
  renderItem,
}: {
  theme: Theme;
  label: string;
  items: T[] | null;
  recentOffset?: number;
  expanded: boolean;
  onToggle: () => void;
  empty: string;
  renderItem: (item: T) => ReactNode;
}) {
  const limit = RECENT_LIMIT + recentOffset;
  const older = Math.max(0, (items?.length ?? 0) - limit);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
      <View style={{ width: 38, paddingTop: 4 }}>
        <ActivityText theme={theme} tone="muted">
          {label}
        </ActivityText>
      </View>
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
        {items?.length ? (
          items.slice(0, limit).map(renderItem)
        ) : (
          <ActivityText theme={theme} tone="muted">
            {items ? empty : 'Unavailable'}
          </ActivityText>
        )}
        {older > 0 && (
          <ActivityButton
            theme={theme}
            label={`${expanded ? 'Hide' : 'Show'} ${older} older ${label.toLowerCase()}`}
            expanded={expanded}
            onPress={onToggle}
          >
            <ActivityText theme={theme} tone="muted">
              ...
            </ActivityText>
          </ActivityButton>
        )}
        {expanded && items?.slice(limit).map(renderItem)}
      </View>
    </View>
  );
}

function ItemPreview({
  theme,
  name,
  description,
  preview,
  status,
  tone,
  children,
  onClose,
}: {
  theme: Theme;
  name: string;
  description?: string;
  preview?: string;
  status: string;
  tone: (typeof toolTones)[keyof typeof toolTones];
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 5,
        padding: 7,
        gap: 5,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <ActivityText theme={theme} strong>
            {name}
          </ActivityText>
        </View>
        <ActivityStatus theme={theme} label={status} tone={tone} />
        <ActivityButton theme={theme} label={`Close ${name} preview`} onPress={onClose}>
          <Icon name="X" size={11} color={theme.colors.foregroundMuted} />
        </ActivityButton>
      </View>
      {description && <ActivityText theme={theme}>{description}</ActivityText>}
      {preview && (
        <ActivityText theme={theme} tone="muted">
          {preview}
        </ActivityText>
      )}
      {children}
    </View>
  );
}

export function ActivityAgentCard({
  theme,
  agent,
  selected = false,
  onOpenConversation,
}: {
  theme: Theme;
  agent: AgentActivity;
  selected?: boolean;
  onOpenConversation?: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(selected);
  const [moreTools, setMoreTools] = useState(false);
  const [moreSkills, setMoreSkills] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const { running, recent } = orderTools(agent.tools ?? []);
  const tools = [...running, ...recent];
  const skills = orderSkills(agent.skills ?? []);
  const tool =
    preview?.kind === 'tool' &&
    tools
      .slice(0, moreTools ? undefined : running.length + RECENT_LIMIT)
      .find((item) => item.id === preview.id);
  const skill =
    preview?.kind === 'skill' &&
    skills.slice(0, moreSkills ? undefined : RECENT_LIMIT).find((item) => item.id === preview.id);

  useEffect(() => {
    if (preview && !tool && !skill) setPreview(null);
  }, [preview, tool, skill]);

  const choose = (next: Preview) =>
    setPreview((current) => (current?.kind === next.kind && current.id === next.id ? null : next));
  const worktree = agent.worktree?.name ?? 'Worktree unavailable';
  const toolCount = agent.tools
    ? [`${running.length} running`, `${recent.length} recent`]
    : ['Tools unavailable'];
  const skillCount = agent.skills
    ? `${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}`
    : 'Skills unavailable';

  return (
    <ActivityCard
      theme={theme}
      title={agent.name}
      icon={selected ? 'Bot' : 'BotMessageSquare'}
      status={statusLabel(agent.status)}
      statusTone={agentTones[agent.status]}
      context={agent.context}
      contextLabel="Agent context"
      selected={selected}
      open={open}
      onToggle={() => {
        if (open) setPreview(null);
        setOpen(!open);
      }}
      onOpenConversation={
        !selected && agent.canOpenConversation && onOpenConversation
          ? () => onOpenConversation(agent.id)
          : undefined
      }
      summaryLabel={[worktree, ...toolCount, skillCount].join(', ')}
      summary={
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon name="GitBranch" size={10} color={theme.colors.foregroundMuted} />
            <ActivityText theme={theme} tone="muted" size={10} lines={1}>
              {worktree}
            </ActivityText>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 5 }}>
            {toolCount.map((label, index) => (
              <ActivityText
                key={label}
                theme={theme}
                tone={agent.tools ? (index === 0 ? 'running' : 'recent') : 'muted'}
                size={10}
              >
                {label}
              </ActivityText>
            ))}
            <ActivityText theme={theme} tone="muted" size={10}>
              {skillCount}
            </ActivityText>
          </View>
        </>
      }
    >
      {agent.task && (
        <ActivityText theme={theme} tone="muted">
          {agent.task}
        </ActivityText>
      )}
      <ActivityChips
        theme={theme}
        label="Tools"
        items={agent.tools === null ? null : tools}
        recentOffset={running.length}
        expanded={moreTools}
        onToggle={() => setMoreTools(!moreTools)}
        empty="No observed calls"
        renderItem={(item) => {
          const tone = item.status === 'running' ? 'running' : 'recent';
          return (
            <ActivityButton
              key={item.id}
              theme={theme}
              label={`${item.name}, ${statusLabel(item.status)}`}
              selected={tool === item}
              onPress={() => choose({ kind: 'tool', id: item.id })}
            >
              <Icon
                name={toolIcons[item.status]}
                size={10}
                color={activityColor(theme, toolTones[item.status])}
              />
              <ActivityText theme={theme} tone={tone}>
                {item.name}
              </ActivityText>
            </ActivityButton>
          );
        }}
      />
      <ActivityChips
        theme={theme}
        label="Skills"
        items={agent.skills === null ? null : skills}
        expanded={moreSkills}
        onToggle={() => setMoreSkills(!moreSkills)}
        empty="No observed skill loads"
        renderItem={(item) => (
          <ActivityButton
            key={item.id}
            theme={theme}
            label={`${item.name}, observed skill load`}
            selected={skill === item}
            onPress={() => choose({ kind: 'skill', id: item.id })}
          >
            <Icon name="BookOpen" size={10} color={theme.colors.foregroundMuted} />
            <ActivityText theme={theme}>{item.name}</ActivityText>
          </ActivityButton>
        )}
      />
      {tool && (
        <ItemPreview
          theme={theme}
          name={tool.name}
          description={tool.description}
          preview={tool.preview}
          status={statusLabel(tool.status)}
          tone={toolTones[tool.status]}
          onClose={() => setPreview(null)}
        >
          {tool.durationMs !== undefined && (
            <ActivityText theme={theme} tone="muted">
              {tool.durationMs.toLocaleString()} ms
            </ActivityText>
          )}
        </ItemPreview>
      )}
      {skill && (
        <ItemPreview
          theme={theme}
          name={skill.name}
          description={skill.description}
          preview={skill.preview}
          status="Loaded"
          tone="success"
          onClose={() => setPreview(null)}
        >
          <ActivityText theme={theme} tone="muted">
            Observed {new Date(skill.loadedAt).toLocaleString()}
          </ActivityText>
        </ItemPreview>
      )}
      <View
        style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 6, gap: 5 }}
      >
        <ActivityField theme={theme} label="Context window">
          {contextDescription(agent.context)}
        </ActivityField>
        {agent.context && (
          <ActivityField theme={theme} label="Observed">
            {contextObservation(agent.context)}
          </ActivityField>
        )}
        <ActivityField theme={theme} label="Worktree path">
          {agent.worktree?.path ?? 'Unavailable'}
        </ActivityField>
      </View>
    </ActivityCard>
  );
}
