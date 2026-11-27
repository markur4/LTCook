import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { redactDiagnosticText } from '../diagnostics/telemetry.js';

export interface BugHunterIssueDraft {
  id: string;
  title: string;
  body: string;
}

export interface BugHunterIssueEntry {
  draft: BugHunterIssueDraft;
  status: 'pending' | 'uncertain' | 'published';
  url?: string;
  failure?: string;
}

type IssueCommand = { cwd: string; args: string[]; signal: AbortSignal };

interface IssueReporterOptions {
  repository: { root: string; slug: string };
  load(): BugHunterIssueEntry[] | undefined;
  save(entries: BugHunterIssueEntry[]): void;
  authorize(draft: BugHunterIssueDraft): void | boolean;
  run?(input: IssueCommand): Promise<string>;
}

const exec = promisify(execFile);
const inventoryLimit = 500;
const issueList = z.array(z.object({ title: z.string(), body: z.string(), url: z.string() }));
const draftSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._:-]{1,256}$/),
  title: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .regex(/^[^\r\n\u0000]+$/),
  body: z
    .string()
    .trim()
    .min(1)
    .max(32_768)
    .refine((value) => !value.includes('\0')),
});

async function runGh({ cwd, args, signal }: IssueCommand) {
  const { stdout } = await exec('gh', args, {
    cwd,
    signal,
    timeout: 20_000,
    maxBuffer: 8_388_608,
    env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' },
  });
  return stdout;
}

/** Publishes caller-approved issue content and retains unsettled effects in the coordination owner. */
export function createBugHunterIssueReporter(options: IssueReporterOptions) {
  const { root } = options.repository;
  const slug = options.repository.slug.toLowerCase();
  if (
    !path.isAbsolute(root) ||
    !/^[a-z0-9-]+\/[a-z0-9_.-]+$/.test(slug) ||
    /\/(?:\.|\.\.)$/.test(slug)
  )
    throw new Error('Issue publication requires a verified GitHub repository.');
  const run = options.run ?? runGh;
  const githubRepository = `github.com/${slug}`;
  let queue = Promise.resolve();
  const list = () => structuredClone(options.load() ?? []);

  function persist(entry: BugHunterIssueEntry) {
    const current = list();
    const index = current.findIndex(({ draft }) => draft.id === entry.draft.id);
    if (index < 0) current.push(entry);
    else current[index] = entry;
    options.save(current);
    return structuredClone(entry);
  }

  function issueUrl(value: string) {
    const url = new URL(value.trim());
    if (
      url.origin !== 'https://github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.toLowerCase().startsWith(`/${slug}/issues/`) ||
      !/^[1-9]\d*$/.test(url.pathname.slice(slug.length + '/issues/'.length + 1))
    )
      throw new Error('GitHub did not return an issue in the approved repository.');
    return url.href;
  }

  async function lookup(draft: BugHunterIssueDraft, marker: string, signal: AbortSignal) {
    const issues = issueList.parse(
      JSON.parse(
        await run({
          cwd: root,
          args: [
            'issue',
            'list',
            '--repo',
            githubRepository,
            '--state',
            'all',
            '--limit',
            String(inventoryLimit),
            '--json',
            'title,body,url',
          ],
          signal,
        }),
      ),
    );
    const markers = issues.filter(({ body }) => body.split(/\r?\n/).includes(marker));
    const matches = markers.length
      ? markers
      : issues.filter(({ title }) => title.trim() === draft.title);
    if (matches.length > 1) throw new Error('Several issues matched the finding.');
    if (matches[0]) return issueUrl(matches[0].url);
    if (issues.length >= inventoryLimit)
      throw new Error('The bounded issue inventory could not establish uniqueness.');
  }

  async function publishDraft(input: BugHunterIssueDraft, signal: AbortSignal) {
    signal.throwIfAborted();
    const draft = draftSchema.parse({
      ...input,
      title: redactDiagnosticText(input.title),
      body: redactDiagnosticText(input.body),
    });
    const previous = list().find((row) => row.draft.id === draft.id);
    if (previous?.status === 'published') return previous;
    const entry = previous ?? { draft, status: 'pending' as const };
    if (previous && (previous.draft.title !== draft.title || previous.draft.body !== draft.body))
      return persist({
        ...previous,
        failure: 'The stored issue draft differs from the current finding.',
      });
    if (!previous) persist(entry);
    const key = createHash('sha256').update(`${slug}\0${draft.id}`).digest('hex');
    const marker = `<!-- ltcook-bughunter:${key} -->`;

    if ((await realpath(root).catch(() => undefined)) !== root)
      return persist({ ...entry, failure: 'The verified publication workspace is unavailable.' });
    try {
      const existing = await lookup(draft, marker, signal);
      if (existing) return persist({ draft, status: 'published', url: existing });
    } catch {
      return persist({
        ...entry,
        failure: 'The open and closed issue lookup could not establish a unique result.',
      });
    }
    if (entry.status === 'uncertain')
      return persist({
        ...entry,
        failure: 'The earlier publication remains uncertain. No duplicate was created.',
      });

    let temporary: string | undefined;
    try {
      temporary = await mkdtemp(path.join(tmpdir(), 'ltcook-issue-'));
      const body = path.join(temporary, 'issue.md');
      await writeFile(body, `${draft.body}\n\n${marker}\n`, { mode: 0o600 });
      signal.throwIfAborted();
      try {
        if (options.authorize(draft) === false) throw new Error('Denied');
      } catch {
        return persist({ ...entry, failure: 'Issue publication is not currently authorized.' });
      }
      persist({ draft, status: 'uncertain' });
      let url: string;
      try {
        url = issueUrl(
          await run({
            cwd: root,
            args: [
              'issue',
              'create',
              '--repo',
              githubRepository,
              '--title',
              draft.title,
              '--body-file',
              body,
            ],
            signal,
          }),
        );
      } catch {
        return persist({
          draft,
          status: 'uncertain',
          failure: 'GitHub did not confirm the issue creation.',
        });
      }
      return persist({ draft, status: 'published', url });
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }

  function publish(draft: BugHunterIssueDraft, { signal }: { signal: AbortSignal }) {
    const operation = queue.then(() => publishDraft(draft, signal));
    queue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  return { publish, list };
}
