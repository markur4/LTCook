import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ColgrepIndexStore } from '../../../runtime/src/repository/providers/colgrep-index-store.js';
import {
  openRepositoryWorkspace,
  repositoryWorkspaceCacheIdentity,
} from '../../../runtime/src/repository/workspace.js';

async function withWorkspace(
  operation: (
    root: string,
    cache: string,
    workspace: Awaited<ReturnType<typeof openRepositoryWorkspace>>,
  ) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ltcook-index-store-')));
  try {
    const source = path.join(root, 'workspace');
    const cache = path.join(root, 'cache');
    await mkdir(source);
    const workspace = await openRepositoryWorkspace(source);
    await operation(root, cache, workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function publish(store: ColgrepIndexStore, marker: string) {
  const writer = await store.tryWriter();
  if (!writer) throw new Error('The fixture could not acquire the index writer.');
  try {
    const candidate = await writer.candidate({ seed: false });
    await writeFile(path.join(candidate.indices, marker), marker);
    return await writer.publish(candidate);
  } finally {
    await writer.release();
  }
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await Bun.file(file).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${path.basename(file)}.`);
}

test('reuses a persistent cache identity across live device changes and isolates a new incarnation', () =>
  withWorkspace(async (_root, cache, workspace) => {
    const compatibility = 'fixture-colgrep-format-v1';
    const store = await ColgrepIndexStore.open(cache, workspace, compatibility, true);
    const published = await publish(store, 'first-generation');

    const rebootedWorkspace = {
      ...workspace,
      identity: 'different-device:same-directory-inode',
      async assertUnchanged() {},
    };
    const rebooted = await ColgrepIndexStore.open(cache, rebootedWorkspace, compatibility, false);
    expect(await rebooted?.readPublished()).toMatchObject({
      id: published.id,
      indices: published.indices,
    });
    expect(
      await ColgrepIndexStore.open(cache, rebootedWorkspace, 'incompatible-format', false),
    ).toBeUndefined();

    const replacementWorkspace = {
      ...rebootedWorkspace,
      cacheIdentity: 'different-directory-incarnation',
    };
    expect(
      await ColgrepIndexStore.open(cache, replacementWorkspace, compatibility, false),
    ).toBeUndefined();
  }));

test('worktrees without birth time keep their published cache after root directory edits', () =>
  withWorkspace(async (root, cache, workspace) => {
    const compatibility = 'fixture-colgrep-format-v1';
    const stats = await stat(workspace.root, { bigint: true });
    const store = await ColgrepIndexStore.open(
      cache,
      {
        ...workspace,
        cacheIdentity: repositoryWorkspaceCacheIdentity({ ...stats, birthtimeNs: 0n }),
      },
      compatibility,
      true,
    );
    const published = await publish(store, 'first-generation');

    await writeFile(path.join(workspace.root, 'new.js'), 'export const ready = true;');
    const reopened = await openRepositoryWorkspace(workspace.root);
    const changed = { ...stats, ctimeNs: stats.ctimeNs + 1n, birthtimeNs: 0n };
    const sameDirectory = await ColgrepIndexStore.open(
      cache,
      { ...reopened, cacheIdentity: repositoryWorkspaceCacheIdentity(changed) },
      compatibility,
      false,
    );
    expect((await sameDirectory?.readPublished())?.id).toBe(published.id);

    await rename(workspace.root, path.join(root, 'previous-worktree'));
    await mkdir(workspace.root);
    const replacement = await openRepositoryWorkspace(workspace.root);
    const replaced = { ...(await stat(workspace.root, { bigint: true })), birthtimeNs: 0n };
    expect(
      await ColgrepIndexStore.open(
        cache,
        { ...replacement, cacheIdentity: repositoryWorkspaceCacheIdentity(replaced) },
        compatibility,
        false,
      ),
    ).toBeUndefined();
  }));

test(
  'a second process can pin a generation while the writer owns publication',
  () =>
    withWorkspace(async (root, cache, workspace) => {
      const compatibility = 'fixture-colgrep-format-v1';
      const store = await ColgrepIndexStore.open(cache, workspace, compatibility, true);
      const previous = await publish(store, 'old-generation');
      const writer = await store.tryWriter();
      if (!writer) throw new Error('The fixture could not acquire the index writer.');
      const pinnedFile = path.join(root, 'reader-pinned');
      const releaseFile = path.join(root, 'release-reader');
      const workspaceModule = new URL(
        '../../../runtime/src/repository/workspace.ts',
        import.meta.url,
      ).href;
      const storeModule = new URL(
        '../../../runtime/src/repository/providers/colgrep-index-store.ts',
        import.meta.url,
      ).href;
      const script = `
      import { openRepositoryWorkspace } from ${JSON.stringify(workspaceModule)};
      import { ColgrepIndexStore } from ${JSON.stringify(storeModule)};
      const workspace = await openRepositoryWorkspace(process.env.LTCOOK_TEST_WORKSPACE);
      const store = await ColgrepIndexStore.open(
        process.env.LTCOOK_TEST_CACHE,
        workspace,
        process.env.LTCOOK_TEST_COMPATIBILITY,
        false,
      );
      const competingWriter = await store?.tryWriter();
      if (competingWriter) {
        await competingWriter.release();
        throw new Error('Two processes held the writer lease.');
      }
      const pin = await store?.pinPublished();
      if (!pin) throw new Error('No generation was available to pin.');
      if (pin.id !== process.env.LTCOOK_TEST_GENERATION)
        throw new Error('The child pinned an unexpected generation.');
      await Bun.write(process.env.LTCOOK_TEST_PINNED, pin.id);
      const deadline = Date.now() + 15000;
      while (!(await Bun.file(process.env.LTCOOK_TEST_RELEASE).exists())) {
        if (Date.now() > deadline) throw new Error('The parent did not release the reader.');
        await Bun.sleep(10);
      }
      await pin.release();
    `;
      const reader = Bun.spawn([process.execPath, '-e', script], {
        env: {
          ...process.env,
          LTCOOK_TEST_WORKSPACE: workspace.root,
          LTCOOK_TEST_CACHE: cache,
          LTCOOK_TEST_COMPATIBILITY: compatibility,
          LTCOOK_TEST_GENERATION: previous.id,
          LTCOOK_TEST_PINNED: pinnedFile,
          LTCOOK_TEST_RELEASE: releaseFile,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stderr = new Response(reader.stderr).text();

      try {
        await waitForFile(pinnedFile);
        const candidate = await writer.candidate({ seed: false });
        await writeFile(path.join(candidate.indices, 'new-generation'), 'new-generation');
        const current = await writer.publish(candidate);
        expect(current.id).not.toBe(previous.id);
        expect(await store.readPublished()).toMatchObject({ id: current.id });
        expect(await stat(path.join(previous.indices, 'old-generation'))).toBeDefined();

        await Bun.write(releaseFile, 'release');
        expect(await reader.exited).toBe(0);
        expect(await stderr).toBe('');
        await expect(stat(previous.indices)).rejects.toHaveProperty('code', 'ENOENT');
      } finally {
        await writer.release();
        if (reader.exitCode === null) {
          await Bun.write(releaseFile, 'release');
          await reader.exited;
        }
      }
    }),
  30_000,
);
