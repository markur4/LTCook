import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

const preferencesSchema = z.object({
  'rag-index': z.boolean(),
  bughunter: z.boolean().default(true),
});
type Preferences = z.infer<typeof preferencesSchema>;
type ActivityFeature = keyof Preferences;

export class ActivityPreferences {
  private values: Preferences;

  constructor(private readonly file: string) {
    try {
      this.values = preferencesSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      this.values = preferencesSchema.parse({ 'rag-index': true });
    }
  }

  enabled(feature: ActivityFeature): boolean {
    return this.values[feature];
  }

  set(feature: ActivityFeature, enabled: boolean): void {
    if (this.enabled(feature) === enabled) return;
    this.save({ ...this.values, [feature]: enabled });
  }

  private save(next: Preferences): void {
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
