import { createHmac, randomUUID } from 'node:crypto';

export const workspaceNamingPath = '/api/ltcook/workspace-naming';
const preferenceKey = 'ltcook.autoRename';
const stateKey = 'ltcook.naming';
const manualTabKey = 'ltcook.manualTabTitle';

export let workspaceNaming;

export function configureWorkspaceNaming(dependencies) {
  workspaceNaming = createWorkspaceNaming(dependencies);
}

export function withoutNamingMetadata(metadata) {
  if (!Object.hasOwn(metadata ?? {}, stateKey)) return metadata;
  const { [stateKey]: state, ...visible } = metadata;
  return visible;
}

function isNamingJob(entry) {
  return typeof entry === 'object' && entry !== null;
}

export function workspaceCreationMetadata(metadata, explicitTitle) {
  const visible = withoutNamingMetadata(metadata);
  return explicitTitle?.trim() ? { ...visible, [stateKey]: { seen: true, agents: {} } } : visible;
}

export function workspaceNamingMetadata(metadata) {
  const state = metadata?.[stateKey];
  return {
    ...withoutNamingMetadata(metadata),
    'ltcook.autoRenameSupported': true,
    'ltcook.namingPending': Object.values(state?.agents ?? {}).some(isNamingJob),
  };
}

export function manualWorkspaceTitle(record, title, updatedAt) {
  const metadata = workspacePreference(record.metadata, false);
  return {
    ...record,
    title,
    updatedAt,
    metadata: {
      ...metadata,
      [stateKey]: {
        ...metadata[stateKey],
        seen: true,
        agents: metadata[stateKey]?.agents ?? {},
      },
    },
  };
}

export function workspacePreference(metadata, enabled) {
  const state = metadata?.[stateKey];
  return {
    ...metadata,
    [preferenceKey]: enabled,
    ...(enabled === false && state
      ? {
          [stateKey]: {
            ...state,
            agents: Object.fromEntries(
              Object.entries(state.agents).map(([id, entry]) => [
                id,
                isNamingJob(entry) ? true : entry,
              ]),
            ),
          },
        }
      : {}),
  };
}

export function agentTitleMetadata(updates) {
  return updates.title && !updates.automaticTitle
    ? { ...updates.metadata, [manualTabKey]: true }
    : updates.metadata;
}

export function createWorkspaceNaming({
  registry,
  agentManager,
  agentStorage,
  notify,
  logger,
  environment = process.env,
}) {
  const enabled = (key) => (environment[key] ?? 'true') === 'true';
  const renamerEnabled = enabled('LTCOOK_RENAMER_ENABLED');
  const workspacesEnabled = renamerEnabled && enabled('LTCOOK_RENAMER_WORKSPACES');
  const tabsEnabled = renamerEnabled && enabled('LTCOOK_RENAMER_TABS');
  const operations = new Map();
  // > The old timestamp lacks provenance. Exclude known non-human or rejected activity below.
  const priorHistory = agentStorage.listAll().then((records) => {
    const byWorkspace = new Map();
    for (const agent of records) {
      if (!agent.workspaceId || agent.internal || agent.background || !agent.lastUserMessageAt)
        continue;
      const agents = byWorkspace.get(agent.workspaceId) ?? [];
      agents.push(agent.id);
      byWorkspace.set(agent.workspaceId, agents);
    }
    return byWorkspace;
  });
  void priorHistory.catch(() => {});

  function serialize(workspaceId, operation) {
    const previous = operations.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.catch(() => {});
    operations.set(workspaceId, tail);
    void tail.then(() => {
      if (operations.get(workspaceId) === tail) operations.delete(workspaceId);
    });
    return result;
  }

  function recordPrompt(agent, messages, clientMessageId, accepted = true) {
    const { id: agentId, workspaceId } = agent;
    if (!workspaceId || agent.internal || agent.background) return;
    const submitted = messages.find(({ type }) => type === 'user_message');
    if (!submitted) return;
    const marker = 'ltcook-runtime-';
    const secret = environment.LTCOOK_RUNTIME_USER_TOKEN;
    let runtime = false;
    if (secret && clientMessageId?.startsWith(marker)) {
      const [nonce, signature] = clientMessageId.slice(marker.length).split('.');
      runtime =
        Boolean(nonce) &&
        signature ===
          createHmac('sha256', secret)
            .update(JSON.stringify([agentId, nonce]))
            .digest('base64url');
    }
    const humanAccepted = accepted && !runtime;
    const prompt = humanAccepted ? submitted.text.trim().slice(0, 2500) : '';
    void serialize(workspaceId, async () => {
      const previous = (await priorHistory).get(workspaceId) ?? [];
      const workspace = await registry.get(workspaceId);
      if (!workspace || workspace.archivedAt) return;
      const existing = workspace.metadata?.[stateKey]?.agents[agentId];
      if (existing !== undefined && !(existing === false && humanAccepted)) return;
      if (!humanAccepted && previous.includes(agentId)) return;
      const id = randomUUID();
      const updated = await registry.update(workspaceId, (current) => {
        if (current.archivedAt) return current;
        const state = current.metadata?.[stateKey] ?? { seen: false, agents: {} };
        // > A false entry records traffic that advanced Paseo's timestamp without a human acceptance.
        if (!humanAccepted) {
          return {
            ...current,
            metadata: {
              ...current.metadata,
              [stateKey]: { ...state, agents: { ...state.agents, [agentId]: false } },
            },
          };
        }
        const allowed = current.metadata?.[preferenceKey] !== false;
        const nameWorkspace =
          allowed &&
          workspacesEnabled &&
          !state.seen &&
          !previous.some((id) => state.agents[id] !== false);
        const nameTab =
          allowed &&
          tabsEnabled &&
          !(previous.includes(agentId) && state.agents[agentId] !== false) &&
          agent.metadata?.[manualTabKey] !== true;
        const job =
          nameWorkspace || nameTab
            ? {
                id,
                workspaceId,
                agentId,
                prompt,
                nameWorkspace,
                nameTab,
                workspaceTitle: current.title ?? '',
                agentTitle: agent.config.title ?? '',
              }
            : true;
        return {
          ...current,
          metadata: {
            ...current.metadata,
            [stateKey]: {
              seen: true,
              agents: { ...state.agents, [agentId]: job },
            },
          },
        };
      });
      if (updated?.metadata?.[stateKey]?.agents[agentId]?.id === id) await notify([workspaceId]);
    }).catch((error) =>
      logger.warn({ err: error, workspaceId }, 'Could not record workspace naming prompt'),
    );
  }

  function apply({ workspaceId, agentId, id, workspaceTitle, agentTitle }) {
    return serialize(workspaceId, async () => {
      const workspace = await registry.get(workspaceId);
      const job = workspace?.metadata?.[stateKey]?.agents[agentId];
      if (
        !workspace ||
        workspace.archivedAt ||
        workspace.metadata?.[preferenceKey] === false ||
        !job ||
        job.id !== id
      )
        return false;
      let tabApplied = false;
      if (job.nameTab && tabsEnabled && agentTitle) {
        await agentManager.runLifecycleMutation(agentId, async () => {
          const agent = await agentStorage.get(agentId);
          if (
            !agent ||
            agent.workspaceId !== workspaceId ||
            agent.archivedAt ||
            agent.metadata?.[manualTabKey] === true ||
            agent.metadata?.[stateKey] === id
          )
            return;
          await agentManager.updateAgentMetadataUnlocked(agentId, {
            title: agentTitle,
            automaticTitle: true,
            metadata: { [stateKey]: id },
          });
          tabApplied = true;
        });
      }
      let workspaceApplied = false;
      await registry.update(workspaceId, (current) => {
        const state = current.metadata?.[stateKey];
        if (!state || state.agents[agentId]?.id !== id) return current;
        workspaceApplied = Boolean(
          job.nameWorkspace &&
          workspacesEnabled &&
          workspaceTitle &&
          !current.archivedAt &&
          current.metadata?.[preferenceKey] !== false,
        );
        return {
          ...current,
          ...(workspaceApplied
            ? { title: workspaceTitle, updatedAt: new Date().toISOString() }
            : {}),
          metadata: {
            ...current.metadata,
            [stateKey]: {
              ...state,
              agents: { ...state.agents, [agentId]: true },
            },
          },
        };
      });
      await notify([workspaceId]);
      return workspaceApplied || tabApplied;
    });
  }

  return {
    recordPrompt,
    serialize,
    async handle(request, response, next) {
      try {
        const { operation, workspaceId, agentId, id, workspaceTitle, agentTitle } =
          request.body ?? {};
        const identifier = (value) =>
          typeof value === 'string' && value.length > 0 && value.length <= 256;
        const title = (value) =>
          value === undefined ||
          (typeof value === 'string' && value.trim().length > 0 && value.length <= 512);
        if (operation === 'status') {
          response.json({ workspaceNaming: true });
        } else if (operation === 'pending' && identifier(workspaceId)) {
          const workspace = await registry.get(workspaceId);
          const jobs =
            workspace && !workspace.archivedAt && workspace.metadata?.[preferenceKey] !== false
              ? Object.values(workspace.metadata?.[stateKey]?.agents ?? {}).filter(isNamingJob)
              : [];
          response.json({ jobs });
        } else if (
          operation === 'apply' &&
          identifier(workspaceId) &&
          identifier(agentId) &&
          identifier(id) &&
          title(workspaceTitle) &&
          title(agentTitle)
        ) {
          response.json({
            applied: await apply({ workspaceId, agentId, id, workspaceTitle, agentTitle }),
          });
        } else {
          response.status(400).json({ error: 'Invalid workspace naming request' });
        }
      } catch (error) {
        next(error);
      }
    },
  };
}
