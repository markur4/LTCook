import { useEffect, useState } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import {
  workspaceServicesRpc,
  type WorkspaceServicesStatus,
} from '../../shared/workspace-services';
import { ActivityCard, ActivityField, ActivityText } from './ActivityCard';
import type { Theme } from './PanelChrome';

const refreshInterval = 30_000;

function servicePresentation(
  service: WorkspaceServicesStatus['organizer'] | undefined,
  diagnostic?: string,
) {
  if (!service) return { label: diagnostic ? 'Unavailable' : 'Loading', tone: 'muted' as const };
  if (!service.enabled) return { label: 'Off', tone: 'muted' as const };
  if (diagnostic || service.diagnostic) return { label: 'Attention', tone: 'warning' as const };
  if (service.running) return { label: 'Running', tone: 'running' as const };
  return { label: 'Ready', tone: 'success' as const };
}

function ServiceObservations({
  theme,
  service,
  diagnostic,
}: {
  theme: Theme;
  service?: WorkspaceServicesStatus['organizer'];
  diagnostic?: string;
}) {
  return (
    <>
      <ActivityField theme={theme} label="Last check">
        {service?.lastRunAt == null
          ? 'Not yet checked'
          : new Date(service.lastRunAt).toLocaleString()}
      </ActivityField>
      <ActivityField theme={theme} label="Last change">
        {service?.lastSuccessAt == null
          ? 'No changes yet'
          : new Date(service.lastSuccessAt).toLocaleString()}
      </ActivityField>
      {service && (
        <ActivityField theme={theme} label="Changes">
          {`${service.processed.toLocaleString()} since runtime startup`}
        </ActivityField>
      )}
      {(diagnostic || service?.diagnostic) && (
        <ActivityText theme={theme} tone="warning">
          {diagnostic || service?.diagnostic}
        </ActivityText>
      )}
      <ActivityText theme={theme} tone="muted" size={10}>
        Configure in AppRC. Restart the runtime to apply settings.
      </ActivityText>
    </>
  );
}

/** Host-wide Service status is read only; polling stops when the Activity surface unmounts. */
export function WorkspaceServices({ theme }: { theme: Theme }) {
  const readStatus = useRpc(workspaceServicesRpc);
  const [status, setStatus] = useState<WorkspaceServicesStatus>();
  const [error, setError] = useState<string>();
  const [organizerOpen, setOrganizerOpen] = useState(false);
  const [renamerOpen, setRenamerOpen] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus(undefined);
    setError(undefined);
    const refresh = async () => {
      try {
        const next = await readStatus({});
        if (disposed) return;
        setStatus(next);
        setError(undefined);
      } catch (cause) {
        if (disposed) return;
        setStatus(undefined);
        setError(cause instanceof Error ? cause.message : 'Workspace Services are unavailable.');
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), refreshInterval);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [readStatus]);

  const diagnostic = error ?? status?.diagnostic;
  const organizer = servicePresentation(status?.organizer, diagnostic);
  const renamer = servicePresentation(status?.renamer, diagnostic);
  const blocked = new Map<string, number>();
  for (const item of status?.archiveBlocked ?? []) {
    blocked.set(item.reason, (blocked.get(item.reason) ?? 0) + 1);
  }

  return (
    <>
      <ActivityCard
        theme={theme}
        title="Workspace Organizer"
        icon="Tags"
        status={organizer.label}
        statusTone={organizer.tone}
        open={organizerOpen}
        onToggle={() => setOrganizerOpen(!organizerOpen)}
        summaryLabel="Feature, Bugfix, CSC, Research"
        summary={
          <ActivityText theme={theme} tone="muted" size={10}>
            Feature · Bugfix · CSC · Research
          </ActivityText>
        }
      >
        <ActivityField theme={theme} label="Labels">
          On creation; then every 12 hours when content changes.
        </ActivityField>
        <ActivityField theme={theme} label="Auto-archive">
          {!status
            ? 'Unavailable'
            : status.organizer.enabled && status.autoArchive
              ? 'After 14 inactive days'
              : 'Off'}
        </ActivityField>
        <ActivityField theme={theme} label="Default sort">
          Newest created first
        </ActivityField>
        <ActivityField theme={theme} label="Archive">
          Paseo History → open conversation → Unarchive or Restore
        </ActivityField>
        {blocked.size > 0 && (
          <>
            <ActivityText theme={theme} tone="warning" strong>
              {`${status!.archiveBlocked.length} ${status!.archiveBlocked.length === 1 ? 'workspace kept' : 'workspaces kept'} active`}
            </ActivityText>
            {[...blocked].map(([reason, count]) => (
              <ActivityText key={reason} theme={theme} tone="muted">
                {`${count} · ${reason}`}
              </ActivityText>
            ))}
          </>
        )}
        <ServiceObservations theme={theme} service={status?.organizer} diagnostic={diagnostic} />
      </ActivityCard>
      <ActivityCard
        theme={theme}
        title="Renamer"
        icon="TextCursorInput"
        status={renamer.label}
        statusTone={renamer.tone}
        open={renamerOpen}
        onToggle={() => setRenamerOpen(!renamerOpen)}
        summaryLabel="Every 30 minutes"
        summary={
          <ActivityText theme={theme} tone="muted" size={10}>
            Every 30 minutes
          </ActivityText>
        }
      >
        <ActivityField theme={theme} label="Workspace names">
          {!status
            ? 'Unavailable'
            : status.renamer.enabled && status.renameWorkspaces
              ? 'On · maximum 20 characters'
              : 'Off'}
        </ActivityField>
        <ActivityField theme={theme} label="Agent tab names">
          {!status
            ? 'Unavailable'
            : status.renamer.enabled && status.renameTabs
              ? 'On · maximum 15 characters'
              : 'Off'}
        </ActivityField>
        <ServiceObservations theme={theme} service={status?.renamer} diagnostic={diagnostic} />
      </ActivityCard>
    </>
  );
}
