import { View } from 'react-native';
import { Modal, TextInput } from '@getpaseo/plugin/client/ui';
import { z } from 'zod';
import type { TrackerModification, TrackerSnapshot } from '../../shared/tracker';
import { presentTracker } from '../tracker-presentation';
import type { Theme } from './PanelChrome';
import { TrackerButton, TrackerNotice, TrackerText } from './TrackerControls';

export const trackerDraftSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add'), name: z.string(), instructions: z.string() }),
  z.object({ type: z.literal('edit'), id: z.string(), name: z.string(), instructions: z.string() }),
  z.object({
    type: z.literal('item'),
    trackerId: z.string(),
    itemId: z.string(),
    text: z.string(),
  }),
]);
export type TrackerDraft = z.infer<typeof trackerDraftSchema>;
export type TrackerConfirmation = {
  title: string;
  detail: string;
  label: string;
  change: TrackerModification;
};
type Modify = (change: TrackerModification, dismissDraft?: boolean) => Promise<void>;
const row = { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 } as const;

export function TrackerEditorDialog({
  theme,
  draft,
  trackers,
  open,
  saving,
  stale,
  onOpenChange,
  onDraftChange,
  onModify,
  onConfirm,
}: {
  theme: Theme;
  draft: TrackerDraft | null;
  trackers: TrackerSnapshot['trackers'];
  open: boolean;
  saving: boolean;
  stale: boolean;
  onOpenChange: (open: boolean) => void;
  onDraftChange: (draft: TrackerDraft | null) => void;
  onModify: Modify;
  onConfirm: (confirmation: TrackerConfirmation) => void;
}) {
  const disabled = saving || stale;
  const draftTracker =
    draft && draft.type !== 'add'
      ? trackers.find(({ id }) => id === (draft.type === 'item' ? draft.trackerId : draft.id))
      : undefined;
  const missingDraftTarget = Boolean(
    draft &&
    draft.type !== 'add' &&
    (!draftTracker ||
      (draft.type === 'item' && !draftTracker.items.some(({ id }) => id === draft.itemId))),
  );
  const validDraft =
    draft &&
    (draft.type === 'item' ? draft.text.trim() : draft.name.trim() && draft.instructions.trim());
  const inputStyle = {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 7,
    padding: 12,
    fontSize: 14,
  };
  return (
    <Modal
      title={
        draft?.type === 'item'
          ? 'Edit item'
          : draft?.type === 'edit'
            ? 'Edit Tracker'
            : 'Add Tracker'
      }
      open={Boolean(draft && open)}
      onOpenChange={(open) => {
        if (!saving) onOpenChange(open);
      }}
    >
      <Modal.Content>
        {draft && (
          <>
            {missingDraftTarget && (
              <TrackerNotice theme={theme} warning>
                <TrackerText theme={theme}>
                  This {draft.type === 'item' ? 'item' : 'Tracker'} is no longer available. Your
                  draft is kept here so you can copy it.
                </TrackerText>
              </TrackerNotice>
            )}
            {draft.type === 'item' ? (
              <>
                <TrackerText theme={theme} strong>
                  Item text
                </TrackerText>
                <TextInput
                  editable={!saving}
                  accessibilityLabel="Tracked Item text"
                  multiline
                  maxLength={12000}
                  value={draft.text}
                  onChangeText={(text) => onDraftChange({ ...draft, text })}
                  style={{ ...inputStyle, minHeight: 180, textAlignVertical: 'top' }}
                />
                <TrackerText theme={theme} muted size={12}>
                  Your saved edit is marked as manually maintained.
                </TrackerText>
              </>
            ) : (
              <>
                <TrackerText theme={theme} strong>
                  Name
                </TrackerText>
                <TextInput
                  editable={!saving}
                  accessibilityLabel="Tracker name"
                  placeholder="e.g. Open questions"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  maxLength={80}
                  value={draft.name}
                  onChangeText={(name) => onDraftChange({ ...draft, name })}
                  style={inputStyle}
                />
                <TrackerText theme={theme} strong>
                  What should this Tracker record?
                </TrackerText>
                <TextInput
                  editable={!saving}
                  accessibilityLabel="What should this Tracker record?"
                  placeholder="Track open architecture questions and retire them when I resolve them."
                  placeholderTextColor={theme.colors.foregroundMuted}
                  multiline
                  maxLength={8000}
                  value={draft.instructions}
                  onChangeText={(instructions) => onDraftChange({ ...draft, instructions })}
                  style={{ ...inputStyle, minHeight: 150, textAlignVertical: 'top' }}
                />
                <TrackerText theme={theme} muted size={12}>
                  Use plain-language instructions. They guide what this Tracker adds, updates, and
                  retires.
                </TrackerText>
              </>
            )}
            {stale && (
              <TrackerText theme={theme} muted>
                Reconnect to save. Your draft is preserved.
              </TrackerText>
            )}
            <View style={{ ...row, justifyContent: 'flex-end' }}>
              <TrackerButton
                theme={theme}
                label="Discard draft"
                quiet
                disabled={saving}
                onPress={() => onDraftChange(null)}
              />
              <TrackerButton
                theme={theme}
                label={saving ? 'Saving…' : 'Save'}
                primary
                disabled={disabled || !validDraft || missingDraftTarget}
                onPress={() => void onModify(draft, true)}
              />
            </View>
            {draft.type === 'edit' && draftTracker && (
              <View
                style={{
                  borderTopWidth: 1,
                  borderTopColor: theme.colors.border,
                  paddingTop: 16,
                  gap: 12,
                }}
              >
                <TrackerText theme={theme} muted size={12}>
                  Disabling this Tracker stops its extraction. Its existing items remain available.
                </TrackerText>
                <View style={{ ...row, justifyContent: 'space-between' }}>
                  <TrackerButton
                    theme={theme}
                    label={draftTracker.enabled ? 'Disable Tracker' : 'Enable Tracker'}
                    icon={draftTracker.enabled ? 'Pause' : 'Play'}
                    disabled={disabled}
                    onPress={() =>
                      void onModify({
                        type: 'enable',
                        id: draftTracker.id,
                        enabled: !draftTracker.enabled,
                      })
                    }
                  />
                  <TrackerButton
                    theme={theme}
                    label="Remove Tracker"
                    icon="Trash2"
                    danger
                    quiet
                    disabled={disabled}
                    onPress={() => {
                      onOpenChange(false);
                      onConfirm({
                        title: 'Remove Tracker?',
                        detail: `Remove “${draftTracker.name}” and its tracked items from this conversation.`,
                        label: 'Remove Tracker',
                        change: { type: 'remove', id: draftTracker.id },
                      });
                    }}
                  />
                </View>
              </View>
            )}
          </>
        )}
      </Modal.Content>
    </Modal>
  );
}

export function TrackerServiceDialog({
  theme,
  snapshot,
  open,
  disabled,
  onOpenChange,
  onModify,
}: {
  theme: Theme;
  snapshot: TrackerSnapshot;
  open: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onModify: Modify;
}) {
  const view = presentTracker(snapshot);
  return (
    <Modal title="Tracker service" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <TrackerText theme={theme} heading strong size={18}>
          {view.stateLabel}
        </TrackerText>
        <TrackerText theme={theme}>
          {snapshot.mode === 'hosted'
            ? 'Hosted inference uses OpenAI through Codex. New message text, relevant earlier text, and existing item text can be sent for extraction.'
            : 'Tracker uses local inference.'}
        </TrackerText>
        <TrackerText theme={theme} muted>
          {view.coverageLabel}. {view.startLabel}
        </TrackerText>
        <TrackerNotice theme={theme}>
          <TrackerText theme={theme} size={12}>
            Pausing applies to every conversation on this host. Messages received while paused are
            skipped and remain visible in Coverage.
          </TrackerText>
        </TrackerNotice>
        <View style={row}>
          <TrackerButton
            theme={theme}
            label={snapshot.paused ? 'Resume Tracker everywhere' : 'Pause Tracker everywhere'}
            icon={snapshot.paused ? 'Play' : 'Pause'}
            disabled={disabled}
            onPress={() => void onModify({ type: 'pause', paused: !snapshot.paused })}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

export function TrackerConfirmationDialog({
  theme,
  confirmation,
  saving,
  disabled,
  onCancel,
  onConfirm,
}: {
  theme: Theme;
  confirmation?: TrackerConfirmation;
  saving: boolean;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title={confirmation?.title ?? 'Confirm'}
      open={Boolean(confirmation)}
      onOpenChange={(open) => {
        if (!open && !saving) onCancel();
      }}
    >
      <Modal.Content>
        <TrackerText theme={theme}>{confirmation?.detail}</TrackerText>
        <View style={{ ...row, justifyContent: 'flex-end' }}>
          <TrackerButton
            theme={theme}
            label="Cancel"
            quiet
            disabled={saving}
            onPress={() => onCancel()}
          />
          <TrackerButton
            theme={theme}
            label={confirmation?.label ?? 'Confirm'}
            danger
            disabled={disabled}
            onPress={onConfirm}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
