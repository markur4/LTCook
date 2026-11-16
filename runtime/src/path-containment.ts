import path from 'node:path';

/** Compare paths lexically using host-platform rules; callers resolve symlinks where needed. */
export function isWithin(root: string, candidate: string, allowEqual = false): boolean {
  const relative = path.relative(root, candidate);
  return (
    (allowEqual || relative !== '') &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
