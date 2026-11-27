import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyDeployedBuild } from '../../../runtime/src/integrations/deployed-build.js';

const hash = (contents: string) => createHash('sha256').update(contents).digest('hex');

test('verifies actual deployed assets and rejects a receipt left by a different build', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ltcook-build-'));
  try {
    const entry = 'runtime/dist/main.js';
    const browser = 'runtime/dist/paseo-web/index.html';
    const assetContents = {
      [entry]: '// the runtime',
      [browser]: '<!doctype html><title>Paseo</title>',
    };
    const files = Object.fromEntries(
      Object.entries(assetContents).map(([name, contents]) => [name, hash(contents)]),
    );
    const fingerprint = hash(`${entry}\0${files[entry]}\n${browser}\0${files[browser]}\n`);
    for (const [name, contents] of Object.entries(assetContents)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), contents);
    }
    await writeFile(path.join(root, '.ltcook-build.json'), JSON.stringify({ fingerprint, files }));
    await writeFile(path.join(root, 'runtime/dist/source-revision'), `${'a'.repeat(40)}\n`);
    await expect(verifyDeployedBuild(root, path.join(root, entry), fingerprint)).resolves.toEqual({
      fingerprint,
    });
    await expect(verifyDeployedBuild(root, path.join(root, entry), '0'.repeat(64))).rejects.toThrow(
      'does not match the installation receipt',
    );
    await expect(
      verifyDeployedBuild(root, path.join(root, 'old', entry), fingerprint),
    ).rejects.toThrow('entrypoint belongs to a different deployment');
    await writeFile(path.join(root, browser), '<!doctype html><title>Wrong build</title>');
    await expect(verifyDeployedBuild(root, path.join(root, entry), fingerprint)).rejects.toThrow(
      `asset changed: ${browser}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns source provenance only from the verified deployment asset', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ltcook-build-'));
  try {
    const entry = 'runtime/dist/main.js';
    const provenance = 'runtime/dist/source-revision';
    const entryPath = path.join(root, entry);
    const provenancePath = path.join(root, provenance);
    const manifestPath = path.join(root, '.ltcook-build.json');
    const entryContents = '// the runtime';
    const sourceRevision = 'a'.repeat(40);
    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(entryPath, entryContents);
    async function installManifest(contents: string): Promise<string> {
      const files = { [entry]: hash(entryContents), [provenance]: hash(contents) };
      const fingerprint = hash(`${entry}\0${files[entry]}\n${provenance}\0${files[provenance]}\n`);
      await writeFile(provenancePath, contents);
      await writeFile(manifestPath, JSON.stringify({ fingerprint, files }));
      return fingerprint;
    }
    const fingerprint = await installManifest(`${sourceRevision}\n`);
    await expect(verifyDeployedBuild(root, entryPath, fingerprint)).resolves.toEqual({
      fingerprint,
      sourceRevision,
    });
    await writeFile(provenancePath, `${'b'.repeat(40)}\n`);
    await expect(verifyDeployedBuild(root, entryPath, fingerprint)).rejects.toThrow(
      `asset changed: ${provenance}`,
    );
    const malformedFingerprint = await installManifest('main\n');
    await expect(verifyDeployedBuild(root, entryPath, malformedFingerprint)).rejects.toThrow(
      'source revision is invalid',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
