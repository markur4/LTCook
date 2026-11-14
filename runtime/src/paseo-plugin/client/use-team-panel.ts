import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { defineRpc } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import {
  TeamSnapshotRequestSchema,
  TeamSnapshotResponseSchema,
  SessionOpenRequestSchema,
  SessionOpenResponseSchema,
  type TeamStatusSnapshot,
} from '../shared/panel-snapshot';
import {
  TeamDetailRequestSchema,
  TeamDetailResponseSchema,
  type TeamDetailTarget,
  type TeamDetailResponse,
} from '../shared/panel-details';
import { acceptPanelResponse, completeSessionOpen } from '../shared/view-model';
const snapshotRpc = defineRpc({
  name: 'ltcook.team.snapshot',
  input: TeamSnapshotRequestSchema,
  output: TeamSnapshotResponseSchema,
});
const openRpc = defineRpc({
  name: 'ltcook.session.open',
  input: SessionOpenRequestSchema,
  output: SessionOpenResponseSchema,
});
const detailRpc = defineRpc({
  name: 'ltcook.team.detail',
  input: TeamDetailRequestSchema,
  output: TeamDetailResponseSchema,
});
type Load<T> =
  | { root: string; status: 'loading' }
  | { root: string; status: 'error'; message: string }
  | { root: string; status: 'ready'; value: T };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function useTeamPanel(root: string | undefined, target: TeamDetailTarget | null) {
  const callSnapshot = useRpc(snapshotRpc),
    callOpen = useRpc(openRpc),
    callDetail = useRpc(detailRpc);
  const [state, setState] = useState<Load<TeamStatusSnapshot | null>>();
  const [detail, setDetail] = useState<Load<TeamDetailResponse> & { key: string }>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const pendingRef = useRef<ReadonlySet<string>>(new Set());
  const snapshotVersion = useRef(0),
    detailVersion = useRef(0),
    mounted = useRef(false);
  const current = useRef({ root, key: JSON.stringify(target) });
  const key = JSON.stringify(target);
  useLayoutEffect(() => {
    current.current = { root, key };
  }, [root, key]);
  const refresh = useCallback(async () => {
    if (!root) return;
    const version = ++snapshotVersion.current;
    setState({ root, status: 'loading' });
    try {
      const value = await callSnapshot({ workspaceRoot: root });
      if (
        mounted.current &&
        acceptPanelResponse(current.current.root ?? '', snapshotVersion.current, root, version)
      )
        setState({ root, status: 'ready', value });
    } catch (error) {
      if (
        mounted.current &&
        acceptPanelResponse(current.current.root ?? '', snapshotVersion.current, root, version)
      )
        setState({ root, status: 'error', message: message(error) });
    }
  }, [root, callSnapshot]);
  const latestRefresh = useRef(refresh);
  useLayoutEffect(() => {
    latestRefresh.current = refresh;
  }, [refresh]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      snapshotVersion.current++;
      detailVersion.current++;
    };
  }, [refresh]);
  useEffect(() => {
    const version = ++detailVersion.current;
    if (!root || !target || state?.root !== root || state.status !== 'ready' || !state.value)
      return;
    const accepts = () =>
      mounted.current &&
      current.current.key === key &&
      acceptPanelResponse(current.current.root ?? '', detailVersion.current, root, version);
    setDetail({ root, key, status: 'loading' });
    void callDetail({ workspaceRoot: root, target })
      .then((value) => {
        if (accepts()) setDetail({ root, key, status: 'ready', value });
      })
      .catch((error) => {
        if (accepts()) setDetail({ root, key, status: 'error', message: message(error) });
      });
    return () => {
      detailVersion.current++;
    };
  }, [root, key, callDetail, state]);
  const startSession = async () => {
    if (!root || pendingRef.current.has(root)) return;
    const next = new Set(pendingRef.current);
    next.add(root);
    pendingRef.current = next;
    setPending(next);
    snapshotVersion.current++;
    setState({ root, status: 'loading' });
    let succeeded = false;
    try {
      await callOpen({ workspaceRoot: root });
      succeeded = true;
    } catch (error) {
      if (mounted.current && current.current.root === root)
        setState({ root, status: 'error', message: message(error) });
    } finally {
      const completed = completeSessionOpen(
        pendingRef.current,
        root,
        current.current.root,
        mounted.current,
        succeeded,
      );
      pendingRef.current = completed.pendingRoots;
      if (mounted.current) setPending(completed.pendingRoots);
      if (completed.refreshRoot) void latestRefresh.current();
    }
  };
  return {
    state: state?.root === root ? state : undefined,
    detail: detail && detail.root === root && detail.key === key ? detail : undefined,
    starting: !!root && pending.has(root),
    refresh,
    startSession,
  };
}
