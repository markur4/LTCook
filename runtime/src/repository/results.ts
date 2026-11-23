export interface RepositoryDiagnostic {
  source: string;
  code: string;
  message: string;
}

export interface RepositoryResult<T> {
  value: T;
  diagnostics: RepositoryDiagnostic[];
  partial: boolean;
  truncated: boolean;
  capturedAt: string;
  freshness: 'current' | 'cached' | 'stale';
}
