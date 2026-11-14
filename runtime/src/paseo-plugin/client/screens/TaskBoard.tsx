import { ScrollView, View } from 'react-native';
import type { TeamStatusSnapshot } from '../../shared/panel-snapshot';
import type { TeamDetailResponse } from '../../shared/panel-details';
import { taskGroups, progress } from '../../shared/view-model';
import { Action, Card, Label, type Theme } from '../components/PanelChrome';
import { StatusBadge } from '../components/StatusBadge';
export function TaskBoard({
  theme,
  snapshot,
  compact,
  selectedTask,
  onTask,
  detail,
}: {
  theme: Theme;
  snapshot: TeamStatusSnapshot;
  compact: boolean;
  selectedTask: string | null;
  onTask: (id: string | null) => void;
  detail: TeamDetailResponse | undefined;
}) {
  const task = snapshot.tasks.find((item) => item.taskId === selectedTask);
  const groups = taskGroups(snapshot).filter(
    (group) => group.status !== 'Other' || group.tasks.length,
  );
  return (
    <View style={{ gap: 16 }}>
      <Label theme={theme} heading>
        Task Board
      </Label>
      {!snapshot.tasks.length && (
        <Label theme={theme} muted>
          No tasks recorded
        </Label>
      )}
      <ScrollView
        horizontal={!compact}
        contentContainerStyle={{ flexDirection: compact ? 'column' : 'row', gap: 12 }}
      >
        {groups.map((group) => (
          <View key={group.status} style={{ gap: 12, width: compact ? '100%' : 240 }}>
            <Label theme={theme} heading>
              {group.status} ({group.tasks.length})
            </Label>
            {group.tasks.map((item) => {
              const steps = progress(item.steps);
              const assigned = snapshot.assignments.filter((value) => value.taskId === item.taskId);
              return (
                <Card key={item.taskId} theme={theme}>
                  <Action
                    theme={theme}
                    title={item.title}
                    selected={selectedTask === item.taskId}
                    onPress={() => onTask(item.taskId)}
                  />
                  <StatusBadge theme={theme} status={item.status} />
                  <Label theme={theme} muted>
                    {item.passTitle ?? 'No Pass'}
                  </Label>
                  <Label theme={theme}>
                    {steps.completed}/{steps.total} Steps completed
                  </Label>
                  {assigned.length ? (
                    assigned.map((value) => (
                      <Label key={value.assignmentId} theme={theme}>
                        {value.memberName} · {value.status}
                      </Label>
                    ))
                  ) : (
                    <Label theme={theme} muted>
                      Unassigned
                    </Label>
                  )}
                </Card>
              );
            })}
          </View>
        ))}
      </ScrollView>
      {selectedTask && (
        <Card theme={theme}>
          <Action theme={theme} title="Close task details" onPress={() => onTask(null)} />
          {task ? (
            <>
              <Label theme={theme} heading>
                {task.title}
              </Label>
              <Label theme={theme} muted>
                No dependency data recorded
              </Label>
              {task.steps.map((step, index) => (
                <Label theme={theme} key={step.stepId}>
                  {index + 1}. {step.title} · {step.status}
                </Label>
              ))}
              {!task.steps.length && (
                <Label theme={theme} muted>
                  No Steps recorded
                </Label>
              )}
              {detail?.kind === 'task' && detail.taskId === task.taskId && (
                <>
                  <Label theme={theme}>
                    Description: {detail.description || 'No description recorded'}
                  </Label>
                  <Label theme={theme}>
                    Acceptance: {detail.acceptance || 'No acceptance recorded'}
                  </Label>
                  <Label theme={theme}>Phase: {detail.phase ?? 'Not specified'}</Label>
                  <Label theme={theme}>Blocker: {detail.blocker ?? 'None recorded'}</Label>
                  <Label theme={theme}>Report: {detail.report ?? 'None recorded'}</Label>
                </>
              )}
            </>
          ) : (
            <Label theme={theme}>Task is no longer available</Label>
          )}
        </Card>
      )}
    </View>
  );
}
