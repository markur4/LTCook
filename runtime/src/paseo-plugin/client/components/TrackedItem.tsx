import { useState } from 'react';
import { Text, View } from 'react-native';
import { Icon } from '@getpaseo/plugin/client/ui';
import type { TrackerSnapshot } from '../../shared/tracker';
import type { Theme } from './PanelChrome';
import { TrackerButton, TrackerNotice, TrackerText } from './TrackerControls';

type Item = TrackerSnapshot['trackers'][number]['items'][number];
export type TrackerSource = Item['sources'][number];
type Source = TrackerSource;
const row = { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 } as const;

export function SourceLinks({
  theme,
  sources,
  onReveal,
}: {
  theme: Theme;
  sources: Source[];
  onReveal?: (source: Source) => void;
}) {
  return (
    <View style={{ gap: 6 }}>
      {sources.map((source) => {
        const timestamp = source.timestamp ? Date.parse(source.timestamp) : NaN;
        const canReveal = source.messageId && source.author && Number.isSafeInteger(timestamp);
        const author =
          source.author === 'user' ? 'You' : source.author === 'agent' ? 'Agent' : null;
        return (
          <View
            key={`${source.epoch}:${source.seq}`}
            style={{ ...row, justifyContent: 'space-between' }}
          >
            <View style={{ ...row, flex: 1 }}>
              <Icon name="MessageSquare" size={13} color={theme.colors.foregroundMuted} />
              <TrackerText theme={theme} muted size={12}>
                {author ? `${author} · ` : ''}Message #{source.seq}
                {Number.isSafeInteger(timestamp)
                  ? ` · ${new Date(timestamp).toLocaleString()}`
                  : ''}
              </TrackerText>
            </View>
            {canReveal && onReveal ? (
              <TrackerButton
                theme={theme}
                label="Show in chat"
                icon="ArrowUpRight"
                quiet
                onPress={() => onReveal(source)}
              />
            ) : (
              <TrackerText theme={theme} muted size={12}>
                Chat navigation unavailable
              </TrackerText>
            )}
          </View>
        );
      })}
    </View>
  );
}

export function TrackedItem({
  item,
  theme,
  disabled,
  onEdit,
  onRemove,
  onReveal,
}: {
  item: Item;
  theme: Theme;
  disabled: boolean;
  onEdit(): void;
  onRemove(): void;
  onReveal?: (source: Source) => void;
}) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  return (
    <View
      testID={`tracker-item-${item.id}`}
      style={{
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        gap: 5,
      }}
    >
      <Text selectable style={{ color: theme.colors.foreground, fontSize: 15, lineHeight: 22 }}>
        {item.text}
      </Text>
      <View style={{ ...row, justifyContent: 'space-between' }}>
        <View style={row}>
          {item.sources.length > 0 ? (
            <TrackerButton
              theme={theme}
              label={`${item.sources.length} ${item.sources.length === 1 ? 'source' : 'sources'}`}
              icon="Link"
              quiet
              expanded={sourcesOpen}
              onPress={() => setSourcesOpen(!sourcesOpen)}
            />
          ) : (
            <TrackerText theme={theme} muted size={12}>
              No source references
            </TrackerText>
          )}
          {item.manual && (
            <View style={row}>
              <Icon name="PenLine" size={12} color={theme.colors.foregroundMuted} />
              <TrackerText theme={theme} muted size={12}>
                Manually maintained
              </TrackerText>
            </View>
          )}
        </View>
        <View style={row}>
          <TrackerButton
            theme={theme}
            label="Edit"
            icon="Pencil"
            quiet
            disabled={disabled}
            onPress={onEdit}
          />
          <TrackerButton
            theme={theme}
            label="More"
            icon="Ellipsis"
            quiet
            expanded={actionsOpen}
            onPress={() => setActionsOpen(!actionsOpen)}
          />
        </View>
      </View>
      {item.evidenceUnavailable && (
        <TrackerNotice theme={theme} warning>
          <TrackerText theme={theme} size={12}>
            Original evidence was removed. This manual item is preserved.
          </TrackerText>
        </TrackerNotice>
      )}
      {sourcesOpen && (
        <View style={{ padding: 12, borderRadius: 6, backgroundColor: theme.colors.surface1 }}>
          <SourceLinks theme={theme} sources={item.sources} onReveal={onReveal} />
        </View>
      )}
      {actionsOpen && (
        <View style={{ ...row, justifyContent: 'flex-end' }}>
          <TrackerButton
            theme={theme}
            label="Remove item"
            icon="Trash2"
            danger
            disabled={disabled}
            onPress={onRemove}
          />
        </View>
      )}
    </View>
  );
}
