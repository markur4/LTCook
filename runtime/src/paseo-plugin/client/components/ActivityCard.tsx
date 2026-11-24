import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '@getpaseo/plugin/client/ui';
import type { ContextUsage } from '../../shared/activity';

import type { Theme } from './PanelChrome';

type Tone = 'running' | 'recent' | 'success' | 'warning' | 'danger' | 'muted';

const statusLabels: Record<string, string> = {
  checking: 'Checking index',
  'not-ready': 'Not ready',
  'up-to-date': 'Up to date',
  'below-threshold': 'Waiting for threshold',
};

export function statusLabel(status: string) {
  return statusLabels[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

export function activityColor(theme: Theme, tone?: Tone) {
  const colors = theme.colors;
  switch (tone) {
    case 'running':
      return colors.accent;
    case 'recent': {
      // Use a dark or light purple on the host's card surface, with the host token as fallback.
      const surface = /^#([0-9a-f]{6})$/i.exec(colors.surface1)?.[1];
      if (!surface) return colors.foregroundMuted;
      const rgb = Number.parseInt(surface, 16);
      const brightness = ((rgb >> 16) * 299 + ((rgb >> 8) & 255) * 587 + (rgb & 255) * 114) / 1000;
      return brightness < 128 ? '#d5c3f5' : '#503577';
    }
    case 'success':
      return colors.statusSuccess;
    case 'warning':
      return colors.statusWarning;
    case 'danger':
      return colors.statusDanger;
    case 'muted':
      return colors.foregroundMuted;
    default:
      return colors.foreground;
  }
}

export function ActivityText({
  theme,
  children,
  tone,
  size = 11,
  strong,
  lines,
}: {
  theme: Theme;
  children: ReactNode;
  tone?: Tone;
  size?: number;
  strong?: boolean;
  lines?: number;
}) {
  return (
    <Text
      numberOfLines={lines}
      style={{
        color: activityColor(theme, tone),
        fontSize: size,
        fontWeight: strong ? '600' : '400',
        flexShrink: 1,
      }}
    >
      {children}
    </Text>
  );
}

export function ActivityStatus({
  theme,
  label,
  tone = 'muted',
}: {
  theme: Theme;
  label: string;
  tone?: Tone;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 88 }}>
      <View
        style={{
          width: 5,
          height: 5,
          borderRadius: 3,
          backgroundColor: activityColor(theme, tone),
        }}
      />
      <ActivityText theme={theme} tone={tone}>
        {label}
      </ActivityText>
    </View>
  );
}

function contextTone(percent: number | undefined): Tone {
  // Match the pinned Paseo composer context meter's thresholds.
  if (percent === undefined) return 'muted';
  if (percent > 90) return 'danger';
  if (percent >= 70) return 'warning';
  return 'muted';
}

export function contextDescription(context: ContextUsage | null) {
  if (!context) return 'Context usage unavailable';
  const percent = Math.round((100 * context.usedTokens) / context.budgetTokens);
  const estimate = context.estimated ? 'Estimated ' : '';
  return `${estimate}${context.usedTokens.toLocaleString()} / ${context.budgetTokens.toLocaleString()} tokens · ${percent}%`;
}

export function contextObservation(context: ContextUsage) {
  return new Date(context.observedAt).toLocaleString();
}

const ringSegments = Array.from({ length: 32 }, (_, index) => ({
  left: 12 + 11 * Math.sin((index * Math.PI) / 16),
  top: 12 - 11 * Math.cos((index * Math.PI) / 16),
}));

function ContextRing({
  theme,
  context,
  label,
}: {
  theme: Theme;
  context: ContextUsage | null;
  label: string;
}) {
  const percent = context ? (100 * context.usedTokens) / context.budgetTokens : undefined;
  const tone = contextTone(percent);
  const visibleSegments = Math.round(((percent ?? 0) * ringSegments.length) / 100);
  return (
    <View
      accessible
      accessibilityLabel={`${label}, ${contextDescription(context)}`}
      style={{
        width: 26,
        height: 26,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {ringSegments.map((position, index) => (
        <View
          key={index}
          style={{
            ...position,
            position: 'absolute',
            width: 2,
            height: 2,
            borderRadius: 1,
            backgroundColor:
              index < visibleSegments ? activityColor(theme, tone) : theme.colors.border,
          }}
        />
      ))}
      <ActivityText theme={theme} size={8} strong tone={tone}>
        {percent === undefined ? '?' : `${Math.round(percent)}%`}
      </ActivityText>
    </View>
  );
}

export function ActivityButton({
  theme,
  label,
  onPress,
  children,
  expanded,
  selected,
  header,
}: {
  theme: Theme;
  label: string;
  onPress: () => void;
  children: ReactNode;
  expanded?: boolean;
  selected?: boolean;
  header?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded, selected }}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flex: header ? 1 : undefined,
        minWidth: 0,
        maxWidth: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: header ? 7 : 4,
        paddingVertical: header ? 8 : 4,
        paddingHorizontal: header ? 7 : 6,
        borderRadius: 4,
        borderWidth: 1,
        borderColor:
          focused || selected || (!header && expanded)
            ? theme.colors.accent
            : header
              ? 'transparent'
              : theme.colors.border,
        backgroundColor:
          pressed || hovered || selected || (!header && expanded)
            ? theme.colors.surface2
            : theme.colors.surface1,
      })}
    >
      {children}
    </Pressable>
  );
}

export function ActivityCard({
  theme,
  title,
  icon,
  summary,
  summaryLabel,
  status,
  statusTone,
  context,
  contextLabel,
  open,
  onToggle,
  onOpenConversation,
  selected,
  children,
}: {
  theme: Theme;
  title: string;
  icon: string;
  summary: ReactNode;
  summaryLabel: string;
  status: string;
  statusTone?: Tone;
  context?: ContextUsage | null;
  contextLabel?: string;
  open: boolean;
  onToggle: () => void;
  onOpenConversation?: () => void;
  selected?: boolean;
  children: ReactNode;
}) {
  const colors = theme.colors;
  const contextAccessibility =
    context !== undefined ? `, ${contextLabel}, ${contextDescription(context)}` : '';
  return (
    <View
      style={{
        backgroundColor: colors.surface1,
        borderColor: selected ? colors.accent : colors.border,
        borderWidth: 1,
        borderRadius: 6,
        gap: 2,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 5 }}>
        <ActivityButton
          theme={theme}
          label={`${title}, ${summaryLabel}, ${status}${contextAccessibility}`}
          onPress={onToggle}
          expanded={open}
          header
        >
          <Icon
            name={open ? 'ChevronDown' : 'ChevronRight'}
            size={11}
            color={colors.foregroundMuted}
          />
          <View
            style={{
              width: 23,
              height: 23,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 4,
              backgroundColor: colors.surface2,
            }}
          >
            <Icon name={icon} size={13} color={activityColor(theme, statusTone)} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <ActivityText theme={theme} strong size={12} lines={1}>
              {title}
            </ActivityText>
            {summary}
          </View>
          <ActivityStatus theme={theme} label={status} tone={statusTone} />
          {context !== undefined && contextLabel && (
            <ContextRing theme={theme} context={context} label={contextLabel} />
          )}
        </ActivityButton>
        {onOpenConversation && (
          <ActivityButton
            theme={theme}
            label={`Open ${title} conversation`}
            onPress={onOpenConversation}
          >
            <Icon name="ArrowUpRight" size={12} color={colors.accent} />
          </ActivityButton>
        )}
      </View>
      {open && (
        <View style={{ paddingHorizontal: 10, paddingLeft: 26, paddingBottom: 10, gap: 6 }}>
          {children}
        </View>
      )}
    </View>
  );
}

export function ActivityField({
  theme,
  label,
  children,
}: {
  theme: Theme;
  label: string;
  children: ReactNode;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
      <View style={{ width: 96 }}>
        <ActivityText theme={theme} tone="muted">
          {label}
        </ActivityText>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <ActivityText theme={theme}>{children}</ActivityText>
      </View>
    </View>
  );
}
