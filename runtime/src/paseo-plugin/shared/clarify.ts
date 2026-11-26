import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

const replyReference = z.strictObject({
  agentId: z.string().min(1),
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
  messageId: z.string().min(1).optional(),
});
const mode = z.enum(['hosted', 'local']);

export const clarifyReadRpc = defineRpc({
  name: 'ltcook.clarify.read',
  input: replyReference,
  output: z.object({ text: z.string().nullable(), mode }),
});

export const clarifyGenerateRpc = defineRpc({
  name: 'ltcook.clarify.generate',
  input: replyReference,
  output: z.object({ text: z.string(), mode }),
});
