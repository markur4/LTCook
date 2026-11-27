import { useState, type ReactNode } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Icon } from '@getpaseo/plugin/client/ui';
import type { Theme } from './PanelChrome';

export function TrackerText({
  theme,
  children,
  muted,
  size = 13,
  strong,
  heading,
}: {
  theme: Theme;
  children: ReactNode;
  muted?: boolean;
  size?: number;
  strong?: boolean;
  heading?: boolean;
}) {
  return (
    <Text
      selectable
      accessibilityRole={heading ? 'header' : undefined}
      style={{
        color: muted ? theme.colors.foregroundMuted : theme.colors.foreground,
        fontSize: size,
        lineHeight: Math.round(size * 1.45),
        fontWeight: strong ? '600' : '400',
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
      }}
    >
      {children}
    </Text>
  );
}

export function TrackerButton({
  theme,
  label,
  icon,
  onPress,
  disabled,
  selected,
  primary,
  danger,
  quiet,
  expanded,
  testID,
}: {
  theme: Theme;
  label: string;
  icon?: string;
  onPress(): void;
  disabled?: boolean;
  selected?: boolean;
  primary?: boolean;
  danger?: boolean;
  quiet?: boolean;
  expanded?: boolean;
  testID?: string;
}) {
  const [focused, setFocused] = useState(false);
  const touch =
    Platform.OS !== 'web' ||
    (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia?.(
      '(pointer: coarse)',
    ).matches === true;
  const color = primary
    ? theme.colors.accentForeground
    : danger
      ? theme.colors.statusDanger
      : theme.colors.foreground;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected, expanded }}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      hitSlop={4}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        minHeight: touch ? 44 : 30,
        maxWidth: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        paddingHorizontal: 11,
        paddingVertical: 4,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: focused
          ? theme.colors.accent
          : quiet && !selected
            ? 'transparent'
            : theme.colors.border,
        backgroundColor: primary
          ? theme.colors.accent
          : selected || pressed || hovered
            ? theme.colors.surface2
            : quiet
              ? 'transparent'
              : theme.colors.surface1,
        opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
      })}
    >
      {icon && <Icon name={icon} size={14} color={color} />}
      <Text
        style={{
          color,
          fontSize: 12,
          fontWeight: '500',
          flexShrink: 1,
          minWidth: 0,
          maxWidth: '100%',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function TrackerNotice({
  theme,
  children,
  warning = false,
  action,
}: {
  theme: Theme;
  children: ReactNode;
  warning?: boolean;
  action?: ReactNode;
}) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderLeftWidth: 3,
        borderLeftColor: warning ? theme.colors.statusWarning : theme.colors.accent,
        backgroundColor: theme.colors.surface1,
        borderRadius: 5,
      }}
    >
      <Icon
        name={warning ? 'TriangleAlert' : 'Info'}
        size={16}
        color={warning ? theme.colors.statusWarning : theme.colors.foregroundMuted}
      />
      <View style={{ flex: 1, minWidth: 140 }}>{children}</View>
      {action}
    </View>
  );
}
