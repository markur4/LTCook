import { expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createBugHunterIssueReporter,
  type BugHunterIssueEntry,
} from '../../../runtime/src/services/bughunter-issues.js';

const draft = {
  id: 'hunt-1:finding-0',
  title: 'Repair index progress detection',
  body: 'Area: runtime/src/services/repository-index.ts\nAuthorization: Bearer example-private-value',
};
const issueUrl = 'https://github.com/example/fixture/issues/4';
const signal = new AbortController().signal;

async function inWorkspace(callback: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ltcook-issue-test-')));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('reconciles an uncertain issue by marker after restart without creating a duplicate', async () => {
  await inWorkspace(async (root) => {
    let saved: BugHunterIssueEntry[] = [];
    let publishedBody: string | undefined;
    let available = false;
    let writes = 0;
    const options: Parameters<typeof createBugHunterIssueReporter>[0] = {
      repository: { root, slug: 'example/fixture' },
      load: () => saved,
      save: (rows) => {
        saved = structuredClone(rows);
      },
      authorize: () => true,
      async run({ args }) {
        if (args[1] === 'list')
          return JSON.stringify(
            available
              ? [
                  {
                    title: 'The maintainers renamed this issue',
                    body: publishedBody,
                    url: issueUrl,
                  },
                ]
              : [],
          );
        expect(saved[0]?.status).toBe('uncertain');
        expect(args).toContain('--body-file');
        publishedBody = await readFile(args.at(-1)!, 'utf8');
        writes++;
        throw new Error('connection closed after request');
      },
    };
    expect(await createBugHunterIssueReporter(options).publish(draft, { signal })).toMatchObject({
      status: 'uncertain',
    });
    expect(publishedBody).not.toContain('example-private-value');
    expect(JSON.stringify(saved)).not.toContain('example-private-value');
    expect(await createBugHunterIssueReporter(options).publish(draft, { signal })).toMatchObject({
      status: 'uncertain',
    });
    available = true;
    expect(await createBugHunterIssueReporter(options).publish(draft, { signal })).toMatchObject({
      status: 'published',
      url: issueUrl,
    });
    expect(writes).toBe(1);
  });
});

test('reuses a matching existing issue and rechecks permission immediately before a new write', async () => {
  await inWorkspace(async (root) => {
    let saved: BugHunterIssueEntry[] = [];
    let existing = true;
    let currentGrant = true;
    const reporter = createBugHunterIssueReporter({
      repository: { root, slug: 'example/fixture' },
      load: () => saved,
      save: (rows) => {
        saved = rows;
      },
      authorize: () => currentGrant,
      async run({ args }) {
        if (args[1] !== 'list') throw new Error('The test must never publish an issue');
        expect(args).toContain('all');
        currentGrant = false;
        return JSON.stringify(existing ? [{ title: draft.title, body: '', url: issueUrl }] : []);
      },
    });
    expect(await reporter.publish(draft, { signal })).toMatchObject({
      status: 'published',
      url: issueUrl,
    });
    existing = false;
    const next = { ...draft, id: 'second', title: 'Another finding' };
    expect(await reporter.publish(next, { signal })).toMatchObject({
      status: 'pending',
      failure: expect.stringContaining('not currently authorized'),
    });
    expect(reporter.list()).toHaveLength(2);
  });
});
