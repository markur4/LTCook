import { useCallback, useEffect, useState } from 'react';
import { defineRpc } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import {
  TeamCatalogRequestSchema,
  TeamCatalogResponseSchema,
  type TeamCatalogEntry,
} from '../shared/team-catalog';

const teamCatalogRpc = defineRpc({
  name: 'ltcook.team.catalog',
  input: TeamCatalogRequestSchema,
  output: TeamCatalogResponseSchema,
});

type CatalogState =
  | { status: 'loading'; teams: TeamCatalogEntry[] }
  | { status: 'error'; teams: TeamCatalogEntry[]; message: string }
  | { status: 'ready'; teams: TeamCatalogEntry[] };

export function useTeamCatalog(enabled = true): CatalogState & { refresh(): void } {
  const callCatalog = useRpc(teamCatalogRpc);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const [state, setState] = useState<CatalogState>({ status: 'loading', teams: [] });

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'loading', teams: [] });
      return;
    }
    let current = true;
    void callCatalog({}).then(
      ({ teams }) => {
        if (current) setState({ status: 'ready', teams });
      },
      (error: unknown) => {
        if (current)
          setState({
            status: 'error',
            teams: [],
            message: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      current = false;
    };
  }, [callCatalog, enabled, revision]);

  return { ...state, refresh };
}
