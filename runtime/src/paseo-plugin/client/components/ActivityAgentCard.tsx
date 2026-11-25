import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { Icon } from '@getpaseo/plugin/client/ui';
import type { ActivityAnchor, AgentActivity, SkillLoad, ToolCall } from '../../shared/activity';
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
  const running = calls
    .filter((call) => call.status === 'running')
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  const recent = calls
    .filter((call) => call.status !== 'running')
    .sort(
      (a, b) =>
        (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt) || a.id.localeCompare(b.id),
    );
  const byName = new Map<string, ToolCall[]>();
  for (const call of [...running, ...recent]) {
    const group = byName.get(call.name);
    if (group) group.push(call);
    else byName.set(call.name, [call]);
  }
  const groups = [...byName].map(([name, calls]) => {
    const runningCount = calls.filter(({ status }) => status === 'running').length;
    const failedCount = calls.filter(({ status }) => status === 'failed').length;
    const status = runningCount ? 'running' : failedCount ? 'failed' : calls[0]!.status;
    const details = [`${calls.length} calls`];
    if (runningCount) details.push(`${runningCount} running`);
    if (failedCount) details.push(`${failedCount} failed`);
    return { name, calls, runningCount, status, details };
  });
  return {
    running: running.length,
    recent: recent.length,
    groups,
    runningGroups: groups.filter(({ runningCount }) => runningCount > 0).length,
  };
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
  actions,
  children,
  onClose,
}: {
  theme: Theme;
  name: string;
  description?: string;
  preview?: string;
  status: string;
  tone: (typeof toolTones)[keyof typeof toolTones];
  actions?: ReactNode;
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
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}>
        <View
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <ActivityText theme={theme} strong>
            {name}
          </ActivityText>
          {actions}
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

function OpenSkillButton({
  theme,
  skill,
  onOpenSkill,
  showName = false,
  disambiguate = false,
}: {
  theme: Theme;
  skill: SkillLoad;
  onOpenSkill: (skill: SkillLoad) => void;
  showName?: boolean;
  disambiguate?: boolean;
}) {
  const label = 'Open skill in new tab';
  return (
    <ActivityButton
      theme={theme}
      label={disambiguate ? `${label} (${skill.name})` : label}
      onPress={() => onOpenSkill(skill)}
      compact
    >
      <Icon name="ArrowUpRight" size={11} color={theme.colors.accent} />
      {showName && <ActivityText theme={theme}>{skill.name}</ActivityText>}
    </ActivityButton>
  );
}

function ShowInChatButton({
  theme,
  target,
  label,
  onShowInChat,
}: {
  theme: Theme;
  target?: ActivityAnchor;
  label: string;
  onShowInChat?: (target: ActivityAnchor) => void;
}) {
  if (!target || !onShowInChat) return null;
  const role = target.kind === 'tool' ? 'tool call' : 'message';
  return (
    <ActivityButton
      theme={theme}
      label={`Show in Chat, ${label}, ${role}`}
      onPress={() => onShowInChat(target)}
      compact
    >
      <ActivityText theme={theme}>Show in Chat</ActivityText>
    </ActivityButton>
  );
}

export function ActivityAgentCard({
  theme,
  agent,
  selected = false,
  onOpenConversation,
  onShowInChat,
  onOpenSkill,
}: {
  theme: Theme;
  agent: AgentActivity;
  selected?: boolean;
  onOpenConversation?: (agentId: string) => void;
  onShowInChat?: (target: ActivityAnchor) => void;
  onOpenSkill?: (skill: SkillLoad) => void;
}) {
  const [open, setOpen] = useState(selected);
  const [moreTools, setMoreTools] = useState(false);
  const [moreSkills, setMoreSkills] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const { running, recent, groups, runningGroups } = orderTools(agent.tools ?? []);
  const skills = orderSkills(agent.skills ?? []);
  const tool =
    preview?.kind === 'tool' &&
    groups
      .slice(0, moreTools ? undefined : runningGroups + RECENT_LIMIT)
      .find((item) => item.name === preview.id);
  const singleCall = tool && tool.calls.length === 1 ? tool.calls[0] : undefined;
  const toolSkillIds = new Set(tool ? tool.calls.map((call) => call.skillId) : []);
  const toolSkills = skills.filter((item) => item.documentAvailable && toolSkillIds.has(item.id));
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
    ? [`${running} running`, `${recent} recent`]
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
        items={agent.tools === null ? null : groups}
        recentOffset={runningGroups}
        expanded={moreTools}
        onToggle={() => setMoreTools(!moreTools)}
        empty="No observed calls"
        renderItem={(item) => {
          const tone = item.status === 'running' ? 'running' : 'recent';
          return (
            <ActivityButton
              key={item.name}
              theme={theme}
              label={`${item.name}, ${item.calls.length === 1 ? statusLabel(item.status) : item.details.join(', ')}`}
              expanded={tool === item}
              selected={tool === item}
              onPress={() => choose({ kind: 'tool', id: item.name })}
            >
              <Icon
                name={toolIcons[item.status]}
                size={10}
                color={activityColor(theme, toolTones[item.status])}
              />
              <ActivityText theme={theme} tone={tone}>
                {item.name}
                {item.calls.length > 1 && ` ×${item.calls.length}`}
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
            expanded={skill === item}
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
          description={singleCall?.description}
          preview={singleCall?.preview}
          status={singleCall ? statusLabel(tool.status) : tool.details[0]!}
          tone={toolTones[tool.status]}
          actions={
            onOpenSkill &&
            toolSkills.map((item) => (
              <OpenSkillButton
                key={item.id}
                theme={theme}
                skill={item}
                onOpenSkill={onOpenSkill}
                showName
                disambiguate={toolSkills.length > 1}
              />
            ))
          }
          onClose={() => setPreview(null)}
        >
          {tool.calls.map((call, index) => {
            const time = new Date(call.startedAt).toLocaleTimeString();
            const status = statusLabel(call.status);
            const occurrence = singleCall
              ? tool.name
              : `${tool.name} ${index + 1} of ${tool.calls.length}`;
            return (
              <View
                key={JSON.stringify([call.id, call.target?.turnId ?? call.target?.position])}
                style={{ gap: 3 }}
              >
                <View
                  style={{ gap: 4, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}
                >
                  <View
                    accessible
                    accessibilityLabel={`${tool.name} call, ${status}, ${time}`}
                    style={{ gap: 3, flexDirection: 'row', alignItems: 'center' }}
                  >
                    {!singleCall && (
                      <ActivityStatus theme={theme} label={status} tone={toolTones[call.status]} />
                    )}
                    <ActivityText theme={theme} tone="muted">
                      {time}
                      {call.durationMs !== undefined && ` · ${call.durationMs.toLocaleString()} ms`}
                    </ActivityText>
                  </View>
                  <ShowInChatButton
                    theme={theme}
                    target={call.target}
                    label={`${occurrence} at ${time}`}
                    onShowInChat={onShowInChat}
                  />
                </View>
                {!singleCall && call.description && (
                  <ActivityText theme={theme}>{call.description}</ActivityText>
                )}
                {!singleCall && call.preview && (
                  <ActivityText theme={theme} tone="muted">
                    {call.preview}
                  </ActivityText>
                )}
              </View>
            );
          })}
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
          actions={
            skill.documentAvailable &&
            onOpenSkill && <OpenSkillButton theme={theme} skill={skill} onOpenSkill={onOpenSkill} />
          }
          onClose={() => setPreview(null)}
        >
          {skill.occurrences.length === 0 && (
            <ActivityText theme={theme} tone="muted">
              Observed {new Date(skill.loadedAt).toLocaleString()}
            </ActivityText>
          )}
          {skill.occurrences.map((target, index) => {
            const time = new Date(target.at).toLocaleString();
            const occurrence =
              skill.occurrences.length === 1
                ? skill.name
                : `${skill.name} ${index + 1} of ${skill.occurrences.length}`;
            return (
              <View
                key={JSON.stringify([target.epoch, target.position, target.kind, target.id])}
                style={{ gap: 4, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}
              >
                <ActivityText theme={theme} tone="muted">
                  Observed {time}
                </ActivityText>
                <ShowInChatButton
                  theme={theme}
                  target={target}
                  label={`${occurrence} at ${time}`}
                  onShowInChat={onShowInChat}
                />
              </View>
            );
          })}
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
