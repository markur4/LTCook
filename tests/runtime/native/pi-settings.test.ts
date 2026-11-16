import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPaseoHost } from '../../../runtime/src/integrations/paseo.js';
import { configurePiExtensions } from '../../../runtime/src/integrations/pi-settings.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('native Pi configuration boundary', () => {
  test('replaces recorded Pi extensions and preserves independent entries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-pi-settings-'));
    directories.push(directory);
    const settingsPath = join(directory, 'settings.json');
    const ownershipPath = `${settingsPath}.ltcook-extensions.json`;
    const independent = '/user/extensions/custom.js';
    const unrelatedIntegration = '/other-project/runtime/dist/integrations/private.js';
    const unrelatedPackage = '/other-project/node_modules/pi-web-access/dist/index.js';
    const previousAppExtension = '/old-deployment/runtime/dist/integrations/old-team.js';
    const codeSearch = '/deployment/node_modules/@nicknisi/pi-codesearch/dist/index.js';
    const webAccess = '/deployment/node_modules/pi-web-access/dist/index.js';
    const appExtension = '/deployment/runtime/dist/integrations/pi-extension.js';
    writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: 'dark',
        extensions: [
          independent,
          unrelatedIntegration,
          unrelatedPackage,
          previousAppExtension,
          codeSearch,
          webAccess,
        ],
      }),
    );
    writeFileSync(
      ownershipPath,
      JSON.stringify({
        version: 1,
        paths: [previousAppExtension, codeSearch, webAccess],
      }),
    );

    await configurePiExtensions(settingsPath, [appExtension, webAccess, codeSearch]);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'dark',
      extensions: [
        independent,
        unrelatedIntegration,
        unrelatedPackage,
        appExtension,
        webAccess,
        codeSearch,
      ],
    });

    await configurePiExtensions(settingsPath, [appExtension, webAccess]);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).extensions).toEqual([
      independent,
      unrelatedIntegration,
      unrelatedPackage,
      appExtension,
      webAccess,
    ]);
    await configurePiExtensions(settingsPath, [appExtension, webAccess, codeSearch]);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).extensions).toEqual([
      independent,
      unrelatedIntegration,
      unrelatedPackage,
      appExtension,
      webAccess,
      codeSearch,
    ]);
  });

  test('retains extension ownership and settings after a failed replacement', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-pi-write-failure-'));
    directories.push(directory);
    const settingsPath = join(directory, 'settings.json');
    const ownershipPath = `${settingsPath}.ltcook-extensions.json`;
    const oldExtension = '/old/owned.js';
    const newExtension = '/new/owned.js';
    const independent = '/user/keep.js';
    const original = JSON.stringify({ extensions: [independent, oldExtension] });
    writeFileSync(settingsPath, original);
    writeFileSync(ownershipPath, JSON.stringify({ version: 1, paths: [oldExtension] }));
    const rename = fileSystem.rename;
    const failure = spyOn(fileSystem, 'rename').mockImplementation(async (from, to) => {
      if (to === settingsPath) throw new Error('simulated settings replacement failure');
      return rename(from, to);
    });
    try {
      await expect(configurePiExtensions(settingsPath, [newExtension])).rejects.toThrow(
        'simulated settings replacement failure',
      );
      expect(readFileSync(settingsPath, 'utf8')).toBe(original);
      expect(JSON.parse(readFileSync(ownershipPath, 'utf8')).paths).toEqual([
        oldExtension,
        newExtension,
      ]);
    } finally {
      failure.mockRestore();
    }
    await configurePiExtensions(settingsPath, []);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).extensions).toEqual([independent]);
  });

  test('rejects a JSON null settings document without rewriting it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-pi-null-'));
    directories.push(directory);
    const settingsPath = join(directory, 'settings.json');
    writeFileSync(settingsPath, 'null\n');
    await expect(configurePiExtensions(settingsPath, ['/owned.js'])).rejects.toThrow(
      'Pi settings must contain a JSON object.',
    );
    expect(readFileSync(settingsPath, 'utf8')).toBe('null\n');
  });

  test('preserves unowned paths even if they match desired extensions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-pi-legacy-'));
    directories.push(directory);
    const settingsPath = join(directory, 'settings.json');
    const currentAppPath = '/current-app/runtime/dist/integrations/pi-extension.js';
    const unrelatedIntegration = '/other-app/runtime/dist/integrations/keep.js';
    const unrelatedPackage = '/other-app/node_modules/pi-web-access/dist/index.js';
    writeFileSync(
      settingsPath,
      JSON.stringify({
        extensions: [currentAppPath, unrelatedIntegration, unrelatedPackage],
      }),
    );

    await configurePiExtensions(settingsPath, [currentAppPath]);
    expect(new Set(JSON.parse(readFileSync(settingsPath, 'utf8')).extensions)).toEqual(
      new Set([currentAppPath, unrelatedIntegration, unrelatedPackage]),
    );
    await configurePiExtensions(settingsPath, []);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).extensions).toEqual([
      currentAppPath,
      unrelatedIntegration,
      unrelatedPackage,
    ]);
  });

  test('preserves wrong-element Pi settings and rejects malformed ownership', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-pi-malformed-'));
    directories.push(directory);
    const settingsPath = join(directory, 'settings.json');
    const ownershipPath = `${settingsPath}.ltcook-extensions.json`;
    const malformed = '{"extensions":["ok",12]}\n';
    writeFileSync(settingsPath, malformed);
    await expect(configurePiExtensions(settingsPath, ['/owned.js'])).rejects.toThrow(
      'Pi settings extensions must be an array of strings.',
    );
    expect(readFileSync(settingsPath, 'utf8')).toBe(malformed);

    writeFileSync(settingsPath, '{"extensions":["keep.js"]}\n');
    writeFileSync(ownershipPath, '{"version":1,"paths":["/old.js",7]}');
    const settingsBefore = readFileSync(settingsPath, 'utf8');
    const ownershipBefore = readFileSync(ownershipPath, 'utf8');
    await expect(configurePiExtensions(settingsPath, ['/owned.js'])).rejects.toThrow(
      'Pi extension ownership record is malformed.',
    );
    expect(readFileSync(settingsPath, 'utf8')).toBe(settingsBefore);
    expect(readFileSync(ownershipPath, 'utf8')).toBe(ownershipBefore);
  });

  test('preserves invalid JSON settings without rewriting them', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-pi-invalid-json-'));
    directories.push(directory);
    const settingsPath = join(directory, 'settings.json');
    const malformed = '{ invalid json\n';
    writeFileSync(settingsPath, malformed);
    await expect(configurePiExtensions(settingsPath, ['/owned.js'])).rejects.toThrow();
    expect(readFileSync(settingsPath, 'utf8')).toBe(malformed);
    expect(() => readFileSync(`${settingsPath}.ltcook-extensions.json`, 'utf8')).toThrow();
  });
  test('rejects Paseo homes outside the deployment and under immutable app', async () => {
    const deploymentRoot = mkdtempSync(join(tmpdir(), 'ltcook-deployment-'));
    const outsideHome = mkdtempSync(join(tmpdir(), 'ltcook-paseo-outside-'));
    directories.push(deploymentRoot, outsideHome);
    const hostInput = {
      node: '',
      deploymentRoot,
      listen: '127.0.0.1:6767',
      password: '',
      runtimeApiUrl: '',
      userToken: '',
      pluginDirectory: '',
    };

    for (const home of [outsideHome, join(deploymentRoot, 'app', 'paseo')]) {
      await expect(startPaseoHost({ ...hostInput, home })).rejects.toThrow(
        'PASEO_HOME must resolve inside the LTCook deployment and outside its immutable app directory.',
      );
    }

    expect(() => readFileSync(join(outsideHome, 'config.json'))).toThrow();
    expect(() => readFileSync(join(deploymentRoot, 'app', 'paseo', 'config.json'))).toThrow();
  });
});
