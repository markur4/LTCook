import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const entrypoint = 'runtime/dist/main.js';
const provenanceAsset = 'runtime/dist/source-revision';
const gitCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const deploymentManifest = z.strictObject({
  fingerprint: sha256,
  files: z.record(z.string(), sha256),
});

function assetPath(root: string, asset: string): string {
  const segments = asset.split('/');
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    /[\\:\u0000-\u001f]/u.test(asset)
  ) {
    throw new Error('The deployed build declares an invalid asset path.');
  }
  return path.join(root, ...segments);
}

/** Verify the production files from the executing entrypoint against the published build. */
export async function verifyDeployedBuild(
  appRoot: string,
  runningEntry: string,
  expected: unknown,
): Promise<{ fingerprint: string; sourceRevision?: string }> {
  const root = await realpath(appRoot);
  if (path.resolve(runningEntry) !== assetPath(root, entrypoint))
    throw new Error('The runtime entrypoint belongs to a different deployment.');
  const manifestPath = path.join(root, '.ltcook-build.json');
  if ((await realpath(manifestPath)) !== manifestPath)
    throw new Error('The deployed build manifest is linked.');
  const manifest = deploymentManifest.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (!Object.hasOwn(manifest.files, entrypoint))
    throw new Error('The deployed build manifest is missing the runtime entrypoint.');
  const assets = Object.entries(manifest.files).sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  const digest = createHash('sha256');
  let sourceRevision: string | undefined;
  for (const [asset, declared] of assets) {
    const target = assetPath(root, asset);
    if ((await realpath(target)) !== target || !(await stat(target)).isFile())
      throw new Error(`The deployed build asset is not a regular file: ${asset}`);
    const contents = await readFile(target);
    const actual = createHash('sha256').update(contents).digest('hex');
    if (actual !== declared) throw new Error(`The deployed build asset changed: ${asset}`);
    if (asset === provenanceAsset) {
      const revision = contents.toString('utf8').trim();
      if (!gitCommit.test(revision))
        throw new Error('The deployed build source revision is invalid.');
      sourceRevision = revision;
    }
    digest.update(`${asset}\0${actual}\n`);
  }
  const actual = digest.digest('hex');
  if (actual !== manifest.fingerprint || actual !== expected)
    throw new Error('The deployed runtime build does not match the installation receipt.');
  return { fingerprint: actual, ...(sourceRevision === undefined ? {} : { sourceRevision }) };
}
