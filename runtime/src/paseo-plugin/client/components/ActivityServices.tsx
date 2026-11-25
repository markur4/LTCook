import { useEffect, useRef, useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { Icon, Modal } from '@getpaseo/plugin/client/ui';
import {
  activityToggleRpc,
  memoryDeviceRpc,
  memoryInferenceRpc,
  type ActivitySnapshot,
  type MemoryUnitCounts,
} from '../../shared/activity';
import { useStoredSummaries } from '../use-stored-summaries';
import {
  ActivityButton,
  ActivityCard,
  ActivityField,
  ActivityText,
  activityColor,
  statusLabel,
} from './ActivityCard';
import { Action, type Theme } from './PanelChrome';

const ragAvailabilityTones = {
  ready: 'success',
  'not-ready': 'warning',
  unavailable: 'danger',
  unknown: 'muted',
} as const;

const ragActivityTones = {
  idle: 'muted',
  checking: 'running',
  indexing: 'running',
  updating: 'running',
  interrupted: 'warning',
  error: 'danger',
  unknown: 'muted',
} as const;

const memoryTones = {
  summarizing: 'running',
  queued: 'warning',
  'up-to-date': 'success',
  'below-threshold': 'muted',
  failed: 'danger',
  disabled: 'muted',
  paused: 'muted',
  unknown: 'muted',
} as const;

function memoryCounts({ uamp, aab }: MemoryUnitCounts) {
  return `${uamp.toLocaleString()} user–agent ${uamp === 1 ? 'pair' : 'pairs'} · ${aab.toLocaleString()} action ${aab === 1 ? 'batch' : 'batches'}`;
}

function ActivitySwitch({
  theme,
  feature,
  label,
  enabled,
}: {
  theme: Theme;
  feature: 'summarizer' | 'rag-index';
  label: string;
  enabled: boolean | null;
}) {
  const toggle = useRpc(activityToggleRpc);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setPending(true);
    setError(null);
    try {
      await toggle({ feature, enabled: next });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this setting.');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <ActivityText theme={theme} strong>
          {label}
        </ActivityText>
        <Switch
          accessibilityLabel={label}
          accessibilityHint="Applies to the LTCook runtime for this Paseo host."
          value={enabled === true}
          disabled={pending || enabled === null}
          onValueChange={(value) => void change(value)}
        />
      </View>
      {error && (
        <ActivityText theme={theme} tone="danger">
          {error}
        </ActivityText>
      )}
    </>
  );
}

type MemoryInference = NonNullable<ActivitySnapshot['memory']['inference']>;
type MemoryDevice = NonNullable<ActivitySnapshot['memory']['device']>;

const memoryInferenceLabels = {
  hosted: 'Hosted',
  local: 'Local',
} as const;
const hostedDisclosure = 'Hosted sends current prompts and included attachment text to OpenAI.';

function MemoryInferencePicker({ theme, inference }: { theme: Theme; inference: MemoryInference }) {
  const select = useRpc(memoryInferenceRpc);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const label = memoryInferenceLabels[inference.mode];

  async function change(mode: MemoryInference['mode']) {
    if (saving.current) return;
    if (mode === inference.mode) {
      setOpen(false);
      return;
    }
    saving.current = true;
    setPending(true);
    setError(null);
    try {
      await select({ mode });
      // > The Activity subscription refreshes mode, device and model together.
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change inference mode.');
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <ActivityButton
        theme={theme}
        label={`Inference mode: ${label}`}
        expanded={open}
        onPress={() => setOpen(true)}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <ActivityText theme={theme}>Inference mode · {label}</ActivityText>
        </View>
        <Icon name="ChevronDown" size={11} color={theme.colors.foregroundMuted} />
      </ActivityButton>
      <Modal
        title="Inference mode"
        open={open}
        onOpenChange={(next) => {
          if (!saving.current) setOpen(next);
        }}
      >
        <Modal.Content contentContainerStyle={{ padding: 12, gap: 6 }}>
          <ActivityText theme={theme}>{hostedDisclosure}</ActivityText>
          {pending && (
            <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>
              Saving inference mode…
            </Text>
          )}
          {error && (
            <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>
              {error}
            </Text>
          )}
          {(['hosted', 'local'] as const).map((mode) => (
            <Action
              key={mode}
              theme={theme}
              title={memoryInferenceLabels[mode]}
              selected={mode === inference.mode}
              disabled={pending}
              onPress={() => void change(mode)}
            />
          ))}
        </Modal.Content>
      </Modal>
    </>
  );
}

function MemoryDevicePicker({
  theme,
  device,
  onDeviceChange,
}: {
  theme: Theme;
  device: MemoryDevice;
  onDeviceChange: (device: MemoryDevice) => void;
}) {
  const callDevice = useRpc(memoryDeviceRpc);
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof callDevice>>>();
  const [pending, setPending] = useState<'loading' | 'saving' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<symbol | null>(null);

  useEffect(
    () => () => {
      request.current = null;
    },
    [],
  );

  async function updateCatalog(deviceId?: string) {
    if (request.current) return;
    const operation = Symbol();
    request.current = operation;
    setPending(deviceId === undefined ? 'loading' : 'saving');
    setError(null);
    try {
      const next = await callDevice(deviceId === undefined ? {} : { deviceId });
      if (request.current !== operation) return;
      setCatalog(next);
      if (deviceId !== undefined) {
        onDeviceChange(next.device);
        setOpen(false);
      }
    } catch (cause) {
      if (request.current !== operation) return;
      if (deviceId === undefined) setCatalog(undefined);
      setError(
        cause instanceof Error
          ? cause.message
          : deviceId === undefined
            ? 'Could not load inference devices.'
            : 'Could not change inference device.',
      );
    } finally {
      if (request.current === operation) {
        request.current = null;
        setPending(null);
      }
    }
  }

  const errorNotice = error && (
    <ActivityText theme={theme} tone="danger">
      {error}
    </ActivityText>
  );

  return (
    <>
      <View
        testID="ltcook-memory-device-row"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
      >
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <ActivityText theme={theme} tone="muted" lines={1}>
            Inference device
          </ActivityText>
        </View>
        <View style={{ flexGrow: 1, flexShrink: 0, flexBasis: '56%', minWidth: 0 }}>
          <ActivityButton
            theme={theme}
            label={`Inference device: ${device.label}`}
            expanded={open}
            compact
            onPress={() => {
              setOpen(true);
              void updateCatalog();
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <ActivityText theme={theme} lines={1}>
                {device.label}
              </ActivityText>
            </View>
            <Icon name="ChevronDown" size={11} color={theme.colors.foregroundMuted} />
          </ActivityButton>
        </View>
      </View>
      {!open && errorNotice}
      <Modal title="Inference device" open={open} onOpenChange={setOpen}>
        <Modal.Content contentContainerStyle={{ padding: 12, gap: 6 }}>
          {pending && (
            <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>
              {pending === 'loading' ? 'Checking Ollama devices…' : 'Saving inference device…'}
            </Text>
          )}
          {errorNotice}
          {catalog?.diagnostic && (
            <ActivityText theme={theme} tone="warning">
              {catalog.diagnostic}
            </ActivityText>
          )}
          {catalog && !catalog.devices.some(({ id }) => id === device.id) && (
            <ActivityText theme={theme} tone="warning">
              {device.label} is unavailable.
            </ActivityText>
          )}
          {catalog?.devices.map((option) => (
            <View key={option.id} style={{ gap: 3 }}>
              <Action
                theme={theme}
                title={option.label}
                selected={option.id === device.id}
                disabled={pending !== null || option.unavailable !== undefined}
                onPress={() => {
                  if (option.id === device.id) setOpen(false);
                  else void updateCatalog(option.id);
                }}
              />
              {option.unavailable && (
                <ActivityText theme={theme} tone="muted">
                  {option.unavailable}
                </ActivityText>
              )}
            </View>
          ))}
        </Modal.Content>
      </Modal>
    </>
  );
}

function StoredSummaryMetadata({
  theme,
  agentId,
  onOpenSummaries,
}: {
  theme: Theme;
  agentId: string;
  onOpenSummaries: () => void;
}) {
  const { page, error, loading, loadOlder, reload } = useStoredSummaries(agentId, false);
  return (
    <>
      <ActivityButton theme={theme} label="Open stored summaries" onPress={onOpenSummaries}>
        <Icon name="ArrowUpRight" size={11} color={theme.colors.accent} />
        <ActivityText theme={theme}>Open stored summaries</ActivityText>
      </ActivityButton>
      {page?.summaries.map((summary) => {
        const date = new Date(summary.createdAt);
        const duration =
          summary.durationMs === null
            ? 'Duration unknown'
            : summary.durationMs < 1_000
              ? `Duration ${summary.durationMs.toLocaleString()} ms`
              : `Duration ${(summary.durationMs / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
        return (
          <View
            key={summary.id}
            style={{
              borderTopColor: theme.colors.border,
              borderTopWidth: 1,
              paddingVertical: 4,
              gap: 3,
            }}
          >
            <ActivityText theme={theme} strong>
              {summary.type} ·{' '}
              {Number.isNaN(date.valueOf()) ? 'Time unknown' : date.toLocaleString()}
            </ActivityText>
            <ActivityText theme={theme} tone="muted" size={10}>
              Est. tokens · Original {summary.originalTokens?.toLocaleString() ?? 'unknown'} ·
              Summary {summary.summaryTokens?.toLocaleString() ?? 'unknown'}
            </ActivityText>
            <ActivityText theme={theme} tone="muted" size={10}>
              {duration} · Source #{summary.position}
            </ActivityText>
          </View>
        );
      })}
      {loading && (
        <ActivityText theme={theme} tone="muted">
          Loading stored summaries…
        </ActivityText>
      )}
      {error && (
        <ActivityText theme={theme} tone="danger">
          {error}
        </ActivityText>
      )}
      {!loading && !error && page?.summaries.length === 0 && (
        <ActivityText theme={theme} tone="muted">
          No completed summaries for this agent.
        </ActivityText>
      )}
      {!loading && !error && page?.next && (
        <ActivityButton theme={theme} label="Load older summaries" onPress={loadOlder}>
          <ActivityText theme={theme}>Load older summaries</ActivityText>
        </ActivityButton>
      )}
      {!loading && (
        <ActivityButton theme={theme} label="Reload stored summaries" onPress={reload}>
          <ActivityText theme={theme}>Reload stored summaries</ActivityText>
        </ActivityButton>
      )}
    </>
  );
}

export function ActivityServices({
  theme,
  agentId,
  rag,
  memory,
  onDeviceChange,
  onOpenSummaries,
  agentWorktree,
}: Pick<ActivitySnapshot, 'rag' | 'memory'> & {
  theme: Theme;
  agentId: string;
  onDeviceChange: (device: MemoryDevice) => void;
  onOpenSummaries: () => void;
  agentWorktree?: string;
}) {
  const [ragOpen, setRagOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [storedOpen, setStoredOpen] = useState(false);
  const ragActivity =
    rag.indexingEnabled === false ? 'Index updates off' : statusLabel(rag.activity);
  const ragAvailability = statusLabel(rag.availability);
  const summarization = statusLabel(memory.summarization);
  const { inference, hostedUsage } = memory;
  const inferenceSummary = inference
    ? `${memoryInferenceLabels[inference.mode]} · ${inference.model} · Reasoning ${inference.reasoning}`
    : null;
  const summarizerAvailable =
    memory.summarization !== 'disabled' && (memory.summarization !== 'unknown' || !!inference);
  const rate = memory.summarization === 'summarizing' ? memory.rate : null;
  const rateLabel = rate
    ? `${rate.tokensPerSecond.toLocaleString(undefined, { maximumFractionDigits: 1 })} tokens/s${rate.estimated ? ' (estimated)' : ''}`
    : null;
  const storedCounts = memory.stored ? memoryCounts(memory.stored) : 'Counts unavailable';
  const stored = memory.stored ? memory.stored.uamp + memory.stored.aab : null;
  const memorySummary = [
    stored === null
      ? 'Background summaries'
      : `${stored.toLocaleString()} ${stored === 1 ? 'summary' : 'summaries'} stored`,
    ...(memory.lastHandoff ? ['Handoff received'] : []),
  ].join(' · ');

  return (
    <>
      <ActivityCard
        theme={theme}
        title="RAG Index"
        icon="Database"
        status={ragAvailability}
        statusTone={ragAvailabilityTones[rag.availability]}
        open={ragOpen}
        onToggle={() => setRagOpen(!ragOpen)}
        summaryLabel={`${rag.provider}, ${ragActivity}`}
        summary={
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
            {rag.provider} ·{' '}
            <Text style={{ color: activityColor(theme, ragActivityTones[rag.activity]) }}>
              {ragActivity}
            </Text>
          </Text>
        }
      >
        <ActivitySwitch
          theme={theme}
          feature="rag-index"
          label="Index updates"
          enabled={rag.indexingEnabled}
        />
        <ActivityField theme={theme} label="Index worktree">
          {rag.worktree?.path ?? 'Unavailable'}
        </ActivityField>
        {rag.worktree && agentWorktree && agentWorktree !== rag.worktree.path && (
          <ActivityField theme={theme} label="Agent worktree">
            {agentWorktree}
          </ActivityField>
        )}
        <ActivityField theme={theme} label="Availability">
          {ragAvailability}
        </ActivityField>
        <ActivityField theme={theme} label="Activity">
          {ragActivity}
        </ActivityField>
        {rag.diagnostic && (
          <ActivityText theme={theme} tone="muted">
            {rag.diagnostic}
          </ActivityText>
        )}
      </ActivityCard>
      <ActivityCard
        theme={theme}
        title="Session Memory"
        icon="Brain"
        status={summarization}
        statusTone={memoryTones[memory.summarization]}
        open={memoryOpen}
        onToggle={() => {
          if (memoryOpen) setStoredOpen(false);
          setMemoryOpen(!memoryOpen);
        }}
        summaryLabel={[rateLabel, inferenceSummary, memorySummary].filter(Boolean).join(', ')}
        summary={
          <>
            {rateLabel && (
              <ActivityText theme={theme} tone="running" size={12} strong>
                {rateLabel}
              </ActivityText>
            )}
            {!memoryOpen && inferenceSummary && (
              <ActivityText theme={theme} tone="muted" size={10}>
                {inferenceSummary}
              </ActivityText>
            )}
            <ActivityText theme={theme} tone="muted" size={10}>
              {memorySummary}
            </ActivityText>
          </>
        }
      >
        <View style={{ gap: 2 }}>
          <ActivitySwitch
            theme={theme}
            feature="summarizer"
            label="Summarizer"
            enabled={summarizerAvailable ? memory.summarization !== 'paused' : null}
          />
          {inference && summarizerAvailable && (
            <MemoryInferencePicker theme={theme} inference={inference} />
          )}
          {memory.device && inference?.mode !== 'hosted' && (
            <MemoryDevicePicker
              theme={theme}
              device={memory.device}
              onDeviceChange={onDeviceChange}
            />
          )}
        </View>
        {inference && (
          <>
            {inference.mode === 'hosted' && (
              <ActivityText theme={theme} tone="muted">
                {hostedDisclosure}
              </ActivityText>
            )}
            <ActivityField theme={theme} label="Model">
              {inference.model}
            </ActivityField>
            <ActivityField theme={theme} label="Reasoning">
              {inference.reasoning}
            </ActivityField>
          </>
        )}
        {hostedUsage && (
          <>
            <ActivityText theme={theme} strong>
              Hosted usage since runtime start
            </ActivityText>
            <ActivityField theme={theme} label="Requests">
              {hostedUsage.requests.toLocaleString()}
            </ActivityField>
            <ActivityField theme={theme} label="Input tokens">
              {`${hostedUsage.inputTokens.toLocaleString()} (${hostedUsage.cachedInputTokens.toLocaleString()} cached)`}
            </ActivityField>
            <ActivityField theme={theme} label="Output tokens">
              {`${hostedUsage.outputTokens.toLocaleString()} (${hostedUsage.reasoningTokens.toLocaleString()} reasoning)`}
            </ActivityField>
            {hostedUsage.lastLatencyMs !== undefined && (
              <ActivityField theme={theme} label="Last latency">
                {`${hostedUsage.lastLatencyMs.toLocaleString(undefined, { maximumFractionDigits: 0 })} ms`}
              </ActivityField>
            )}
          </>
        )}
        {memory.summarization !== 'disabled' && (
          <>
            <ActivityButton
              theme={theme}
              label={`Stored for this agent, ${storedCounts}`}
              expanded={storedOpen}
              onPress={() => setStoredOpen(!storedOpen)}
            >
              <Icon
                name={storedOpen ? 'ChevronDown' : 'ChevronRight'}
                size={11}
                color={theme.colors.accent}
              />
              <View style={{ flex: 1, minWidth: 0 }}>
                <ActivityText theme={theme} strong>
                  Stored for this agent
                </ActivityText>
                <ActivityText theme={theme} tone="muted">
                  {storedCounts}
                </ActivityText>
              </View>
            </ActivityButton>
            {storedOpen && (
              <StoredSummaryMetadata
                agentId={agentId}
                theme={theme}
                onOpenSummaries={onOpenSummaries}
              />
            )}
          </>
        )}
        {memory.pending && (
          <ActivityField theme={theme} label="Pending">
            {memoryCounts(memory.pending)}
          </ActivityField>
        )}
        {memory.lastSummaryAt !== null && (
          <ActivityField theme={theme} label="Last successful summary">
            {new Date(memory.lastSummaryAt).toLocaleString()}
          </ActivityField>
        )}
        {memory.diagnostic && (
          <ActivityText theme={theme} tone="muted">
            {memory.diagnostic}
          </ActivityText>
        )}
        <ActivityText theme={theme} strong>
          Last delegation handoff
        </ActivityText>
        {memory.lastHandoff ? (
          <>
            <ActivityField theme={theme} label="Source agent">
              {memory.lastHandoff.sourceName ?? 'Name unavailable'}
            </ActivityField>
            <ActivityField theme={theme} label="Received">
              {new Date(memory.lastHandoff.at).toLocaleString()}
            </ActivityField>
            <ActivityField theme={theme} label="Payload size">
              {`${memory.lastHandoff.bytes.toLocaleString()} bytes`}
            </ActivityField>
            <ActivityField theme={theme} label="Summaries represented">
              {memoryCounts(memory.lastHandoff.summaries)}
            </ActivityField>
          </>
        ) : (
          <ActivityText theme={theme} tone="muted">
            No acknowledged handoff available for this agent.
          </ActivityText>
        )}
      </ActivityCard>
    </>
  );
}
