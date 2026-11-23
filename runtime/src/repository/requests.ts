import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

export const riedInputSchema = Type.Object(
  {
    operation: Type.Union([
      Type.Literal('summary'),
      Type.Literal('section'),
      Type.Literal('refresh'),
      Type.Literal('map'),
      Type.Literal('outline'),
    ]),
    section: Type.Optional(
      Type.Union([
        Type.Literal('repository'),
        Type.Literal('git'),
        Type.Literal('host'),
        Type.Literal('recipes'),
      ]),
    ),
    target: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
    base: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);

export type RiedRequest = Static<typeof riedInputSchema>;

export function validateRiedRequest(input: unknown): RiedRequest {
  if (!Value.Check(riedInputSchema, input)) throw new Error('Invalid RIED arguments');
  const { operation, section, target, maxDepth, maxEntries, base } = input;
  if ((operation === 'section') !== Boolean(section))
    throw new Error('RIED section is required only for section requests');
  if (operation === 'outline' && !target)
    throw new Error('RIED outline requires an explicit target');
  if (target && operation !== 'map' && operation !== 'outline')
    throw new Error('A RIED target is supported only for maps and outlines');
  if ((maxDepth || maxEntries) && operation !== 'map')
    throw new Error('RIED depth and entry limits are supported only for maps');
  if (base && section !== 'git') throw new Error('A RIED base reference requires the Git section');
  return input;
}
