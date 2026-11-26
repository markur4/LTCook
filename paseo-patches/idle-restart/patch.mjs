// @getpaseo/server 0.16.0-beta.2, upstream 23bae61535542a45ade7196a7b3c152705f16de3.
// Each edit applies to the published ESM after exact content verification.

function replaceOnce(source, anchor, replacement) {
  const start = source.indexOf(anchor);
  if (start === -1 || start !== source.lastIndexOf(anchor)) {
    throw new Error(`Unexpected Paseo idle restart patch anchor: ${anchor}`);
  }
  return source.slice(0, start) + replacement + source.slice(start + anchor.length);
}

function addAtOpening(source, declaration, code) {
  const opening = `${declaration} {\n`;
  return replaceOnce(source, opening, opening + code + '\n');
}

function trackAsyncBody(source, declaration, guard = '') {
  const indent = declaration.match(/^ */)[0];
  const opening = `${declaration} {\n`;
  const openingAt = source.indexOf(opening);
  const start = openingAt + opening.length;
  const end = source.indexOf(`\n${indent}}\n`, start);
  if (openingAt === -1 || end === -1) {
    throw new Error(`Unexpected Paseo idle restart patch body: ${declaration}`);
  }
  const body = source.slice(start, end);
  return replaceOnce(
    source,
    opening + body + `\n${indent}}\n`,
    opening +
      guard +
      `${indent}    return idleRestart.run(async () => {\n` +
      body +
      `\n${indent}    });\n${indent}}\n`,
  );
}

function importGate(source, gateUrl) {
  return `import { idleRestart } from ${JSON.stringify(gateUrl)};\n${source}`;
}

function patchAgentManager(source, { gateUrl }) {
  for (const declaration of [
    '    async createAgent(config, agentId, options)',
    '    createAgentFromRecord(agentId)',
    '    resumeAgentFromPersistence(handle, overrides, agentId, options, resumeOptions)',
    '    importProviderSession(input)',
    '    reloadAgentSession(agentId, overrides, options)',
    '    async reloadStalePluginSession(agentId)',
    '    streamAgent(agentId, prompt, options)',
  ]) {
    source = addAtOpening(source, declaration, '        idleRestart.assertOpen();');
  }
  // Once queued, these registrations are counted by AgentManager's own tracking.
  // Upgrading history can await a record before it starts the provider reload.
  source = replaceOnce(
    source,
    '    async ensureInteractiveSessionUnlocked(agentId) {\n        const agent = this.requireSessionAgent(agentId);\n        if (this.historySessions.has(agent.session)) {',
    '    async ensureInteractiveSessionUnlocked(agentId) {\n        const agent = this.requireSessionAgent(agentId);\n        if (this.historySessions.has(agent.session)) {\n            idleRestart.assertOpen();',
  );
  for (const method of ['streamAfterRuntimeCollection', 'streamAfterHistoryLoad']) {
    const call = `this.${method}(agentId, prompt, options)`;
    source = replaceOnce(source, `return ${call};`, `return idleRestart.stream(() => ${call});`);
  }
  for (const declaration of [
    '    async tryRunOutOfBand(agentId, prompt, options)',
    '    async replaceAgentRun(agentId, prompt, options)',
    '    async steerOrReplaceActiveTurn(agentId, prompt, options)',
  ]) {
    source = trackAsyncBody(source, declaration);
  }
  const anchor = '    hasInFlightRun(agentId) {';
  source = replaceOnce(
    source,
    anchor,
    `    ltcookIdleRestartActiveTurns() {
        let activeTurns = 0;
        for (const agent of this.agents.values()) {
            if (this.hasInFlightRun(agent.id) ||
                agent.lifecycle === "initializing" ||
                agent.activeTurnId ||
                agent.pendingReplacement ||
                agent.pendingPermissions.size ||
                agent.inFlightPermissionResponses.size ||
                this.backgroundWork.summary(agent.id)?.count ||
                this.providerSubagents.list(agent.id).some((child) => child.status === "running")) {
                activeTurns++;
            }
        }
        // These are asynchronous admissions or event ingestion, possibly without an agent yet.
        const pending = this.agentRegistrationTasks.size ||
            this.lifecycleMutationTails.size ||
            this.foregroundMutationTails.size ||
            this.sessionEventTails.size;
        return Math.max(activeTurns, pending ? 1 : 0);
    }
${anchor}`,
  );
  return importGate(source, gateUrl);
}

function patchAgentPrompt(source, { gateUrl }) {
  // Hold the work through the asynchronous drain and its stale-session retry.
  source = replaceOnce(
    source,
    '    void (async () => {\n        try {\n            try {\n                await drainAgentRunIterator(iterator);',
    '    void idleRestart.run(async () => {\n        try {\n            try {\n                await drainAgentRunIterator(iterator);',
  );
  source = replaceOnce(
    source,
    '    })();\n    return { disposition: "turn_started" };',
    '    });\n    return { disposition: "turn_started" };',
  );
  for (const declaration of [
    'export async function startAgentRun(agentManager, agentId, prompt, logger, options)',
    'export async function sendPromptToAgent(params)',
    'export async function sendPreparedPromptToAgent(params)',
    'export async function startCreatedAgentInitialPrompt(params)',
  ]) {
    source = trackAsyncBody(source, declaration);
  }
  return importGate(source, gateUrl);
}

function patchWorkspaceArchive(source, { gateUrl }) {
  source = addAtOpening(
    source,
    'async function archiveByScopeWithPriority(dependencies, request)',
    `    const preserveDirectory = typeof request.requestId === "string" &&
        request.requestId.startsWith(workspaceArchiveRequestPrefix);
    if (preserveDirectory && request.scope.kind !== "workspace") {
        throw new WorkspaceArchiveBlockedError("Preserving archive requires workspace scope");
    }`,
  );
  source = replaceOnce(
    source,
    '    await stopWorkspaceSetups(dependencies, target.setupWorkspaceIds, request.requestId);',
    '    if (!preserveDirectory) await stopWorkspaceSetups(dependencies, target.setupWorkspaceIds, request.requestId);',
  );
  const archiveRecords =
    '        const { archivedAgents, archivedWorkspaceIds } = await archiveTargetRecords(dependencies, targetWorkspaceIds, { requestId: request.requestId, checkpoint, archivedAt });';
  source = replaceOnce(
    source,
    archiveRecords,
    `        if (preserveDirectory) {
            const activeTurns = dependencies.agentManager.ltcookIdleRestartActiveTurns?.();
            if (!Number.isFinite(activeTurns) || activeTurns !== 0) {
                throw new WorkspaceArchiveBlockedError("Paseo has active or pending agent work");
            }
        }
${archiveRecords}`,
  );
  // Skip the entire branch: worktree teardown hooks can delete files before
  // deletePaseoWorktree runs. File cleanliness is deliberately irrelevant.
  source = replaceOnce(
    source,
    '        if (target.backing !== null) {',
    '        if (!preserveDirectory && target.backing !== null) {',
  );
  return `import { WorkspaceArchiveBlockedError, workspaceArchiveRequestPrefix } from ${JSON.stringify(gateUrl)};\n${source}`;
}

export const patches = {
  'dist/scripts/supervisor-entrypoint.js': {
    sha256: '935ea7f386cb464f1aacd111901370b7c7b11ef4c9e6a1ce5fe378dee78cd3bb',
    apply(source, { registerUrl }) {
      const anchor =
        '    const workerExecArgv = resolveWorkerExecArgv(workerEntry, config.devMode);';
      return replaceOnce(
        source,
        anchor,
        `${anchor}\n    workerExecArgv.push("--import", ${JSON.stringify(registerUrl)});`,
      );
    },
  },
  'dist/server/server/bootstrap.js': {
    sha256: '5e3418aef47924bdcb1644e51e850ee52e86e29d71b0fdf25932c31ca7139713',
    apply(source, { gateUrl }) {
      const terminalAnchor =
        '    applyTerminalAgentHookSetting({ store: daemonConfigStore, logger });';
      source = replaceOnce(
        source,
        terminalAnchor,
        `    const ltcookCreateTerminal = terminalManager.createTerminal.bind(terminalManager);
    terminalManager.createTerminal = (...args) => idleRestart.run(() => ltcookCreateTerminal(...args));
${terminalAnchor}`,
      );
      const setupAnchor = '    const workspaceSetupRuntime = new WorkspaceSetupRuntime();';
      source = replaceOnce(
        source,
        setupAnchor,
        `${setupAnchor}
    const ltcookStartWorkspaceSetup = workspaceSetupRuntime.start.bind(workspaceSetupRuntime);
    workspaceSetupRuntime.start = (...args) => {
        idleRestart.assertOpen();
        return ltcookStartWorkspaceSetup(...args);
    };`,
      );
      const anchor =
        '    app.post("/api/terminal-activity", express.json(), createTerminalActivityRouteHandler(terminalManager));';
      source = replaceOnce(
        source,
        anchor,
        `${anchor}
    app.post(
        idleRestartPath,
        authorizeIdleRestart(isLoopbackRemoteAddress, process.env.LTCOOK_RUNTIME_USER_TOKEN),
        express.json({ limit: "1kb" }),
        idleRestartHandler(
            () => Math.max(agentManager.ltcookIdleRestartActiveTurns(), wsServer?.agentMessages.hasAnyPending() ? 1 : 0, workspaceSetupRuntime.runs.size > 0 ? 1 : 0),
            config.onLifecycleIntent,
            { workspaceArchive: "preserve-directory-v1" },
        ),
    );
    app.post(
        workspaceArchivePath,
        authorizeIdleRestart(isLoopbackRemoteAddress, process.env.LTCOOK_RUNTIME_USER_TOKEN),
        express.json({ limit: "1kb" }),
        workspaceArchiveHandler({
            getWorkspace: (workspaceId) => workspaceRegistry.get(workspaceId),
            isSetupRunning: (workspaceId) => {
                if (!(workspaceSetupRuntime.runs instanceof Map)) {
                    throw new Error("Cannot inspect workspace setup state");
                }
                return workspaceSetupRuntime.runs.has(workspaceId);
            },
            listTerminals: async (workspaceId) => {
                if (terminalManager.getUnavailableError?.()) {
                    throw new Error("Cannot inspect workspace terminals");
                }
                const lists = await Promise.all(terminalManager.listDirectories().map(
                    (cwd) => terminalManager.getTerminals(cwd, { workspaceId }),
                ));
                return lists.flat().filter((terminal) => terminal.workspaceId === workspaceId);
            },
            countActiveTurns: () => Math.max(agentManager.ltcookIdleRestartActiveTurns(), wsServer?.agentMessages.hasAnyPending() ? 1 : 0, workspaceSetupRuntime.runs.size > 0 ? 1 : 0),
            archiveWorkspace: (workspaceId, requestId) => archiveWorkspaceByIdExternal(workspaceId, requestId),
        }),
    );`,
      );
      return `import { authorizeIdleRestart, idleRestart, idleRestartHandler, idleRestartPath, workspaceArchiveHandler, workspaceArchivePath } from ${JSON.stringify(gateUrl)};\n${source}`;
    },
  },
  'dist/server/server/workspace-archive-service.js': {
    sha256: '62fff0b4eca1567103fb9a553cc52d71195b9851d749b7b4e57d306b9deccfdb',
    apply: patchWorkspaceArchive,
  },
  'dist/server/server/agent/agent-manager.js': {
    sha256: '9e448f74df5ac6bfcc273eef6dc553c9c751dc2aa0ed9f08f2804ac02d9b2751',
    apply: patchAgentManager,
  },
  'dist/server/server/agent/agent-prompt.js': {
    sha256: 'f9027ad7fce65accb4f8ee672a113c4ffab9a34b68d53ec42398b3057f1121fe',
    apply: patchAgentPrompt,
  },
  'dist/server/server/agent/agent-loading.js': {
    sha256: '6173536d63db0d59f2494fcc0f55e9fd5b363da00b085f62071061e5df65b8f8',
    apply(source, { gateUrl }) {
      return importGate(
        trackAsyncBody(source, 'export async function ensureAgentLoaded(agentId, deps)'),
        gateUrl,
      );
    },
  },
  'dist/server/server/agent/agent-response-loop.js': {
    sha256: 'c59d554bb5ae18eabbd20011f9f1e80ed09af27a9b8228c9b4c48281c37d7679',
    apply(source, { gateUrl }) {
      return importGate(
        trackAsyncBody(source, 'export async function generateStructuredAgentResponse(options)'),
        gateUrl,
      );
    },
  },
  'dist/server/server/agent/agent-messages/delivery.js': {
    sha256: '1f0cf36c233fe0ab7fcdfd889c1b3e4ad3fe64bd587e364e5ceb7e1e5f9aeaf8',
    apply(source, { gateUrl }) {
      const anchor =
        '        hasPending: (recipientId) => pending.has(recipientId) || dispatching.has(recipientId),';
      source = replaceOnce(
        source,
        anchor,
        `${anchor}\n        hasAnyPending: () => pending.size > 0 || dispatching.size > 0,`,
      );
      source = addAtOpening(
        source,
        '        enqueue(message)',
        '            idleRestart.assertOpen();',
      );
      return importGate(source, gateUrl);
    },
  },
  'dist/server/server/agent/create-agent/create.js': {
    sha256: '09906c1c98f449ee23e14f01c08ee28e072a16b782c6f6e7f677b86d87bb16b6',
    apply(source, { gateUrl }) {
      return importGate(
        trackAsyncBody(source, 'export async function createAgentCommand(dependencies, input)'),
        gateUrl,
      );
    },
  },
  'dist/server/server/creation/index.js': {
    sha256: '087095b0de51a6467c88f15b3db5eca3285e06643839a8d0cbb0d24f375dc7c7',
    apply(source, { gateUrl }) {
      return importGate(trackAsyncBody(source, '    async create(input, observer)'), gateUrl);
    },
  },
  'dist/server/server/schedule/service.js': {
    sha256: '36adf70f1bfc87a903e14e6943e63c28e85bc14175d85619d3898e397a3106ad',
    apply(source, { gateUrl }) {
      // An automatic schedule remains due when admission pauses before its durable claim.
      return importGate(
        trackAsyncBody(
          source,
          '    async runSchedule(schedule, now, options)',
          '        if (options?.manual !== true && idleRestart.isReserved()) return;\n',
        ),
        gateUrl,
      );
    },
  },
  'dist/server/server/session.js': {
    sha256: '481ddefa51e4e299c5094fb2ff934010cc7ac416fb3238febfbd5fb9912d2885',
    apply(source, { gateUrl }) {
      // The unkeyed WebSocket path can provision a worktree before createAgentCommand.
      return importGate(
        trackAsyncBody(source, '    async createSessionAgent(msg, agentId, onAgentReady)'),
        gateUrl,
      );
    },
  },
};
