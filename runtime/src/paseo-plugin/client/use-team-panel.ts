import { AppState } from 'react-native';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { defineRpc } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import {
  TeamSnapshotRequestSchema,
  TeamSnapshotResponseSchema,
  type TeamStatusSnapshot,
} from '../shared/panel-snapshot';
import {
  TeamDetailRequestSchema,
  TeamDetailResponseSchema,
  type TeamDetailTarget,
  type TeamDetailResponse,
} from '../shared/panel-details';
import { acceptPanelResponse } from '../shared/view-model';

const snapshotRpc = defineRpc({
  name: 'ltcook.team.snapshot',
  input: TeamSnapshotRequestSchema,
  output: TeamSnapshotResponseSchema,
});
const detailRpc = defineRpc({
  name: 'ltcook.team.detail',
  input: TeamDetailRequestSchema,
  output: TeamDetailResponseSchema,
});

type Load<T> =
  | { sessionId: string; status: 'loading' }
  | { sessionId: string; status: 'error'; message: string }
  | { sessionId: string; status: 'ready'; value: T };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isAppVisible = () =>
  AppState.currentState !== 'background' && AppState.currentState !== 'inactive';

export function useTeamPanel(sessionId: string | undefined, target: TeamDetailTarget | null) {
  const callSnapshot = useRpc(snapshotRpc);
  const callDetail = useRpc(detailRpc);
  const [state, setState] = useState<Load<TeamStatusSnapshot | null>>();
  const [detail, setDetail] = useState<Load<TeamDetailResponse> & { key: string }>();
  const snapshotVersion = useRef(0);
  const detailVersion = useRef(0);
  const mounted = useRef(false);
  const key = JSON.stringify(target);
  const current = useRef({ sessionId, key });

  useLayoutEffect(() => {
    current.current = { sessionId, key };
  }, [sessionId, key]);

  const refresh = useCallback(async () => {
    if (!sessionId || !mounted.current || !isAppVisible()) return;
    const version = ++snapshotVersion.current;
    setState({ sessionId, status: 'loading' });
    try {
      const value = await callSnapshot({ sessionId });
      if (
        mounted.current &&
        acceptPanelResponse(
          current.current.sessionId ?? '',
          snapshotVersion.current,
          sessionId,
          version,
        )
      )
        setState({ sessionId, status: 'ready', value });
    } catch (error) {
      if (
        mounted.current &&
        acceptPanelResponse(
          current.current.sessionId ?? '',
          snapshotVersion.current,
          sessionId,
          version,
        )
      )
        setState({ sessionId, status: 'error', message: message(error) });
    }
  }, [sessionId, callSnapshot]);

  const latestRefresh = useRef(refresh);
  useLayoutEffect(() => {
    latestRefresh.current = refresh;
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    if (isAppVisible()) void refresh();
    const refreshWhenVisible = () => {
      if (isAppVisible()) void latestRefresh.current();
    };
    const subscription = AppState.addEventListener('change', refreshWhenVisible);
    const timer = setInterval(refreshWhenVisible, 5000);
    return () => {
      mounted.current = false;
      snapshotVersion.current++;
      detailVersion.current++;
      clearInterval(timer);
      subscription.remove();
    };
  }, [refresh]);

  useEffect(() => {
    const version = ++detailVersion.current;
    if (
      !sessionId ||
      !target ||
      state?.sessionId !== sessionId ||
      state.status !== 'ready' ||
      !state.value
    )
      return;
    const accepts = () =>
      mounted.current &&
      current.current.key === key &&
      acceptPanelResponse(
        current.current.sessionId ?? '',
        detailVersion.current,
        sessionId,
        version,
      );
    setDetail({ sessionId, key, status: 'loading' });
    void callDetail({ sessionId, target })
      .then((value) => {
        if (accepts()) setDetail({ sessionId, key, status: 'ready', value });
      })
      .catch((error) => {
        if (accepts()) setDetail({ sessionId, key, status: 'error', message: message(error) });
      });
    return () => {
      detailVersion.current++;
    };
  }, [sessionId, key, target, callDetail, state]);

  return {
    state: state?.sessionId === sessionId ? state : undefined,
    detail: detail && detail.sessionId === sessionId && detail.key === key ? detail : undefined,
    refresh,
  };
}
