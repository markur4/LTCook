import { createHash } from 'node:crypto';
import type { ExpectedRepositoryFact } from './repository-behavior-grade.js';

type FactAnchor = Omit<ExpectedRepositoryFact, 'evidence'> & {
  path: string;
  lines: readonly string[];
};

const cases = [
  {
    id: 'workspace-grant',
    question: [
      'Trace repository-tool access from the authenticated launch to a later workspace tool call.',
      'Give the grant HTTP route (grantRoute), the other native provider besides Pi that receives repository search access (otherProvider), and the error returned if the workspace directory no longer has its original identity (workspaceError).',
      'Give the identifier passed to Locate in the system fixture that exercises ordinary Codex’s lexical lookup (fixtureSymbol).',
    ].join(' '),
    facts: [
      {
        id: 'grantRoute',
        value: '/v1/mcp/grant',
        path: 'runtime/src/paseo-plugin/index.server.ts',
        lines: ["await runtimeJson('/v1/mcp/grant', {"],
      },
      {
        id: 'otherProvider',
        value: 'codex',
        path: 'runtime/src/integrations/runtime-api.ts',
        lines: ["const workspaceFileAccess = provider === 'pi' || provider === 'codex';"],
      },
      {
        id: 'workspaceError',
        value: 'The authorized workspace is no longer available.',
        path: 'runtime/src/integrations/mcp.ts',
        lines: [
          'directoryIdentity(grant.workspaceRoot) !== grant.workspaceIdentity',
          ') {',
          "throw new Error('The authorized workspace is no longer available.');",
        ],
      },
      {
        id: 'fixtureSymbol',
        value: 'releaseRetryLimit',
        path: 'tests/runtime/system/paseo-workspace-mcp.ts',
        lines: [
          "'codex_locate_ripgrep',",
          "{ symbol: 'releaseRetryLimit', filter: { includePaths: [retryPath] } },",
        ],
      },
    ],
  },
  {
    id: 'paste-projection',
    question: [
      'Trace a long chat paste into Session Memory and check what happens if its signed bytes are altered.',
      'Give the internal HTTP route used when the user pastes (pasteRoute), the native timeline projection mode used before interpreting messages (timelineProjection), and the name of the constant-time comparison function that validates pasted text (signatureComparison).',
      'Give the number of attachments the regression test expects after modifying the signed text (tamperedAttachmentCount).',
    ].join(' '),
    facts: [
      {
        id: 'pasteRoute',
        value: '/v1/session-memory/paste',
        path: 'runtime/src/paseo-plugin/index.server.ts',
        lines: ["await runtimeJson('/v1/session-memory/paste', { text: query }),"],
      },
      {
        id: 'timelineProjection',
        value: 'canonical',
        path: 'runtime/src/integrations/paseo-memory.ts',
        lines: ["projection: 'canonical',", 'cursor,'],
      },
      {
        id: 'signatureComparison',
        value: 'timingSafeEqual',
        path: 'runtime/src/session-memory/pasted-documents.ts',
        lines: [
          "if (!timingSafeEqual(this.signature(id, text), Buffer.from(signature, 'hex'))) return false;",
        ],
      },
      {
        id: 'tamperedAttachmentCount',
        value: 0,
        path: 'tests/runtime/unit/session-memory.test.ts',
        lines: ['expect(tampered.attachments).toEqual([]);'],
      },
    ],
  },
  {
    id: 'runtime-log-owner',
    question: [
      'Trace the runtime backend log from Python process launch to TypeScript runtime registration and onward to the Paseo child.',
      'Give the log’s basename (logName), the environment key Python uses to pass its full path (pathVariable), the TypeScript validation error for a linked, non-regular, or out-of-deployment target (targetError), and whether the Paseo child inherits that key (paseoInheritsPath).',
    ].join(' '),
    facts: [
      {
        id: 'logName',
        value: 'backend.log',
        path: 'src/ltcook/_runtime_client.py',
        lines: ['return deployment.resolve() / "logs" / "backend.log"'],
      },
      {
        id: 'pathVariable',
        value: 'LTCOOK_BACKEND_LOG_PATH',
        path: 'src/ltcook/_runtime_client.py',
        lines: ['child_environment["LTCOOK_BACKEND_LOG_PATH"] = str(path)'],
      },
      {
        id: 'targetError',
        value: 'LTCOOK_BACKEND_LOG_PATH must be a regular file inside the deployment.',
        path: 'runtime/src/main.ts',
        lines: [
          "throw new Error('LTCOOK_BACKEND_LOG_PATH must be a regular file inside the deployment.');",
        ],
      },
      {
        id: 'paseoInheritsPath',
        value: false,
        path: 'runtime/src/integrations/paseo.ts',
        lines: ['delete env.LTCOOK_BACKEND_LOG_PATH;'],
      },
    ],
  },
] satisfies readonly { id: string; question: string; facts: readonly FactAnchor[] }[];

export function repositoryTraversalCases(files: ReadonlyMap<string, string>) {
  return cases.map(({ id, question, facts }) => ({
    id,
    question,
    expectedFacts: facts.map(({ id, value, path, lines }): ExpectedRepositoryFact => {
      const source = files
        .get(path)
        ?.split('\n')
        .map((line) => line.trim());
      const anchors = source?.flatMap((_, index) =>
        lines.every((line, offset) => source[index + offset] === line) ? [index + 1] : [],
      );
      const startLine = anchors?.[0];
      if (startLine === undefined || anchors?.length !== 1)
        throw new Error(`Traversal evidence for ${id} is missing or ambiguous in ${path}.`);
      return { id, value, evidence: { path, startLine, endLine: startLine + lines.length - 1 } };
    }),
  }));
}

export async function repositoryTraversalSnapshot(checkout: string) {
  const git = Bun.which('git');
  if (!git) throw new Error('The traversal evaluation needs Git on PATH.');
  const run = (args: string[]) => {
    const result = Bun.spawnSync([git, ...args], { cwd: checkout, timeout: 30_000 });
    if (result.exitCode !== 0)
      throw new Error(`Git ${args[0]} could not prepare traversal source.`);
    return result.stdout;
  };
  const revision = run(['rev-parse', 'HEAD']).toString().trim();
  // > Keep evaluation prompts and labels outside the material the agents can search.
  const archive = run([
    'archive',
    '--format=tar',
    revision,
    'runtime',
    'src',
    'teams',
    'services',
    'tests',
    'justfile',
    'package.json',
    '.gitignore',
  ]);
  const entries = await new Bun.Archive(archive).files();
  const files = new Map(
    await Promise.all([...entries].map(async ([path, file]) => [path, await file.text()] as const)),
  );
  return {
    revision,
    files,
    archiveSha256: createHash('sha256').update(archive).digest('hex'),
  };
}
