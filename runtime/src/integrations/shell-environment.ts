/** Captures the shell before AppRC overlays, without retaining nested provenance. */
export function captureShellEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const encoded = source.LTCOOK_SHELL_PROVENANCE;
  let original: Record<string, unknown> = source;
  if (encoded !== undefined) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch {
      throw new Error('LTCOOK_SHELL_PROVENANCE is not an environment mapping');
    }
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      Array.isArray(decoded) ||
      !Object.values(decoded).every((value) => typeof value === 'string')
    ) {
      throw new Error('LTCOOK_SHELL_PROVENANCE is not an environment mapping');
    }
    original = decoded as Record<string, string>;
  }
  return Object.fromEntries(
    Object.entries(original).filter(
      (entry): entry is [string, string] =>
        entry[0] !== 'LTCOOK_SHELL_PROVENANCE' && typeof entry[1] === 'string',
    ),
  );
}
