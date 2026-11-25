import { expect, test } from 'bun:test';
import {
  catalogFromOllamaProbe,
  createOllamaDeviceCatalog,
} from '../../../runtime/src/integrations/ollama-devices.js';

function device(index: number, id: string, description: string, library = 'CUDA') {
  return {
    library,
    index,
    device_id: id,
    name: `${library}${index}`,
    description,
    index_matches_backend: true,
    integrated_known: true,
  };
}

const rtx5090 = device(0, 'GPU-5090', 'RTX 5090');
const rtx4070 = device(1, 'GPU-4070', 'RTX 4070 Ti Super');

test('uses Ollama backend order and keeps a hardware identity when that order changes', () => {
  expect(catalogFromOllamaProbe({ devices: [rtx4070, rtx5090] }).devices).toEqual([
    { id: 'ollama:cuda:gpu-5090', label: 'RTX 5090', mainGpu: 0 },
    { id: 'ollama:cuda:gpu-4070', label: 'RTX 4070 Ti Super', mainGpu: 1 },
  ]);
  expect(
    catalogFromOllamaProbe({
      devices: [
        { ...rtx4070, index: 0 },
        { ...rtx5090, index: 1 },
      ],
    }).devices[1],
  ).toMatchObject({ id: 'ollama:cuda:gpu-5090', mainGpu: 1 });
});

test('shows all candidates while retaining only deterministic shared backend indices', () => {
  const amd = { ...device(0, 'GPU-AMD', 'AMD integrated', 'ROCm'), integrated: true };
  const discrete = catalogFromOllamaProbe({ devices: [rtx5090, rtx4070, amd] }).devices;
  expect(discrete[0]?.mainGpu).toBe(0);
  expect(discrete[1]?.mainGpu).toBe(1);
  expect(discrete[2]).toMatchObject({ label: 'AMD integrated', unavailable: expect.any(String) });
  expect(discrete[2]?.mainGpu).toBeUndefined();

  const ambiguous = catalogFromOllamaProbe({
    devices: [rtx5090, rtx4070, { ...amd, integrated_known: false }],
  }).devices;
  expect(ambiguous.map((entry) => entry.mainGpu)).toEqual([undefined, 1, undefined]);
});

test('keeps conflicting or unconfirmed backend indices visible without routing', () => {
  const { devices } = catalogFromOllamaProbe({
    devices: [
      { ...rtx5090, index_matches_backend: false, device_id: '0' },
      device(0, 'GPU-extra', 'A second candidate for index zero'),
      rtx4070,
    ],
  });
  expect(devices.map((entry) => entry.label)).toEqual([
    'RTX 5090',
    'A second candidate for index zero',
    'RTX 4070 Ti Super',
  ]);
  expect(devices.every((entry) => !('mainGpu' in entry) && entry.unavailable)).toBe(true);
  expect(
    catalogFromOllamaProbe({ devices: [{ ...rtx5090, name: undefined }] }).devices[0],
  ).toMatchObject({ label: 'RTX 5090', unavailable: expect.any(String) });
});

test('collapses matching repeated backends and rejects aliases that can reorder a group', () => {
  const matching = catalogFromOllamaProbe({
    devices: [
      { ...rtx5090, library: 'Vulkan' },
      { ...rtx4070, library: 'Vulkan' },
      rtx5090,
      rtx5090,
      rtx4070,
    ],
  }).devices;
  expect(matching.map((entry) => entry.mainGpu)).toEqual([0, 1]);
  const reordered = catalogFromOllamaProbe({
    devices: [
      { ...rtx4070, library: 'Vulkan', index: 0 },
      { ...rtx5090, library: 'Vulkan', index: 1 },
      rtx5090,
      rtx4070,
    ],
  }).devices;
  expect(reordered.every((entry) => entry.mainGpu === undefined)).toBe(true);
});

test('coalesces pending probe requests and exposes unavailable discovery without raw output', async () => {
  let attempts = 0;
  const catalog = createOllamaDeviceCatalog('loopback fixture', async () => {
    attempts++;
    if (attempts === 1) throw new Error('Untrusted backend diagnostic');
    return catalogFromOllamaProbe({ devices: [rtx5090, rtx4070] });
  });
  const [first, concurrent] = await Promise.all([catalog(), catalog(true)]);
  expect(first).toEqual({
    devices: [],
    diagnostic: 'GPU discovery is unavailable for the configured Ollama server.',
  });
  expect(concurrent).toEqual(first);
  expect(await catalog()).toEqual(first);
  expect((await catalog(true)).devices).toHaveLength(2);
  expect(attempts).toBe(2);
  expect(catalogFromOllamaProbe({ devices: null }).devices).toEqual([]);
  expect(catalogFromOllamaProbe({ devices: [{ index: -1 }] }).diagnostic).toBeDefined();
});
