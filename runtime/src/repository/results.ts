import { Type, type Static } from 'typebox';

export const RepositoryDiagnosticSchema = Type.Object({
  source: Type.String(),
  code: Type.String(),
  message: Type.String(),
});

export type RepositoryDiagnostic = Static<typeof RepositoryDiagnosticSchema>;

export const RepositoryFreshnessSchema = Type.Union([
  Type.Literal('current'),
  Type.Literal('cached'),
  Type.Literal('stale'),
  Type.Literal('unknown'),
]);

export interface RepositoryResult<T> {
  provider: string;
  value: T;
  diagnostics: RepositoryDiagnostic[];
  partial: boolean;
  truncated: boolean;
  capturedAt: string;
  freshness: Static<typeof RepositoryFreshnessSchema>;
}

export const RepositoryRetrievalKindSchema = Type.Union([
  Type.Literal('ranked'),
  Type.Literal('exhaustive'),
]);

export const RepositoryRetrievalStatusSchema = Type.Union([
  Type.Literal('ready'),
  Type.Literal('indexing'),
  Type.Literal('unavailable'),
]);

export const MAX_SOURCE_EXCERPT = 2000;
export const RepositoryHitSchema = Type.Object({
  path: Type.String(),
  startLine: Type.Integer({ minimum: 1 }),
  endLine: Type.Integer({ minimum: 1 }),
  excerpt: Type.String({ maxLength: MAX_SOURCE_EXCERPT }),
  excerptTruncated: Type.Optional(Type.Literal(true)),
  name: Type.Optional(Type.String()),
});

export type RepositoryHit = Static<typeof RepositoryHitSchema>;

export type RepositoryRetrieval = RepositoryResult<{
  kind: Static<typeof RepositoryRetrievalKindSchema>;
  status: Static<typeof RepositoryRetrievalStatusSchema>;
  hits: RepositoryHit[];
}>;
