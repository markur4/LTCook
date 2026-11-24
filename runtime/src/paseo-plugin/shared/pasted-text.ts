import {
  defineAttachmentSource,
  defineRpc,
  PluginAttachmentSearchPayloadSchema,
} from '@getpaseo/plugin';
import { z } from 'zod';

export const pastedTextRpc = defineRpc({
  name: 'ltcook.paste.attach',
  input: z.object({ query: z.string().max(262_144) }),
  output: PluginAttachmentSearchPayloadSchema,
});

export const discardPastedTextRpc = defineRpc({
  name: 'ltcook.paste.discard',
  input: z.object({ id: z.uuid() }),
  output: z.object({}),
});

export const pastedTextSearchRpc = defineRpc({
  name: 'ltcook.paste.search',
  input: z.object({ query: z.string() }),
  output: PluginAttachmentSearchPayloadSchema,
});

export const pastedTextSource = defineAttachmentSource({
  id: 'ltcook-pasted-text',
  title: 'Pasted text',
  icon: 'Clipboard',
  pickerTitle: 'Paste as attachment',
  searchPlaceholder: 'Paste the text to attach',
  search: pastedTextSearchRpc,
});
