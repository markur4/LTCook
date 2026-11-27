import { useEffect, useState } from 'react';
import { View } from 'react-native';
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
  if (diagnostic || service.diagnostic) return { label: 'Attention', tone: 'warning' as const };
  if (!service.enabled) return { label: 'Off', tone: 'muted' as const };
  if (service.running) return { label: 'Running', tone: 'running' as const };
  if (service.lastRunAt === null) return { label: 'Ready', tone: 'muted' as const };
  return { label: 'Ready', tone: 'success' as const };
}

const operations = {
  classification: 'Classification',
  rename: 'Renaming',
  labels: 'Label synchronization',
  archive: 'Automatic archive',
  settings: 'Settings',
};

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
      {diagnostic && (
        <ActivityText theme={theme} tone="warning">
          {diagnostic}
        </ActivityText>
      )}
      {service?.diagnostics?.map(({ operation, message, nextCheckAt }) => (
        <ActivityText key={operation} theme={theme} tone="warning">
          {`${operations[operation]} · ${message}`}
          {nextCheckAt !== undefined && ` Next check ${new Date(nextCheckAt).toLocaleString()}.`}
        </ActivityText>
      ))}
      {!service?.diagnostics?.length && service?.diagnostic && (
        <ActivityText theme={theme} tone="warning">
          {service.diagnostic}
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
  const [taggerOpen, setTaggerOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

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
    <ActivityCard
      theme={theme}
      title="Workspace Organizer"
      icon="Tags"
      summary={null}
      summaryLabel="Labels, titles, and archival"
      status={status ? 'Ready' : error ? 'Unavailable' : 'Loading'}
      open={organizerOpen}
      onToggle={() => setOrganizerOpen((open) => !open)}
    >
      <View style={{ gap: 5 }}>
        <ActivityCard
          theme={theme}
          title="Tagger"
          icon="Tag"
          summary={null}
          summaryLabel="Workspace labels"
          status={organizer.label}
          statusTone={organizer.tone}
          open={taggerOpen}
          onToggle={() => setTaggerOpen((open) => !open)}
        >
          <ActivityField theme={theme} label="Labels">
            Feature, Bugfix, CSC, Research
          </ActivityField>
          <ActivityField theme={theme} label="Checks">
            On creation, then every 12 hours when content changes.
          </ActivityField>
          <ServiceObservations theme={theme} service={status?.organizer} diagnostic={diagnostic} />
        </ActivityCard>
        <ActivityCard
          theme={theme}
          title="Renamer"
          icon="TextCursorInput"
          summary={null}
          summaryLabel="First prompt"
          status={renamer.label}
          statusTone={renamer.tone}
          open={renamerOpen}
          onToggle={() => setRenamerOpen((open) => !open)}
        >
          <ActivityField theme={theme} label="Timing">
            On the first prompt
          </ActivityField>
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
        <ActivityCard
          theme={theme}
          title="Auto-archive"
          icon="Archive"
          summary={null}
          summaryLabel="Inactive workspaces"
          status={
            !status ? 'Unavailable' : status.organizer.enabled && status.autoArchive ? 'On' : 'Off'
          }
          open={archiveOpen}
          onToggle={() => setArchiveOpen((open) => !open)}
        >
          <ActivityField theme={theme} label="Archive">
            {!status
              ? 'Unavailable'
              : status.organizer.enabled && status.autoArchive
                ? 'After 14 inactive days'
                : 'Off'}
          </ActivityField>
          <ActivityField theme={theme} label="Recovery">
            Paseo History → open conversation → Unarchive or Restore
          </ActivityField>
          {[...blocked].map(([reason, count]) => (
            <ActivityText key={reason} theme={theme} tone="warning">
              {`${count} · ${reason}`}
            </ActivityText>
          ))}
        </ActivityCard>
      </View>
    </ActivityCard>
  );
}
