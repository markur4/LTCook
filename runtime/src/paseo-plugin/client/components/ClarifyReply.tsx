import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRpc, type PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { Markdown } from '@getpaseo/plugin/client/ui';
import { z } from 'zod';
import { clarifyGenerateRpc, clarifyReadRpc } from '../../shared/clarify';

export const CLARIFY_REPLY_KIND = 'clarify-reply';
export const ClarifyReplySchema = z.object({
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
  messageId: z.string().min(1).optional(),
});

export function ClarifyReply({
  agentId,
  item: { data },
  theme,
}: PluginTimelineItemProps<z.infer<typeof ClarifyReplySchema>>) {
  const read = useRpc(clarifyReadRpc);
  const generate = useRpc(clarifyGenerateRpc);
  const request = useRef(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hosted, setHosted] = useState(false);
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();

  async function clarify() {
    if (request.current) return;
    if (expanded) {
      setExpanded(false);
      return;
    }
    request.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const source = { agentId, ...data };
      const saved = await read(source);
      if (saved.text !== null) {
        setText(saved.text);
        setExpanded(true);
      } else if (saved.mode === 'hosted' && !hosted) {
        setHosted(true);
      } else {
        const clarified = await generate(source);
        setText(clarified.text);
        setExpanded(true);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Clarification is unavailable.');
    } finally {
      request.current = false;
      setBusy(false);
    }
  }

  const needsHostedConfirmation = hosted && text === undefined;
  const label = busy
    ? 'Loading clarification…'
    : expanded
      ? 'Hide clarification'
      : text !== undefined
        ? 'Show clarification'
        : needsHostedConfirmation
          ? 'Clarify with Hosted inference'
          : 'Clarify';

  return (
    <View style={{ alignItems: 'flex-start', gap: 4 }}>
      {needsHostedConfirmation && (
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Hosted inference sends this reply and relevant earlier context to OpenAI.
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy, disabled: busy, expanded }}
        disabled={busy}
        onPress={() => void clarify()}
        style={{ paddingVertical: 6, paddingHorizontal: 8 }}
        testID="ltcook-clarify-reply"
      >
        <Text style={{ color: theme.colors.foreground }}>{label}</Text>
      </Pressable>
      {error && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.foreground }}>
          {error}
        </Text>
      )}
      {expanded && text !== undefined && <Markdown>{text}</Markdown>}
    </View>
  );
}
