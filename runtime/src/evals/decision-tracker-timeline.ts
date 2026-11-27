import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createPaseoMemorySource } from '../integrations/paseo-memory.js';
import { startPaseoHost } from '../integrations/paseo.js';

const timelineModel = 'decision-tracker-timeline';
const timelineReply = 'The timeline fixture recorded the user message.';

/** Run a native Pi turn against a local scripted transport to create real Paseo evidence. */
export async function openDecisionTrackerTimeline(input: {
  directory: string;
  appRoot: string;
  nodeExecutable: string;
  signal: AbortSignal;
}) {
  const { directory, appRoot, nodeExecutable, signal } = input;
  const piCommand = path.join(appRoot, 'runtime/dist/integrations/pi-rpc.js');
  await access(piCommand).catch(() => {
    throw new Error('Build the LTCook runtime to run the native Decision Tracker case.');
  });
  const deployment = path.join(directory, 'native');
  const agentDir = path.join(deployment, 'pi');
  const workspace = path.join(deployment, 'workspace');
  const pluginDirectory = path.join(deployment, 'runtime/dist/paseo-plugin');
  const secondaryPlugin = path.join(pluginDirectory, 'turn-speed');
  const rules = path.join(deployment, 'runtime/resources/rules');
  await Promise.all(
    [agentDir, workspace, secondaryPlugin, rules].map((entry) => mkdir(entry, { recursive: true })),
  );
  await Promise.all([
    copyFile(
      path.join(appRoot, 'runtime/resources/rules/workspace-terminology.md'),
      path.join(rules, 'workspace-terminology.md'),
    ),
    writeFile(path.join(pluginDirectory, 'paseo-plugin.json'), JSON.stringify({ id: 'ltcook' })),
    writeFile(
      path.join(secondaryPlugin, 'paseo-plugin.json'),
      JSON.stringify({ id: 'turn-speed' }),
    ),
  ]);
  const provider = createServer((request, response) => {
    request.resume();
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [
      [{ role: 'assistant', content: timelineReply }, null],
      [{}, 'stop'],
    ]) {
      const chunk = {
        id: 'decision-tracker-fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: timelineModel,
        choices: [{ index: 0, delta, finish_reason }],
      };
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  const listening = once(provider, 'listening');
  provider.listen(0, '127.0.0.1');
  let host: Awaited<ReturnType<typeof startPaseoHost>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      signal.removeEventListener('abort', abort);
      try {
        await host?.close();
      } finally {
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
      }
    })());
  const abort = () => void close().catch(() => undefined);
  try {
    await listening;
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('No native fixture port.');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const secret = randomUUID();
    await writeFile(
      path.join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `${endpoint}/v1`,
            api: 'openai-completions',
            apiKey: 'offline-fixture-only',
            models: [
              {
                id: timelineModel,
                name: 'Decision Tracker timeline fixture',
                contextWindow: 8192,
                maxTokens: 128,
                input: ['text'],
                reasoning: false,
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ retry: { enabled: false } }),
    );
    const environment = {
      HOME: deployment,
      PI_CODING_AGENT_DIR: agentDir,
      LTCOOK_PI_AUTH_DIR: agentDir,
      PI_OFFLINE: '1',
    };
    signal.throwIfAborted();
    host = await startPaseoHost({
      node: nodeExecutable,
      home: path.join(deployment, 'paseo'),
      deploymentRoot: deployment,
      listen: '127.0.0.1:0',
      runtimeApiUrl: endpoint,
      userToken: secret,
      pluginDirectory,
      piCommand,
      environment,
    });
    signal.addEventListener('abort', abort, { once: true });
    signal.throwIfAborted();
    const agent = await host.api.agents.create({
      cwd: workspace,
      config: { provider: `pi/fixture/${timelineModel}` },
      env: environment,
      background: true,
    });
    const source = createPaseoMemorySource(host.api, secret);
    return {
      source,
      agentId: agent.id,
      async append(text: string) {
        signal.throwIfAborted();
        const result = await agent.run(text, { messageId: randomUUID(), timeoutMs: 10_000 });
        signal.throwIfAborted();
        if (result.status !== 'idle') throw new Error('The native Pi fixture turn did not finish.');
        const { messages } = await source.read(agent.id, undefined, 'tail');
        const user = messages.findLast(
          (message) => message.author === 'user' && message.text === text,
        );
        const reply = messages.findLast(
          (message) => message.author === 'agent' && message.text === timelineReply,
        );
        if (!user || !reply || reply.seq <= user.seq)
          throw new Error(
            'The native timeline did not retain the expected Pi turn and provenance.',
          );
        return user.seq;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
