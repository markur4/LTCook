import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

interface OwnershipRecord {
  version: 1;
  paths: string[];
}

function validateSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pi settings must contain a JSON object.');
  }
  const settings = value as Record<string, unknown>;
  if (
    settings.extensions !== undefined &&
    (!Array.isArray(settings.extensions) ||
      !settings.extensions.every((item) => typeof item === 'string'))
  ) {
    throw new Error('Pi settings extensions must be an array of strings.');
  }
  return settings;
}

function validateOwnership(value: unknown): OwnershipRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pi extension ownership record is malformed.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    record.version !== 1 ||
    !Array.isArray(record.paths) ||
    !record.paths.every((item) => typeof item === 'string' && item.length > 0)
  ) {
    throw new Error('Pi extension ownership record is malformed.');
  }
  return { version: 1, paths: record.paths };
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

const pendingConfigurations = new Map<string, Promise<void>>();

async function writePiExtensions(
  settingsPath: string,
  ownedPaths: readonly string[],
): Promise<void> {
  const ownershipPath = `${settingsPath}.ltcook-extensions.json`;
  const rawSettings = await readJsonFile(settingsPath);
  const settings = validateSettings(rawSettings === undefined ? {} : rawSettings);
  const rawOwnership = await readJsonFile(ownershipPath);
  const previousOwnership = rawOwnership === undefined ? [] : validateOwnership(rawOwnership).paths;
  const existing = (settings.extensions as string[] | undefined) ?? [];
  // > Existing entries without a prior ownership record remain user-managed.
  const nextOwnership = [...new Set(ownedPaths)].filter(
    (extension) => !existing.includes(extension) || previousOwnership.includes(extension),
  );
  const transitioningOwnership = [...new Set([...previousOwnership, ...nextOwnership])];
  const extensions = [
    ...new Set([
      ...existing.filter((extension) => !previousOwnership.includes(extension)),
      ...ownedPaths,
    ]),
  ];

  // > Persist the union first so a failed settings or final ownership write
  // > retains every old and current path for the next cleanup attempt.
  await writeJsonAtomically(ownershipPath, { version: 1, paths: transitioningOwnership });
  await writeJsonAtomically(settingsPath, { ...settings, extensions });
  await writeJsonAtomically(ownershipPath, { version: 1, paths: nextOwnership });
}

/** Replace exactly recorded LTCook Pi extensions, retaining unrelated user entries. */
export async function configurePiExtensions(
  settingsPath: string,
  ownedPaths: readonly string[],
): Promise<void> {
  const previous = pendingConfigurations.get(settingsPath) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(() => writePiExtensions(settingsPath, ownedPaths));
  pendingConfigurations.set(settingsPath, pending);
  try {
    await pending;
  } finally {
    if (pendingConfigurations.get(settingsPath) === pending) {
      pendingConfigurations.delete(settingsPath);
    }
  }
}
