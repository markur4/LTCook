import { useEffect, useState } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import { storedSummariesRpc, type StoredSummariesPage } from '../shared/activity';

type ReadRequest = { previous: StoredSummariesPage | null; all?: boolean };
type ReadResult =
  { request: ReadRequest; page: StoredSummariesPage } | { request: ReadRequest; error: string };

function precedes(
  summary: StoredSummariesPage['summaries'][number],
  cursor: NonNullable<StoredSummariesPage['next']>,
) {
  return (
    summary.position < cursor.position ||
    (summary.position === cursor.position && summary.id < cursor.id)
  );
}

export function useStoredSummaries(agentId: string, includeContent: boolean) {
  const read = useRpc(storedSummariesRpc);
  const [request, setRequest] = useState<ReadRequest>({ previous: null });
  const [result, setResult] = useState<ReadResult>();

  useEffect(() => {
    let current = true;

    async function load() {
      let page = request.previous;
      const summaries = [...(page?.summaries ?? [])];
      try {
        do {
          const before = page?.next ?? undefined;
          const incoming = await read({ agentId, includeContent, before });
          if (!current) return;
          const first = incoming.summaries[0];
          const last = incoming.summaries.at(-1);
          const next = incoming.next;
          if (
            (before && first && !precedes(first, before)) ||
            (next &&
              (!last ||
                next.id !== last.id ||
                next.position !== last.position ||
                (before && (next.epoch !== before.epoch || !precedes(last, before))))) ||
            (page && incoming.storagePath !== page.storagePath)
          ) {
            throw new Error('Stored summaries changed. Reload from the newest summary.');
          }
          summaries.push(...incoming.summaries);
          page = incoming;
        } while (request.all && page.next);
        setResult({ request, page: { ...page, summaries } });
      } catch (error) {
        if (current) {
          setResult({
            request,
            error: error instanceof Error ? error.message : 'Stored summaries are unavailable.',
          });
        }
      }
    }

    void load();
    return () => {
      current = false;
    };
  }, [agentId, includeContent, read, request]);

  const current = result?.request === request ? result : undefined;
  const page = current && 'page' in current ? current.page : request.previous;
  const error = current && 'error' in current ? current.error : null;
  const loading = !current;

  return {
    page,
    error,
    loading,
    loadOlder() {
      if (!loading && !error && page?.next) setRequest({ previous: page });
    },
    loadAll() {
      if (!loading && !error && page?.next) setRequest({ previous: page, all: true });
    },
    reload() {
      setRequest({ previous: null });
    },
  };
}
