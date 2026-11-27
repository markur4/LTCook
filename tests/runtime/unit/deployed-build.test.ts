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
    await expect(verifyDeployedBuild(root, path.join(root, entry), fingerprint)).resolves.toBe(
      fingerprint,
    );
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
