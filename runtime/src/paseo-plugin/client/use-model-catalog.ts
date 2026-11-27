import { useCallback, useEffect, useState } from 'react';
import { defineRpc } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import {
  ModelCatalogRequestSchema,
  ModelCatalogResponseSchema,
  type ModelCatalogResponse,
} from '@ltcook/model-contracts';

const modelCatalogRpc = defineRpc({
  name: 'ltcook.model.catalog',
  input: ModelCatalogRequestSchema,
  output: ModelCatalogResponseSchema,
});

type CatalogState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; catalog: ModelCatalogResponse };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useModelCatalog(teamSelection: string | undefined, enabled = true) {
  const callCatalog = useRpc(modelCatalogRpc);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const [state, setState] = useState<CatalogState>({ status: 'loading' });

  useEffect(() => {
    if (!enabled || !teamSelection) {
      setState({ status: 'loading' });
      return;
    }
    let current = true;
    void callCatalog({ teamSelection }).then(
      (catalog) => {
        if (current) setState({ status: 'ready', catalog });
      },
      (error: unknown) => {
        if (current) setState({ status: 'error', message: errorMessage(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [callCatalog, enabled, revision, teamSelection]);

  return { ...state, refresh };
}
