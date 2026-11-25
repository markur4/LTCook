import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = '0.16.0-beta.2';
const revision = '23bae61535542a45ade7196a7b3c152705f16de3';
const archiveSha256 = '9bf1a5088b85057aea7038497d00e39305385c9ed56581d60247e7752184c15a';
const patches = ['timeline-navigation.patch', 'session-worktrees.patch'].map(
  (name) => new URL(name, import.meta.url),
);
const stampName = 'ltcook-paseo-build.json';
const defaultOutput = fileURLToPath(new URL('../runtime/dist/paseo-web', import.meta.url));

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function run(command, args, cwd, env = process.env) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === 'win32' && command === 'npm',
      stdio: 'inherit',
    });
    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (code === 0) done();
      else fail(new Error(`${command} exited with ${signal ?? code}`));
    });
  });
}

async function readStamp(output) {
  try {
    return await readFile(join(output, stampName), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function build() {
  if (process.argv.length > 3) throw new Error('Usage: node paseo-patches/build.mjs [output-dir]');
  const output = resolve(process.argv[2] ?? defaultOutput);
  const stamp = JSON.stringify({
    version,
    revision,
    archiveSha256,
    patches: await Promise.all(
      patches.map(async (patch) => ({
        name: basename(patch.pathname),
        sha256: sha256(await readFile(patch)),
      })),
    ),
    builderSha256: sha256(await readFile(new URL(import.meta.url))),
  });
  const currentStamp = await readStamp(output);
  const currentIndex = await stat(join(output, 'index.html')).catch(() => null);
  if (currentStamp === stamp && currentIndex?.size) return;
  if (!currentStamp && (await stat(output).catch(() => null))) {
    throw new Error(`Paseo build output already exists without ${stampName}: ${output}`);
  }

  const scratch = await mkdtemp(join(tmpdir(), 'ltcook-paseo-web-'));
  let stage;
  try {
    await run(
      'curl',
      [
        '-fsSL',
        `https://codeload.github.com/getpaseo/paseo/tar.gz/${revision}`,
        '-o',
        'source.tar.gz',
      ],
      scratch,
    );
    if (sha256(await readFile(join(scratch, 'source.tar.gz'))) !== archiveSha256) {
      throw new Error('Paseo source archive checksum mismatch');
    }
    const source = join(scratch, `paseo-${revision}`);
    await run('tar', ['-xzf', 'source.tar.gz'], scratch);
    await run('git', ['apply', ...patches.map((patch) => fileURLToPath(patch))], source);
    const env = {
      ...process.env,
      CI: '1',
      ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
      EXPO_NO_TELEMETRY: '1',
      LEFTHOOK: '0',
      PASEO_WEB_PLATFORM: 'web',
    };
    await run(
      'npm',
      ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      source,
      env,
    );
    await run('npm', ['run', 'postinstall'], source, env);
    await run(
      process.execPath,
      ['packages/protocol/scripts/generate-validation-aot.mjs'],
      source,
      env,
    );
    await run('npm', ['run', 'build:daemon-web-ui'], source, env);

    const assets = join(source, 'packages', 'server', 'dist', 'server', 'web-ui');
    if (!(await stat(join(assets, 'index.html'))).size) {
      throw new Error('Paseo web build has an empty index');
    }
    await mkdir(dirname(output), { recursive: true });
    stage = await mkdtemp(join(dirname(output), '.paseo-web-'));
    await cp(assets, stage, { recursive: true });
    await cp(join(source, 'LICENSE'), join(stage, 'paseo-LICENSE.txt'));
    await writeFile(join(stage, stampName), stamp);
    if (currentStamp) await rm(output, { recursive: true, force: true });
    await rename(stage, output);
    console.log(`Built patched Paseo ${version} web UI at ${output}`);
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

await build();
