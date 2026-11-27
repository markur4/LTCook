import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { invalidRepositoryFilterArgument, RepositoryFilterSchema } from './filter.js';

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
    filter: Type.Optional(RepositoryFilterSchema),
  },
  { additionalProperties: false },
);

export type RiedRequest = Static<typeof riedInputSchema>;

export function validateRiedRequest(input: unknown): RiedRequest {
  if (!Value.Check(riedInputSchema, input))
    throw invalidRepositoryFilterArgument(input) ?? new Error('Invalid RIED arguments');
  const { operation, section, target, maxDepth, maxEntries, base, filter } = input;
  if ((operation === 'section') !== Boolean(section))
    throw new Error('RIED section is required only for section requests');
  if (operation === 'outline' && !target)
    throw new Error('RIED outline requires an explicit target');
  if (target && operation !== 'map' && operation !== 'outline')
    throw new Error('A RIED target is supported only for maps and outlines');
  if ((maxDepth || maxEntries) && operation !== 'map')
    throw new Error('RIED depth and entry limits are supported only for maps');
  if (base && section !== 'git') throw new Error('A RIED base reference requires the Git section');
  if (filter) {
    const pathOnly = (Object.keys(filter) as (keyof typeof filter)[]).every(
      (field) => field === 'includePaths' || field === 'excludePaths',
    );
    if (!pathOnly)
      throw new Error('RIED supports filter.includePaths and filter.excludePaths only.');
    const supported =
      operation === 'map' ||
      (operation === 'outline' && Boolean(target)) ||
      (operation === 'section' && ['repository', 'recipes', 'git'].includes(section ?? ''));
    if (!supported)
      throw new Error(
        `RIED ${operation}${section ? ` section ${section}` : ''} does not support filter.`,
      );
  }
  return input;
}
