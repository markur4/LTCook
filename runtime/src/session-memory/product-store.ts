import { chmodSync } from 'node:fs';
import Database from 'libsql';

/** Open product state independently of native history and deterministic records. */
export function openConversationProductStore(path: string): Database.Database {
  const database = new Database(path);
  try {
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
