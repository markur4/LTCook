import { expect, test } from 'bun:test';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openRepositoryWorkspace } from '../../../runtime/src/repository/workspace.js';
import { createColgrepProvider } from '../../../runtime/src/repository/providers/colgrep.js';
import { WorkspaceMcp } from '../../../runtime/src/integrations/mcp.js';
import { ToolCatalog } from '../../../runtime/src/tools/catalog.js';
import {
  createRepoSearchTool,
  REPO_SEARCH_TOOL_NAME,
} from '../../../runtime/src/tools/repo-search.js';

const deploymentDirectory = process.env.LTCOOK_COLGREP_DEPLOYMENT;
const timeoutMs = 120_000;
const piFixture = fileURLToPath(new URL('./repo-search-pi.ts', import.meta.url));

async function withTemporaryDirectory<T>(operation: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ltcook-repo-search-'));
  try {
    return await operation(await realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function searchTool(cacheDirectory: string, deployment = deploymentDirectory, timeout = timeoutMs) {
  return createRepoSearchTool(
    createColgrepProvider({ deploymentDirectory: deployment, cacheDirectory, timeoutMs: timeout }),
  );
}

function search(
  tool: ReturnType<typeof searchTool>,
  workspaceRoot: string,
  args: {
    query: string;
    mode?: 'hybrid' | 'semantic';
    pattern?: string;
    paths?: string[];
    limit?: number;
  },
) {
  return tool.invoke(args, {
    agentId: 'colgrep-system',
    workspaceRoot,
    repositorySearchAccess: true,
    workspaceFileAccess: false,
    signal: new AbortController().signal,
  });
}

function git(workspace: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', workspace, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function code(symbol: string) {
  return `export function ${symbol}(bytes: Uint8Array) {
  let checksum = 0;
  for (const byte of bytes) checksum = (checksum + byte) % 65521;
  return checksum;
}\n`;
}

async function findNativeCheckpoint(cacheDirectory: string, checkpointFile: string) {
  const deadline = Date.now() + 30_000;
  const find = async (directory: string): Promise<string | undefined> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await find(candidate);
        if (found) return found;
      } else if (entry.name === '.building') {
        const state = await readFile(path.join(directory, 'state.json'), 'utf8')
          .then((contents: string) => JSON.parse(contents) as { files?: Record<string, unknown> })
          .catch(() => undefined);
        if (Object.keys(state?.files ?? {}).some((file) => path.basename(file) === checkpointFile))
          return candidate;
      }
    }
    return undefined;
  };
  while (Date.now() < deadline) {
    const building = await find(cacheDirectory).catch(() => undefined);
    if (building) return building;
    await Bun.sleep(10);
  }
  throw new Error(`Never observed a checkpoint for ${checkpointFile} in an actual ColGREP build.`);
}

async function findNativeBuildingFile(directory: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findNativeBuildingFile(candidate);
      if (found) return found;
    } else if (entry.name === '.building') {
      return candidate;
    }
  }
}

async function findNativeFile(directory: string, name: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findNativeFile(candidate, name);
      if (found) return found;
    } else if (entry.name === name) {
      return candidate;
    }
  }
}

async function waitForNativeBuildingFile(cacheDirectory: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const building = await findNativeBuildingFile(cacheDirectory);
    if (building) return building;
    await Bun.sleep(10);
  }
  throw new Error('Never observed an actual managed ColGREP build.');
}

function startStandalonePi(root: string, workspace: string, cacheDirectory: string) {
  const child = Bun.spawn([process.execPath, piFixture, 'calculate the checksum of input bytes'], {
    cwd: workspace,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: path.join(root, 'pi-agent'),
      LTCOOK_PI_AUTH_DIR: path.join(root, 'pi-auth'),
      LTCOOK_COLGREP_DEPLOYMENT: deploymentDirectory,
      LTCOOK_COLGREP_CACHE_DIR: cacheDirectory,
      PI_OFFLINE: '1',
      LTCOOK_NATIVE_AGENT_ID: '',
      LTCOOK_SESSION_ID: '',
      LTCOOK_WORKSPACE_MCP: '',
      LTCOOK_AGENT_API_TOKEN: '',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let cancellationSent = false;
  return {
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
    cancel() {
      if (cancellationSent || child.exitCode !== null) return;
      cancellationSent = true;
      child.stdin.write('cancel\n');
      child.stdin.end();
    },
  };
}

async function withWorkspaceMcp<T>(
  tool: ReturnType<typeof searchTool>,
  workspace: string,
  operation: (client: Client) => Promise<T>,
) {
  let mcp: WorkspaceMcp | undefined;
  const listener = createServer((request, response) => {
    if (!mcp) {
      response.writeHead(503).end();
      return;
    }
    void mcp.handle(request, response);
  });
  const client = new Client({ name: 'colgrep-system', version: '1' });
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('No MCP fixture port.');
    const authority = `127.0.0.1:${address.port}`;
    mcp = new WorkspaceMcp(new ToolCatalog([tool]), authority);
    const token = await mcp.grant('authorized-pi', workspace, false, true);
    const transport = new StreamableHTTPClientTransport(new URL(`http://${authority}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return await operation(client);
  } finally {
    await client.close();
    await mcp?.close();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}

test.skipIf(!deploymentDirectory)(
  'managed ColGREP searches and refreshes only the authorized worktree',
  async () =>
    withTemporaryDirectory(async (root) => {
      const workspace = path.join(root, 'workspace');
      const nested = path.join(workspace, 'nested');
      const sibling = path.join(root, 'sibling');
      const outside = path.join(root, 'outside.ts');
      await mkdir(nested, { recursive: true });
      const hooks = path.join(root, 'empty-hooks');
      await mkdir(hooks);
      await writeFile(path.join(workspace, '.gitignore'), 'excluded.ts\nignored-build-output/\n');
      await writeFile(path.join(workspace, 'main.ts'), code('mainOnlyChecksum'));
      await writeFile(path.join(nested, 'nested.ts'), code('nestedChecksum'));
      git(workspace, 'init', '--quiet');
      git(workspace, 'add', '.');
      git(
        workspace,
        '-c',
        'user.name=LTCook Test',
        '-c',
        'user.email=ltcook-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        `core.hooksPath=${hooks}`,
        'commit',
        '--quiet',
        '-m',
        'Start fixture',
      );
      git(workspace, 'worktree', 'add', '--quiet', '--detach', sibling);
      await writeFile(path.join(workspace, 'excluded.ts'), code('excludedChecksum'));
      await writeFile(path.join(workspace, 'soon-excluded.ts'), code('localOnlyChecksum'));
      const ignoredOutput = path.join(workspace, 'ignored-build-output');
      await mkdir(ignoredOutput);
      await writeFile(path.join(sibling, 'main.ts'), code('siblingOnlyChecksum'));
      await writeFile(outside, code('outsideOnlyChecksum'));
      await symlink(outside, path.join(nested, 'escape.ts'), 'file');

      const cacheDirectory = path.join(root, 'cache');
      const observer = createColgrepProvider({ deploymentDirectory, cacheDirectory });
      const parentWorkspace = await openRepositoryWorkspace(workspace);
      const siblingWorkspace = await openRepositoryWorkspace(sibling);
      expect(await observer.readStatus(parentWorkspace)).toMatchObject({
        availability: 'not-ready',
        activity: 'idle',
      });
      await expect(stat(cacheDirectory)).rejects.toHaveProperty('code', 'ENOENT');
      const tool = searchTool(cacheDirectory);
      const byName = (directory: string, pattern: string, paths?: string[]) =>
        search(tool, directory, { query: 'calculate checksum using bytes', pattern, paths });
      try {
        if (process.platform !== 'win32') await chmod(ignoredOutput, 0o000);
        await observer.buildIndex(parentWorkspace, new AbortController().signal);
      } finally {
        if (process.platform !== 'win32') await chmod(ignoredOutput, 0o700);
      }
      const cold = await byName(workspace, 'mainOnlyChecksum');
      expect(cold).toMatchObject({
        status: 'ready',
        results: [
          {
            path: 'main.ts',
            startLine: 1,
            excerpt: expect.stringContaining('mainOnlyChecksum'),
          },
        ],
      });
      expect(await byName(workspace, 'mainOnlyChecksum')).toMatchObject({
        status: 'ready',
        results: cold.results,
      });
      expect(await observer.readStatus(parentWorkspace)).toMatchObject({
        availability: 'ready',
        activity: 'idle',
      });
      expect(await observer.readStatus(siblingWorkspace)).toMatchObject({
        availability: 'not-ready',
        activity: 'idle',
      });
      await observer.buildIndex(siblingWorkspace, new AbortController().signal);
      expect(await byName(workspace, 'Checksum', ['nested'])).toMatchObject({
        status: 'ready',
        results: [{ path: 'nested/nested.ts' }],
      });
      expect(await byName(nested, 'nestedChecksum')).toMatchObject({
        status: 'ready',
        results: [{ path: 'nested.ts' }],
      });
      expect(await byName(nested, 'mainOnlyChecksum')).toMatchObject({
        status: 'ready',
        results: [],
      });
      expect(await byName(workspace, 'excludedChecksum|outsideOnlyChecksum')).toMatchObject({
        status: 'ready',
        results: [],
      });
      await expect(byName(nested, 'outsideOnlyChecksum', ['escape.ts'])).rejects.toThrow(
        /workspace|outside|symbolic link/i,
      );
      await expect(
        search(tool, nested, { query: outside, pattern: 'outsideOnlyChecksum' }),
      ).rejects.toThrow(/query|path/i);
      expect(await byName(sibling, 'siblingOnlyChecksum')).toMatchObject({
        status: 'ready',
        results: [{ path: 'main.ts' }],
      });
      expect(await byName(sibling, 'mainOnlyChecksum')).toMatchObject({
        status: 'ready',
        results: [],
      });
      expect(await byName(workspace, 'localOnlyChecksum')).toMatchObject({
        status: 'ready',
        results: [{ path: 'soon-excluded.ts' }],
      });
      await writeFile(path.join(workspace, '.git', 'info', 'exclude'), 'soon-excluded.ts\n');
      await observer.buildIndex(parentWorkspace, new AbortController().signal);
      expect(await byName(workspace, 'localOnlyChecksum')).toMatchObject({
        status: 'ready',
        results: [],
      });
      await writeFile(path.join(workspace, 'main.ts'), code('updatedMainChecksum'));
      expect(await byName(workspace, 'mainOnlyChecksum')).toMatchObject({
        status: 'ready',
        results: [],
      });
      await observer.buildIndex(parentWorkspace, new AbortController().signal);
      expect(await byName(workspace, 'updatedMainChecksum')).toMatchObject({
        status: 'ready',
        results: [{ path: 'main.ts' }],
      });
      expect(await byName(sibling, 'updatedMainChecksum')).toMatchObject({
        status: 'ready',
        results: [],
      });
    }),
  timeoutMs,
);

test.skipIf(!deploymentDirectory)(
  'repository search rejects a linked replacement and isolates a newly authorized directory',
  async () =>
    withTemporaryDirectory(async (root) => {
      const workspace = path.join(root, 'workspace');
      const prior = path.join(root, 'prior');
      const cacheDirectory = path.join(root, 'cache');
      const tool = searchTool(cacheDirectory);
      const builder = createColgrepProvider({ deploymentDirectory, cacheDirectory });
      await mkdir(workspace);
      await writeFile(path.join(workspace, 'checksum.ts'), code('priorChecksum'));
      const priorWorkspace = await openRepositoryWorkspace(workspace);
      await builder.buildIndex(priorWorkspace, new AbortController().signal);
      const priorGeneration = (await builder.readStatus(priorWorkspace)).generation;
      expect(
        await search(tool, workspace, { query: 'checksum', pattern: 'priorChecksum' }),
      ).toMatchObject({ status: 'ready', results: [{ path: 'checksum.ts' }] });

      await rename(workspace, prior);
      await symlink(prior, workspace, 'junction');
      await expect(
        search(tool, workspace, { query: 'checksum', pattern: 'priorChecksum' }),
      ).rejects.toThrow('The authorized workspace is unavailable.');
      await rm(workspace);

      await mkdir(workspace);
      await writeFile(path.join(workspace, 'checksum.ts'), code('replacementChecksum'));
      const replacementWorkspace = await openRepositoryWorkspace(workspace);
      expect(
        await search(tool, workspace, {
          query: 'checksum',
          mode: 'semantic',
          pattern: 'replacementChecksum',
        }),
      ).toMatchObject({ status: 'unavailable' });
      await builder.buildIndex(replacementWorkspace, new AbortController().signal);
      expect(
        await search(tool, workspace, { query: 'checksum', pattern: 'replacementChecksum' }),
      ).toMatchObject({ status: 'ready', results: [{ path: 'checksum.ts' }] });
      const replacementGeneration = (await builder.readStatus(replacementWorkspace)).generation;
      expect(replacementGeneration).not.toBe(priorGeneration);
    }),
  timeoutMs,
);

test.skipIf(!deploymentDirectory || process.platform !== 'linux')(
  'a resumed first build reindexes a checkpointed file changed with identical size and mtime',
  async () =>
    withTemporaryDirectory(async (root) => {
      const workspacePath = path.join(root, 'workspace');
      await mkdir(workspacePath);
      const checkpointName = 'source-000.ts';
      const checkpointPath = path.join(workspacePath, checkpointName);
      const checkpointSource = (version: 'Old' | 'New') =>
        Array.from({ length: 24 }, (_, unit) => code(`checkpointed${version}Token${unit}`)).join(
          '\n',
        );
      const originalTime = new Date('2026-01-02T03:04:05.000Z');
      await writeFile(checkpointPath, checkpointSource('Old'));
      await utimes(checkpointPath, originalTime, originalTime);
      const originalStat = await stat(checkpointPath, { bigint: true });
      await Promise.all(
        Array.from({ length: 299 }, (_, offset) => {
          const file = offset + 1;
          return writeFile(
            path.join(workspacePath, `source-${String(file).padStart(3, '0')}.ts`),
            Array.from({ length: 24 }, (_, unit) => code(`checksum${file}_${unit}`)).join('\n'),
          );
        }),
      );
      const workspace = await openRepositoryWorkspace(workspacePath);
      const options = { deploymentDirectory, cacheDirectory: path.join(root, 'cache') };
      const provider = createColgrepProvider(options);
      const abort = new AbortController();
      const running = provider.buildIndex(workspace, abort.signal);
      try {
        await findNativeCheckpoint(options.cacheDirectory, checkpointName);
      } finally {
        abort.abort();
        await expect(running).rejects.toThrow();
      }
      expect(await provider.readStatus(workspace)).toMatchObject({ availability: 'not-ready' });

      const changed = checkpointSource('New');
      expect(Buffer.byteLength(changed)).toBe(Number(originalStat.size));
      await writeFile(checkpointPath, changed);
      await utimes(checkpointPath, originalTime, originalTime);
      const changedStat = await stat(checkpointPath, { bigint: true });
      expect(changedStat.size).toBe(originalStat.size);
      expect(changedStat.mtimeNs).toBe(originalStat.mtimeNs);

      await provider.buildIndex(workspace, new AbortController().signal);
      expect(await provider.readStatus(workspace)).toMatchObject({ availability: 'ready' });
      const updated = await provider.search(
        workspace,
        { query: 'checkpointed new token', pattern: 'checkpointedNewToken' },
        new AbortController().signal,
      );
      expect(updated.value).toMatchObject({
        status: 'ready',
        hits: expect.arrayContaining([expect.objectContaining({ path: checkpointName })]),
      });
      const outdated = await provider.search(
        workspace,
        { query: 'checkpointed old token', pattern: 'checkpointedOldToken' },
        new AbortController().signal,
      );
      expect(outdated.value).toMatchObject({ status: 'ready', hits: [] });
    }),
  timeoutMs,
);

test.skipIf(!deploymentDirectory)(
  'standalone Pi publishes its authorized background build for workspace MCP searches',
  async () =>
    withTemporaryDirectory(async (root) => {
      const cacheDirectory = path.join(root, 'cache');
      const workspace = path.join(root, 'workspace');
      const corpus = path.join(workspace, 'corpus');
      await mkdir(corpus, { recursive: true });
      await writeFile(path.join(workspace, 'checksum.ts'), code('calculateChecksum'));
      await Promise.all(
        Array.from({ length: 300 }, (_, file) =>
          writeFile(
            path.join(corpus, `checksum-${file}.ts`),
            Array.from({ length: 24 }, (_, unit) => code(`calculateChecksum${file}_${unit}`)).join(
              '\n',
            ),
          ),
        ),
      );

      await withWorkspaceMcp(searchTool(cacheDirectory), workspace, async (client) => {
        const pi = startStandalonePi(root, workspace, cacheDirectory);
        const searchMcp = () =>
          client.callTool({
            name: REPO_SEARCH_TOOL_NAME,
            arguments: { query: 'calculate checksum using bytes', mode: 'semantic' },
          });
        try {
          await waitForNativeBuildingFile(cacheDirectory);
          expect((await searchMcp()).structuredContent).toMatchObject({
            status: 'unavailable',
            provider: 'colgrep',
            diagnostics: [
              expect.objectContaining({ source: 'colgrep', code: 'index-unavailable' }),
            ],
          });
          expect(pi.child.exitCode).toBeNull();
          expect(await pi.child.exited).toBe(0);
          expect(JSON.parse(await pi.stdout)).toMatchObject({
            provider: 'colgrep',
            status: 'ready',
          });
          const ready = await searchMcp();
          expect(ready.structuredContent).toMatchObject({
            status: 'ready',
            results: expect.arrayContaining([
              expect.objectContaining({ path: expect.any(String) }),
            ]),
          });
          const observer = createColgrepProvider({ deploymentDirectory, cacheDirectory });
          expect(await observer.readStatus(await openRepositoryWorkspace(workspace))).toMatchObject(
            {
              availability: 'ready',
            },
          );
        } finally {
          pi.cancel();
          await pi.child.exited;
          await pi.stdout;
          await pi.stderr;
        }
      });
    }),
  timeoutMs,
);

test.skipIf(!deploymentDirectory)(
  'a damaged published native index is invalidated and can be rebuilt',
  async () =>
    withTemporaryDirectory(async (root) => {
      const workspace = path.join(root, 'workspace');
      const cacheDirectory = path.join(root, 'cache');
      await mkdir(workspace);
      await writeFile(path.join(workspace, 'checksum.ts'), code('calculateChecksum'));
      const provider = createColgrepProvider({ deploymentDirectory, cacheDirectory });
      const workspaceIdentity = await openRepositoryWorkspace(workspace);
      await provider.buildIndex(workspaceIdentity, new AbortController().signal);
      const beforeDamagedReceipt = (await provider.readStatus(workspaceIdentity)).generation;
      const receiptFile = await findNativeFile(cacheDirectory, 'source.json');
      if (!receiptFile) throw new Error('Expected the published source observation.');
      await writeFile(receiptFile, 'invalid JSON');
      await provider.buildIndex(workspaceIdentity, new AbortController().signal);
      expect((await provider.readStatus(workspaceIdentity)).generation).not.toBe(
        beforeDamagedReceipt,
      );
      const indexFile = await findNativeFile(cacheDirectory, 'metadata.db');
      if (!indexFile) throw new Error('Expected the published native index metadata.');
      await rm(indexFile);
      expect(
        await provider.search(
          workspaceIdentity,
          { query: 'calculate checksum', mode: 'semantic' },
          new AbortController().signal,
        ),
      ).toMatchObject({ value: { status: 'unavailable' } });
      expect(await provider.readStatus(workspaceIdentity)).toMatchObject({
        availability: 'not-ready',
      });
      await provider.buildIndex(workspaceIdentity, new AbortController().signal);
      expect(await provider.readStatus(workspaceIdentity)).toMatchObject({
        availability: 'ready',
      });
      expect(
        await provider.search(
          workspaceIdentity,
          { query: 'calculate checksum', mode: 'semantic' },
          new AbortController().signal,
        ),
      ).toMatchObject({ value: { status: 'ready' } });
    }),
  timeoutMs,
);

test.skipIf(!deploymentDirectory)(
  'missing or altered managed ColGREP assets fail before indexing',
  async () =>
    withTemporaryDirectory(async (root) => {
      if (!deploymentDirectory) throw new Error('Managed deployment is required.');
      const workspace = path.join(root, 'workspace');
      const cacheDirectory = path.join(root, 'cache');
      const assets = path.join(root, 'assets');
      const manifest = JSON.parse(
        await readFile(path.join(deploymentDirectory, 'assets.json'), 'utf8'),
      ) as { library: string; model: string };
      await cp(deploymentDirectory, assets, { recursive: true });
      await mkdir(workspace);
      await writeFile(path.join(workspace, 'checksum.ts'), code('calculateChecksum'));

      const library = path.join(assets, manifest.library);
      await rm(library);
      expect(
        await search(searchTool(cacheDirectory, assets), workspace, { query: 'checksum' }),
      ).toMatchObject({ status: 'unavailable', hint: expect.stringMatching(/setup|repair/i) });
      await copyFile(path.join(deploymentDirectory, manifest.library), library);
      const extra = path.join(assets, manifest.model, 'unverified.txt');
      await writeFile(extra, 'unexpected model file');
      expect(
        await search(searchTool(cacheDirectory, assets), workspace, { query: 'checksum' }),
      ).toMatchObject({
        status: 'unavailable',
        hint: expect.stringMatching(/move unexpected files.*repeat LTCook setup/i),
      });
      await rm(extra);
      await writeFile(path.join(assets, manifest.model, 'tokenizer.json'), '{}');
      expect(
        await search(searchTool(cacheDirectory, assets), workspace, { query: 'checksum' }),
      ).toMatchObject({ status: 'unavailable', hint: expect.stringMatching(/setup|repair/i) });
      await expect(stat(cacheDirectory)).rejects.toHaveProperty('code', 'ENOENT');
    }),
  timeoutMs,
);
