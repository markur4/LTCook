import { useState } from 'react';
import { useComposer, useRpc, type PluginComposerItemProps } from '@getpaseo/plugin/client';
import { Action, copyText, Modal, TextInput, useToast } from '@getpaseo/plugin/client/ui';
import { Text, View } from 'react-native';
import { discardPastedTextRpc, pastedTextRpc, pastedTextSource } from '../../shared/pasted-text';

export function PastedTextComposerItem({ theme }: PluginComposerItemProps) {
  const composer = useComposer();
  const attach = useRpc(pastedTextRpc);
  const discard = useRpc(discardPastedTextRpc);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<string>();
  const drafts = composer.attachments.filter(({ sourceId }) => sourceId === pastedTextSource.id);
  if (composer.agent.provider && !['ltcook', 'pi', 'codex'].includes(composer.agent.provider))
    return null;
  return (
    <>
      <Action icon="Clipboard" title="Paste as attachment" onPress={() => setOpen(true)} />
      <Modal title="Paste as attachment" open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <TextInput
            accessibilityLabel="Text to attach"
            placeholder="Paste the text to attach"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={text}
            onChangeText={setText}
            multiline
            style={{
              minHeight: 120,
              maxHeight: 260,
              color: theme.colors.foreground,
              borderColor: theme.colors.border,
              borderWidth: 1,
              borderRadius: 8,
              padding: 12,
            }}
          />
          <Action
            icon="Paperclip"
            title="Attach text"
            disabled={!text.trim()}
            onPress={async () => {
              const { items } = await attach({ query: text });
              const item = items[0];
              if (!item) throw new Error('LTCook could not attach the pasted text.');
              composer.addAttachment({ sourceId: pastedTextSource.id, item });
              composer.setPrompt([composer.prompt, item.identifier].filter(Boolean).join('\n\n'));
              setText('');
              setOpen(false);
            }}
          />
          {drafts.map(({ item }) => {
            const body = item.text.slice(item.text.indexOf('\n') + 1, item.text.lastIndexOf('\n'));
            return (
              <View key={item.id}>
                <Text style={{ color: theme.colors.foreground }}>{item.subtitle}</Text>
                <Action icon="FileText" title="Inspect" onPress={() => setPreview(body)} />
                <Action
                  icon="Copy"
                  title="Copy"
                  onPress={async () => {
                    await copyText(body);
                    toast.show('Copied pasted text');
                  }}
                />
                <Action
                  icon="X"
                  title="Remove"
                  onPress={async () => {
                    composer.removeAttachment({ sourceId: pastedTextSource.id, itemId: item.id });
                    composer.setPrompt(composer.prompt.replace(item.identifier, '').trimEnd());
                    setPreview(undefined);
                    await discard({ id: item.id });
                  }}
                />
              </View>
            );
          })}
          {preview !== undefined && (
            <Text selectable style={{ color: theme.colors.foreground }}>
              {preview}
            </Text>
          )}
        </Modal.Content>
      </Modal>
    </>
  );
}
