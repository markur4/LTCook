import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
export type Theme = PluginWorkspacePanelProps['theme'];
export function Label({
  theme,
  children,
  muted = false,
  heading = false,
}: {
  theme: Theme;
  children: ReactNode;
  muted?: boolean;
  heading?: boolean;
}) {
  return (
    <Text
      accessibilityRole={heading ? 'header' : undefined}
      style={{
        color: muted ? theme.colors.foregroundMuted : theme.colors.foreground,
        fontSize: heading ? 20 : 14,
        lineHeight: 22,
      }}
    >
      {children}
    </Text>
  );
}
export function Card({ theme, children }: { theme: Theme; children: ReactNode }) {
  return (
    <View
      style={{
        padding: 12,
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {children}
    </View>
  );
}
export function Action({
  theme,
  title,
  onPress,
  selected = false,
  disabled = false,
}: {
  theme: Theme;
  title: string;
  onPress: () => void;
  selected?: boolean;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => ({
        padding: 10,
        borderWidth: 2,
        borderRadius: 6,
        borderColor: focused || selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: pressed || selected ? theme.colors.surface2 : theme.colors.surface1,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Label theme={theme}>{title}</Label>
    </Pressable>
  );
}
