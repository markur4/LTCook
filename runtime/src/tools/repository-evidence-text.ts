import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import type { RepositoryHit } from '../repository/results.js';
import { REPO_LOCATE_TOOL_NAME, RepositoryLocateOutputSchema } from './repo-locate.js';
import { REPO_SEARCH_TOOL_NAME, RepositorySearchOutputSchema } from './repo-search.js';

function escapeControls(text: string): string {
  return text.replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function formatHit({ excerpt, ...location }: RepositoryHit): string {
  const lines = excerpt.split('\n');
  if (location.excerptTruncated && lines.at(-1) === '') lines.pop();
  const numbered = lines.map(
    (line, index) => `${location.startLine + index} | ${escapeControls(line)}`,
  );
  return [
    escapeControls(JSON.stringify(location)),
    ...numbered,
    ...(location.excerptTruncated
      ? [
          excerpt.endsWith('\n')
            ? '[Excerpt clipped. Further source lines are omitted.]'
            : '[Excerpt clipped. The final displayed line may be incomplete.]',
        ]
      : []),
  ].join('\n');
}

type LocateSearch = Static<typeof RepositoryLocateOutputSchema>['searches'][number];

function formatSearch({
  results,
  connections,
  ...metadata
}: Static<typeof RepositorySearchOutputSchema> & {
  connections?: LocateSearch['connections'];
}) {
  const header = results ? { ...metadata, hitCount: results.length } : metadata;
  const sections = [escapeControls(JSON.stringify(header))];
  let role: string | undefined;
  for (const hit of results ?? []) {
    if ('role' in hit && typeof hit.role === 'string' && hit.role !== role) {
      role = hit.role;
      sections.push(`${role.charAt(0).toUpperCase()}${role.slice(1)} candidates`);
    }
    sections.push(formatHit(hit));
  }
  for (const { kind, from, to } of connections ?? []) {
    sections.push(`Verified ${kind} connection`, formatHit(from), formatHit(to));
  }
  return sections.join('\n\n');
}

/** Render numbered source lines for the agent while callers retain the structured output. */
export function repositoryEvidenceText(name: string, output: unknown): string {
  if (name === REPO_SEARCH_TOOL_NAME && Value.Check(RepositorySearchOutputSchema, output))
    return formatSearch(output);
  if (name === REPO_LOCATE_TOOL_NAME && Value.Check(RepositoryLocateOutputSchema, output)) {
    if (output.trace) {
      const { leads, connections, evidence } = output.trace;
      return [
        escapeControls(JSON.stringify({ leads, connections })),
        ...evidence.map((hit) => formatHit(hit)),
      ].join('\n\n');
    }
    return [
      JSON.stringify({ followUp: output.followUp }),
      ...(output.source ? [formatHit(output.source)] : []),
      ...output.searches.map(formatSearch),
    ].join('\n\n');
  }
  return JSON.stringify(output);
}
