import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspacePreparationCache } from '../../../runtime/src/integrations/workspace-preparation.js';
import { createPaseoAgentBackend } from '../../../runtime/src/integrations/paseo.js';
import team from '@ltcook/team-default-minimal';

test('workspace preparation is shared concurrently and invalidated by input and output changes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ltcook-preparation-'));
  try {
    const config = path.join(root, 'workspace.env');
    const generated = path.join(root, 'models.json');
    const optional = path.join(root, 'workspace.secret.env');
    const workspace = path.join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(config, 'first');
    writeFileSync(generated, 'generated');
    const cache = new WorkspacePreparationCache();
    let calls = 0;
    const prepare = () => ({
      environment: { MODEL: String(++calls) },
      dependencies: [workspace, config, optional, generated],
    });
    const [one, two] = await Promise.all([
      cache.get('session-a', prepare),
      cache.get('session-a', prepare),
    ]);
    expect(one.environment.MODEL).toBe('1');
    expect(two.environment.MODEL).toBe('1');
    expect((await cache.get('session-a', prepare)).environment.MODEL).toBe('1');
    expect((await cache.get('session-b', prepare)).environment.MODEL).toBe('2');
    writeFileSync(config, 'other');
    expect((await cache.get('session-a', prepare)).environment.MODEL).toBe('3');
    writeFileSync(optional, 'new private setting');
    expect((await cache.get('session-a', prepare)).environment.MODEL).toBe('4');
    writeFileSync(generated, 'changed by user');
    expect((await cache.get('session-a', prepare)).environment.MODEL).toBe('5');
    rmSync(workspace, { recursive: true });
    expect((await cache.get('session-a', prepare)).environment.MODEL).toBe('6');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'native agents reuse preparation but retain their own identities',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ltcook-native-preparation-'));
    const previousResponse = process.env.LTCOOK_TEST_PREPARATION_RESPONSE;
    const previousCount = process.env.LTCOOK_TEST_PREPARATION_COUNT;
    try {
      const app = path.join(root, 'app');
      const modules = path.join(app, 'node_modules');
      for (const name of ['pi-web-access', '@nicknisi/pi-codesearch']) {
        const directory = path.join(modules, ...name.split('/'));
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          path.join(directory, 'package.json'),
          JSON.stringify({ name, pi: { extensions: ['extension.js'] } }),
        );
        writeFileSync(path.join(directory, 'extension.js'), '');
      }
      const extension = path.join(app, 'extension.js');
      writeFileSync(extension, '');
      const workspace = path.join(root, 'workspace');
      mkdirSync(workspace);
      const dependency = path.join(root, 'settings.env');
      writeFileSync(dependency, 'one');
      const response = path.join(root, 'response.json');
      const count = path.join(root, 'count');
      writeFileSync(
        response,
        JSON.stringify({
          workspaceRoot: workspace,
          environment: {
            PI_CODING_AGENT_DIR: path.join(root, 'pi'),
            LTCOOK_MODEL_SMART: 'smart-model',
            LTCOOK_MODEL_SMOL: 'small-model',
            PATH: process.env.PATH,
          },
          dependencies: [dependency],
        }),
      );
      const python = path.join(root, 'python');
      writeFileSync(
        python,
        '#!/bin/sh\nprintf "x" >> "$LTCOOK_TEST_PREPARATION_COUNT"\ncat "$LTCOOK_TEST_PREPARATION_RESPONSE"\n',
      );
      chmodSync(python, 0o700);
      process.env.LTCOOK_TEST_PREPARATION_RESPONSE = response;
      process.env.LTCOOK_TEST_PREPARATION_COUNT = count;
      const backend = await createPaseoAgentBackend({
        api: {} as never,
        python,
        runtimeApiUrl: 'http://127.0.0.1:1234',
        piHome: path.join(root, 'pi'),
        extensionPath: extension,
        appNodeModules: modules,
        deploymentNode: process.execPath,
        browserAvailable: false,
        identity: (id) => ({ agentId: id, token: `token-${id}` }),
      });
      const options = {
        workspaceRoot: workspace,
        sessionId: 'session',
        teamId: 'team',
        teamInstanceId: 'instance',
        member: team.definition.members[0]!,
      };
      const [first, second] = await Promise.all([
        backend.prepare(options, 'one'),
        backend.prepare({ ...options, member: team.definition.members[1]! }, 'two'),
      ]);
      expect(readFileSync(count, 'utf8')).toBe('x');
      expect(first.env.LTCOOK_AGENT_API_TOKEN).toBe('token-one');
      expect(second.env.LTCOOK_AGENT_API_TOKEN).toBe('token-two');
      expect(first.model).toBe('smart-model');
      expect(second.model).toBe('small-model');
      writeFileSync(dependency, 'two');
      const changedResponse = JSON.parse(readFileSync(response, 'utf8'));
      changedResponse.environment.LTCOOK_MODEL_SMART = 'updated-model';
      writeFileSync(response, JSON.stringify(changedResponse));
      expect((await backend.prepare(options, 'three')).model).toBe('updated-model');
      expect(readFileSync(count, 'utf8')).toBe('xx');
      await backend.prepare({ ...options, sessionId: 'another' }, 'four');
      expect(readFileSync(count, 'utf8')).toBe('xxx');
      const otherWorkspace = path.join(root, 'other-workspace');
      mkdirSync(otherWorkspace);
      const otherResponse = JSON.parse(readFileSync(response, 'utf8'));
      otherResponse.workspaceRoot = otherWorkspace;
      writeFileSync(response, JSON.stringify(otherResponse));
      await backend.prepare({ ...options, workspaceRoot: otherWorkspace }, 'five');
      expect(readFileSync(count, 'utf8')).toBe('xxxx');
    } finally {
      if (previousResponse === undefined) delete process.env.LTCOOK_TEST_PREPARATION_RESPONSE;
      else process.env.LTCOOK_TEST_PREPARATION_RESPONSE = previousResponse;
      if (previousCount === undefined) delete process.env.LTCOOK_TEST_PREPARATION_COUNT;
      else process.env.LTCOOK_TEST_PREPARATION_COUNT = previousCount;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
