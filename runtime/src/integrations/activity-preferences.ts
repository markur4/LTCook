import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

const preferencesSchema = z.strictObject({ summarizer: z.boolean(), 'rag-index': z.boolean() });
type Preferences = z.infer<typeof preferencesSchema>;

export class ActivityPreferences {
  private values: Preferences;

  constructor(private readonly file: string) {
    try {
      this.values = preferencesSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      this.values = { summarizer: true, 'rag-index': true };
    }
  }

  enabled(feature: keyof Preferences): boolean {
    return this.values[feature];
  }

  set(feature: keyof Preferences, enabled: boolean): void {
    if (this.enabled(feature) === enabled) return;
    const next = { ...this.values, [feature]: enabled };
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.file);
    } finally {
      rmSync(temporary, { force: true });
    }
    this.values = next;
  }
}
