import { candidateScreeningFixtures } from '../../../evals/session-memory-screening.js';
import { manifestApprovalControls } from '../../../evals/session-memory-approval.js';
import { expect, test } from 'bun:test';
import { MemoryEditProgress } from '../../../evals/session-memory-edit-progress.js';
import { semanticMemoryFixtures } from '../../../evals/session-memory-semantic-fixtures.js';
import {
  originalTokenCount,
  shortDiscussionTokens,
} from '../../../runtime/src/session-memory/service.js';
import { identifyMemoryUnits } from '../../../runtime/src/session-memory/units.js';
import { contextTranscript, gradesMemoryFact } from '../../../evals/session-memory-context.js';
import {
  gradeSimplifiedLayer,
  simplifiedCorpus,
} from '../../../evals/session-memory-simplified.js';
import {
  contradictsMemoryFact,
  matchesMemoryFact,
} from '../../../runtime/src/evals/session-memory-facts.js';
import { prepareMemorySummaries } from '../../../runtime/src/session-memory/summarization.js';
import { memoryFixtures } from '../../../runtime/src/evals/session-memory-fixtures.js';

test('manifest approval controls isolate the rendered cue, history and instructions', () => {
  const fixture = semanticMemoryFixtures.find(({ id }) => id === 'semantic-manifest-reference')!;
  const [rendered] = prepareMemorySummaries(
    { type: 'UAMP', messages: fixture.turns[2]!, task: fixture.taskContext },
    [
      {
        id: 'proposal',
        type: 'UAMP',
        content: 'Earlier proposal: reuseExportManifest. Awaiting a decision.',
      },
    ],
    undefined,
    { format: 'markdown' },
  );
  const [system, user] = rendered!.prompt;
  const [withoutHistory, explicit, rules, reorder] = manifestApprovalControls(
    system.content,
    user.content,
  );
  const taskStart = user.content.indexOf('\nCurrent Task scope and requirements.');
  expect(withoutHistory).toMatchObject({
    system: system.content,
    user: user.content.slice(taskStart),
  });
  expect(withoutHistory!.user).toContain('Implement that proposal.');
  expect(explicit!.system).toBe(system.content);
  expect(
    explicit!.user.replace(
      'Implement reuseExportManifest for the manifest refresh.',
      'Implement that proposal.',
    ),
  ).toBe(user.content);
  expect(rules!.user).toBe(user.content);
  expect(rules!.system.endsWith(system.content)).toBe(true);
  expect(reorder!.user).toBe(user.content);
  expect(reorder!.system.indexOf('**Decisions**')).toBeLessThan(
    reorder!.system.indexOf('**Intent**'),
  );
});

test('grades multiline named results without borrowing the status of another check', () => {
  const fact = memoryFixtures
    .flatMap(({ facts }) => facts)
    .find(({ check }) => check === 'PI_REWIND_PROVIDER_ID')!;
  const output = `{
    "results": [
      {"test":"PI_REWIND_PROVIDER_ID","status":"PASS"},
      {"test":"PRUNED_CITATION_LOOKUP","status":"FAIL"}
    ],
    "issues": "First failing assertion preceded PI_REWIND_PROVIDER_ID PASS."
  }`;
  expect(gradesMemoryFact(fact, { seq: fact.source, text: output })).toBe(true);
  expect(gradesMemoryFact(fact, { seq: fact.source + 1, text: output })).toBe(false);
  expect(contradictsMemoryFact(fact, output)).toBe(false);
  expect(matchesMemoryFact(fact, 'PI_REWIND_PROVIDER_ID:\nPASS')).toBe(true);
  expect(matchesMemoryFact(fact, 'EXTRA_PI_REWIND_PROVIDER_ID PASS')).toBe(false);
  expect(
    matchesMemoryFact(fact, '{"results":[{"test":"PI_REWIND_PROVIDER_ID"},{"status":"PASS"}]}'),
  ).toBe(false);
  expect(
    contradictsMemoryFact(fact, '{"results":[{"test":"PI_REWIND_PROVIDER_ID","status":"FAILED"}]}'),
  ).toBe(true);
  expect(
    contradictsMemoryFact(fact, 'PI_REWIND_PROVIDER_ID PASS. PRUNED_CITATION_LOOKUP FAIL.'),
  ).toBe(false);
});

test('stops an alternating tool loop and gives changed results room to progress', () => {
  const progress = new MemoryEditProgress();
  const read = (text: string) => progress.record('read', { path: 'a.ts' }, { text });
  const search = () => progress.record('session_memory', { query: 'cache' }, { matches: [] });
  expect(read('before')).toBe(false);
  expect(search()).toBe(false);
  expect(read('before')).toBe(false);
  expect(search()).toBe(false);
  expect(read('after')).toBe(false);
  expect(search()).toBe(false);
  expect(read('after')).toBe(false);
  expect(search()).toBe(true);
});

test('requires the complete critical Session Memory corpus', () => {
  const corpus = simplifiedCorpus();
  expect(corpus).toHaveLength(5);
  expect(corpus.flatMap(({ facts }) => facts).filter(({ critical }) => critical)).toHaveLength(14);
});

test('records recovery separately and rejects attributed reversals and invented outcomes', () => {
  const fixture = simplifiedCorpus().find(({ id }) => id === 'runtime-rebuild-and-cache-recovery')!;
  const originals = fixture.turns.flat();
  const facts = fixture.facts.filter(({ critical }) => critical);
  const entries = originals.filter(({ seq }) => [5, 8].includes(seq));
  expect(gradeSimplifiedLayer(facts, entries, originals)).toMatchObject({
    retained: 3,
    required: 3,
    passed: true,
  });
  expect(gradeSimplifiedLayer(facts, entries.slice(1), originals)).toMatchObject({
    retained: 1,
    required: 3,
    passed: false,
  });
  const fabricated = [...entries, { seq: 8, text: 'CACHE_OPEN_RESTART PASS. EXTRA_CHECK PASS.' }];
  expect(gradeSimplifiedLayer(facts, fabricated, originals)).toMatchObject({
    contradictions: [
      { sources: [8], name: 'CACHE_OPEN_RESTART', status: 'pass' },
      { sources: [8], name: 'EXTRA_CHECK', status: 'pass' },
    ],
    retained: 3,
    passed: false,
  });
});

test('semantic fixtures actually generate UAMP summaries and carry critical labels', () => {
  for (const fixture of semanticMemoryFixtures) {
    const { messages, prompts } = contextTranscript(fixture);
    const units = identifyMemoryUnits(messages, prompts, 3000, true);
    const generated = units.filter(
      ({ type, messages }) =>
        type === 'UAMP' && originalTokenCount(messages) >= shortDiscussionTokens,
    );
    expect(generated.length).toBeGreaterThan(0);
    for (const fact of fixture.facts.filter(({ critical }) => critical)) {
      expect(
        generated.some(({ messages }) => messages.some(({ seq }) => seq === fact.source)),
      ).toBe(true);
    }
  }
});

test('semantic grading accepts the named failure and reads a nonbreaking retry hyphen', () => {
  const [preview, retry] = semanticMemoryFixtures;
  const failure = preview!.facts.find(({ check }) => check === 'EXPORT_MISSING_HEADER')!;
  expect(matchesMemoryFact(failure, 'EXPORT_QUOTED_ROW PASS. EXPORT_MISSING_HEADER FAIL.')).toBe(
    true,
  );
  expect(
    contradictsMemoryFact(failure, 'EXPORT_QUOTED_ROW PASS. EXPORT_MISSING_HEADER FAIL.'),
  ).toBe(false);
  expect(contradictsMemoryFact(failure, 'EXPORT_MISSING_HEADER PASS.')).toBe(true);
  expect(matchesMemoryFact(retry!.facts[0]!, 'Approved a 45‑second reporting retry delay.')).toBe(
    true,
  );
  expect(contradictsMemoryFact(retry!.facts[0]!, 'Approved a 10‑second delay.')).toBe(true);
});

test('keeps the generated anchor when an original preview would lose its technical referent', () => {
  const [part] = prepareMemorySummaries(
    { type: 'UAMP', messages: [{ seq: 4, author: 'user', text: 'Implement that.' }] },
    [
      {
        id: 'proposal',
        type: 'UAMP',
        format: 'markdown',
        content: '**Intent**\n- Consider reuseExportManifest for unchanged exports.',
      },
    ],
    undefined,
    {
      format: 'markdown',
      skipped: [
        { id: 'clarification', messages: [{ seq: 3, author: 'agent', text: 'Still a proposal.' }] },
      ],
      originalAnchor:
        'Long original prefix. '.repeat(180) + 'Agent #2: Consider reuseExportManifest.',
    },
  );
  expect(part?.historyText).toContain('reuseExportManifest');
  expect(part?.historyText).toContain('Still a proposal.');
  expect(part?.historyText).not.toContain('Long original prefix.');
  expect(part?.historyEstimatedTokens).toBeLessThanOrEqual(512);
});

test('screening accepts an equivalent attempt limit and rejects a stale approval status', () => {
  const fixtures = candidateScreeningFixtures();
  const limit = fixtures
    .flatMap(({ facts }) => facts)
    .find(({ label }) => label === 'retain three attempts')!;
  expect(matchesMemoryFact(limit, 'The maximum attempts remain at three.')).toBe(true);
  expect(matchesMemoryFact(limit, 'The maximum attempts remain at ten.')).toBe(false);
  const approval = fixtures
    .flatMap(({ facts }) => facts)
    .find(({ label }) => label === 'the later approval names the proposed implementation')!;
  expect(
    contradictsMemoryFact(
      approval,
      'Use reuseExportManifest. This is a proposal awaiting your decision.',
    ),
  ).toBe(true);
});

test('manifest screening fails a complete summary that leaves explicit approval pending', () => {
  const { facts, turns } = candidateScreeningFixtures().find(
    ({ id }) => id === 'semantic-manifest-reference',
  )!;
  const proposal = {
    seq: 2,
    sources: [1, 2],
    text: 'The proposal is to use reuseExportManifest. Approval is still pending.',
  };
  const approval = {
    seq: 6,
    sources: [5, 6],
    text: 'The user approved reuseExportManifest. Keep the exporter API stable. Do not delete old manifests.',
  };
  const originals = turns.flat();
  expect(gradeSimplifiedLayer(facts, [proposal, approval], originals)).toMatchObject({
    retained: 4,
    required: 4,
    passed: true,
  });
  for (const staleStatus of [
    'This is a proposal awaiting your decision.',
    'Approval is still pending.',
  ]) {
    const staleApproval = { ...approval, text: approval.text + ' ' + staleStatus };
    const result = gradeSimplifiedLayer(facts, [proposal, staleApproval], originals);
    expect(result).toMatchObject({ retained: 4, required: 4, passed: false });
    expect(
      result.facts.find(({ source, contradicted }) => source === 5 && contradicted)?.label,
    ).toBe('the later approval names the proposed implementation');
  }
});
