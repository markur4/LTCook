import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
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
  args: { query: string; pattern?: string; paths?: string[]; limit?: number },
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

async function workspaceIndexDirectory(cacheDirectory: string, workspace: string) {
  const root = await realpath(workspace);
  const info = await stat(root, { bigint: true });
  const key = createHash('sha256')
    .update(root)
    .update('\0')
    .update(`${info.dev}:${info.ino}`)
    .digest('hex');
  return path.join(cacheDirectory, key, 'indices');
}

async function waitForInitialBuild(indexes: string, pi: ReturnType<typeof startStandalonePi>) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && pi.child.exitCode === null) {
    const entries = await readdir(indexes, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const index = path.join(indexes, entry.name);
      if (await stat(path.join(index, '.building')).catch(() => undefined)) return index;
    }
    await Bun.sleep(10);
  }
  const failure = pi.child.exitCode === null ? '' : await pi.stderr;
  throw new Error(`Never observed an actual ColGREP initial build. ${failure}`);
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
      await writeFile(path.join(workspace, '.gitignore'), 'excluded.ts\n');
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
      await writeFile(path.join(workspace, 'main.ts'), code('updatedMainChecksum'));
      expect(await byName(workspace, 'mainOnlyChecksum')).toMatchObject({
        status: 'ready',
        results: [],
      });
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
      await mkdir(workspace);
      await writeFile(path.join(workspace, 'checksum.ts'), code('priorChecksum'));
      const priorIndex = await workspaceIndexDirectory(cacheDirectory, workspace);
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
      expect(
        await search(tool, workspace, { query: 'checksum', pattern: 'replacementChecksum' }),
      ).toMatchObject({ status: 'ready', results: [{ path: 'checksum.ts' }] });
      expect(await readdir(priorIndex)).not.toHaveLength(0);
      const newIndex = await workspaceIndexDirectory(cacheDirectory, workspace);
      expect(await readdir(newIndex)).not.toHaveLength(0);
      expect(newIndex).not.toBe(priorIndex);
    }),
  timeoutMs,
);

test.skipIf(!deploymentDirectory || process.platform !== 'linux')(
  'Activity observes an actual managed index build and clears activity on cancellation',
  async () =>
    withTemporaryDirectory(async (root) => {
      const workspacePath = path.join(root, 'workspace');
      await mkdir(workspacePath);
      await Promise.all(
        Array.from({ length: 140 }, (_, file) =>
          writeFile(
            path.join(workspacePath, `source-${file}.ts`),
            Array.from({ length: 24 }, (_, unit) => code(`checksum${file}_${unit}`)).join('\n'),
          ),
        ),
      );
      const workspace = await openRepositoryWorkspace(workspacePath);
      const options = { deploymentDirectory, cacheDirectory: path.join(root, 'cache') };
      const writer = createColgrepProvider(options);
      const observer = createColgrepProvider(options);
      const abort = new AbortController();
      const running = writer.buildIndex(workspace, abort.signal).then(
        () => 'completed',
        () => 'interrupted',
      );
      try {
        let status = await observer.readStatus(workspace);
        for (let attempt = 0; attempt < 160 && status.activity !== 'indexing'; attempt++) {
          await Bun.sleep(50);
          status = await observer.readStatus(workspace);
        }
        expect(status).toMatchObject({ availability: 'not-ready', activity: 'indexing' });
      } finally {
        abort.abort();
        expect(await running).toBe('interrupted');
      }
      expect((await observer.readStatus(workspace)).activity).toBe('interrupted');
    }),
  timeoutMs,
);

test.skipIf(!deploymentDirectory)(
  'standalone Pi and workspace MCP share the native lock and can retry after cancellation',
  async () =>
    withTemporaryDirectory(async (root) => {
      const cacheDirectory = path.join(root, 'cache');
      const workspace = path.join(root, 'workspace');
      const corpus = path.join(workspace, 'corpus');
      await mkdir(corpus, { recursive: true });
      await writeFile(path.join(workspace, 'checksum.ts'), code('calculateChecksum'));
      await Promise.all(
        Array.from({ length: 140 }, (_, file) =>
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
            arguments: { query: 'calculate checksum using bytes', pattern: 'calculateChecksum\\b' },
          });
        try {
          const indexes = await workspaceIndexDirectory(cacheDirectory, workspace);
          const index = await waitForInitialBuild(indexes, pi);
          expect((await searchMcp()).structuredContent).toMatchObject({
            status: 'indexing',
            partial: true,
            provider: 'colgrep',
            diagnostics: [{ source: 'colgrep', code: 'indexing' }],
          });
          expect(pi.child.exitCode).toBeNull();
          pi.cancel();
          expect(await pi.child.exited).toBe(1);
          expect(await pi.stderr).toMatch(/cancel/i);
          await rm(corpus, { recursive: true });
          const ready = await searchMcp();
          expect(ready.structuredContent).toMatchObject({
            status: 'ready',
            results: [{ path: 'checksum.ts' }],
          });
          await expect(stat(path.join(index, '.building'))).rejects.toHaveProperty(
            'code',
            'ENOENT',
          );
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
  'a broken native index lock produces a storage diagnostic',
  async () =>
    withTemporaryDirectory(async (root) => {
      const workspace = path.join(root, 'workspace');
      const cacheDirectory = path.join(root, 'cache');
      await mkdir(workspace);
      await writeFile(path.join(workspace, 'checksum.ts'), code('calculateChecksum'));
      const tool = searchTool(cacheDirectory);
      const run = () => search(tool, workspace, { query: 'calculate checksum' });
      expect(await run()).toMatchObject({ status: 'ready' });
      const indexes = await workspaceIndexDirectory(cacheDirectory, workspace);
      const [indexName] = await readdir(indexes);
      if (!indexName) throw new Error('Expected the native index.');
      const lock = path.join(indexes, indexName, '.lock');
      await rm(lock);
      await mkdir(lock);
      expect(await run()).toMatchObject({
        status: 'unavailable',
        hint: expect.stringMatching(/lock|storage|cache/i),
      });
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
      const indexes = await workspaceIndexDirectory(cacheDirectory, workspace);
      expect(await readdir(indexes).catch(() => [])).toEqual([]);
    }),
  timeoutMs,
);
