import { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { copyText, Modal, TextInput } from '@getpaseo/plugin/client/ui';
import type { TrackerSnapshot } from '../../shared/tracker';
import { formatTrackerNotes } from '../tracker-presentation';
import type { Theme } from './PanelChrome';
import { TrackerButton, TrackerText } from './TrackerControls';

export function TrackerCopyNotes({
  theme,
  trackers,
}: {
  theme: Theme;
  trackers: TrackerSnapshot['trackers'];
}) {
  const [copying, setCopying] = useState(false);
  const [copiedCount, setCopiedCount] = useState<number | null>(null);
  const [manualText, setManualText] = useState<string | null>(null);
  const mounted = useRef(false);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const count = trackers.reduce((total, tracker) => total + tracker.items.length, 0);
  const fallbackStyle = {
    minHeight: 240,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 7,
    padding: 12,
    fontSize: 14,
    textAlignVertical: 'top' as const,
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(feedbackTimer.current);
    };
  }, []);

  async function copyAll() {
    if (copying || !count) return;
    const text = formatTrackerNotes(trackers);
    setCopying(true);
    setCopiedCount(null);
    clearTimeout(feedbackTimer.current);
    try {
      await copyText(text);
      if (!mounted.current) return;
      setCopiedCount(count);
      feedbackTimer.current = setTimeout(() => setCopiedCount(null), 2500);
    } catch {
      if (mounted.current) setManualText(text);
    } finally {
      if (mounted.current) setCopying(false);
    }
  }

  return (
    <>
      <View accessibilityLiveRegion="polite">
        <TrackerButton
          theme={theme}
          label={
            copiedCount === null
              ? 'Copy all notes'
              : `Copied ${copiedCount} ${copiedCount === 1 ? 'note' : 'notes'}`
          }
          icon={copiedCount === null ? 'Copy' : 'Check'}
          disabled={copying || !count}
          onPress={() => void copyAll()}
        />
      </View>
      <Modal
        title="Copy all notes"
        open={manualText !== null}
        onOpenChange={(open) => {
          if (!open) setManualText(null);
        }}
      >
        <Modal.Content>
          <TrackerText theme={theme}>
            Clipboard access is unavailable. Select and copy the notes below.
          </TrackerText>
          {Platform.OS === 'web' ? (
            <TextInput
              accessibilityLabel="All tracked notes as text"
              value={manualText ?? ''}
              editable={false}
              multiline
              autoFocus
              selectTextOnFocus
              style={fallbackStyle}
            />
          ) : (
            <Text selectable accessibilityLabel="All tracked notes as text" style={fallbackStyle}>
              {manualText}
            </Text>
          )}
          <TrackerButton theme={theme} label="Close" onPress={() => setManualText(null)} />
        </Modal.Content>
      </Modal>
    </>
  );
}
