import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ollamaEndpoint } from './ollama.js';

export type OllamaDeviceCatalog = {
  devices: { id: string; label: string; mainGpu?: number; unavailable?: string }[];
  diagnostic?: string;
};

const exec = promisify(execFile);
const cacheMs = 30_000;
const unavailable = 'GPU discovery is unavailable for the configured Ollama server.';
const unknownIndex = 'Ollama did not confirm this GPU’s index.';
const ambiguousIndex = 'Ollama cannot uniquely target this GPU index.';
const selectableBackends = new Set(['cuda', 'rocm', 'vulkan']);

const probeResult = z.object({
  devices: z
    .array(
      z.object({
        library: z.string().min(1),
        index: z.number().int().nonnegative(),
        index_matches_backend: z.boolean().optional(),
        device_id: z.string().optional(),
        description: z.string().optional(),
        name: z.string().optional(),
        integrated: z.boolean().optional(),
        integrated_known: z.boolean().optional(),
      }),
    )
    .nullable(),
});

type ProbedDevice = {
  id: string;
  label: string;
  backend: string;
  hardware?: string;
  index: number;
  confirmed: boolean;
  integrated?: boolean;
};

function groupByBackend(devices: Iterable<ProbedDevice>) {
  const groups = new Map<string, ProbedDevice[]>();
  for (const device of devices) {
    const group = groups.get(device.backend) ?? [];
    group.push(device);
    groups.set(device.backend, group);
  }
  for (const devices of groups.values()) devices.sort((left, right) => left.index - right.index);
  return groups;
}

export function catalogFromOllamaProbe(value: unknown): OllamaDeviceCatalog {
  const probe = probeResult.safeParse(value);
  if (!probe.success) return { devices: [], diagnostic: unavailable };
  const candidates = new Map<string, ProbedDevice>();
  const possibleSlots = new Map<string, number>();
  for (const device of probe.data.devices ?? []) {
    const library = device.library.trim().toLowerCase();
    const backend = library === 'hip' ? 'rocm' : library;
    possibleSlots.set(backend, Math.max(possibleSlots.get(backend) ?? 0, device.index + 1));
    const identity = device.device_id?.trim().toLowerCase();
    const hardware =
      identity && /^[\w.:-]+$/.test(identity) && !/^\d+$/.test(identity) ? identity : undefined;
    const id = `ollama:${backend}:${hardware ?? `index-${device.index}`}`;
    const rawLabel = device.description?.trim() || device.name?.trim();
    const previous = candidates.get(id);
    // > Driver-only probe rows can have an index but lack the GGML backend name.
    const confirmed = !!hardware && !!device.name?.trim() && device.index_matches_backend === true;
    const integrated = device.integrated_known === true ? device.integrated === true : undefined;
    candidates.set(id, {
      id,
      label: rawLabel || previous?.label || `${device.library} GPU ${device.index}`,
      backend,
      hardware,
      index: device.index,
      confirmed:
        confirmed && (!previous || (previous.confirmed && previous.index === device.index)),
      integrated: previous && previous.integrated !== integrated ? undefined : integrated,
    });
  }

  const groups = groupByBackend(candidates.values());
  const unreliable = new Set(
    [...groups].flatMap(([backend, devices]) =>
      selectableBackends.has(backend) &&
      devices.every((device, offset) => device.confirmed && device.index === offset)
        ? []
        : [backend],
    ),
  );

  // > Ollama prefers CUDA or ROCm over Vulkan for a device with the same physical identity.
  // > Confirm that removing these aliases cannot change the preferred backend's order.
  const vulkan = groups.get('vulkan');
  if (vulkan && !unreliable.has('vulkan')) {
    const aliases = new Set<string>();
    for (const backend of ['cuda', 'rocm']) {
      const preferred = groups.get(backend);
      if (!preferred) continue;
      const hardware = new Set(preferred.map((device) => device.hardware));
      const overlaps = vulkan.filter((device) => hardware.has(device.hardware));
      if (!overlaps.length) continue;
      if (
        unreliable.has(backend) ||
        !overlaps.every((device, offset) => device.hardware === preferred[offset]?.hardware)
      ) {
        unreliable.add(backend);
        unreliable.add('vulkan');
        continue;
      }
      for (const device of overlaps) aliases.add(device.id);
    }
    groups.set(
      'vulkan',
      vulkan.filter((device) => !aliases.has(device.id)),
    );
  }

  const devices = [...groups].flatMap(([backend, group]) =>
    group.map(({ id, label, integrated }, index) => {
      // > Server-side iGPU admission can shift the index of every device that follows it.
      if (
        unreliable.has(backend) ||
        group.slice(0, index).some((device) => device.integrated !== false)
      )
        return { id, label, unavailable: unknownIndex };
      if (integrated !== false && index < group.length - 1)
        return { id, label, unavailable: ambiguousIndex };
      // > Other libraries can have the same ordinal. Ollama prefers a discrete GPU in this
      // > case, but otherwise decides by available memory. A later discrete peer can also
      // > take this ordinal if preceding integrated peers are filtered out.
      const ambiguous = [...groups].some(([other, peers]) => {
        if (other === backend) return false;
        if (unreliable.has(other)) return index < (possibleSlots.get(other) ?? 0);
        return (
          index < peers.length &&
          (integrated !== false || peers.slice(index).some((peer) => peer.integrated !== true))
        );
      });
      if (ambiguous) return { id, label, unavailable: ambiguousIndex };
      return { id, label, mainGpu: index };
    }),
  );
  return {
    devices,
    ...(devices.length ? {} : { diagnostic: 'Ollama discovered no GPUs.' }),
  };
}

async function ollamaExecutable() {
  const name = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    try {
      const executable = await realpath(path.join(dir, name));
      if (process.platform === 'linux' && path.extname(executable).toLowerCase() === '.exe')
        continue;
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      return executable;
    } catch {
      // > Try the next host PATH entry.
    }
  }
  return undefined;
}

async function ollamaLibraryDirs(executable: string) {
  const bin = path.dirname(executable);
  const installed = path.join(bin, '..', 'lib', 'ollama');
  const portable = path.join(bin, 'lib', 'ollama');
  const roots = process.platform === 'linux' ? [installed, portable] : [portable, installed];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined);
    if (!entries) continue;
    const backends = entries
      .filter((entry) => entry.isDirectory() && /^(cuda_v\d+|rocm|vulkan)/i.test(entry.name))
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
      .map((entry) => path.join(root, entry.name));
    return [root, ...backends];
  }
  return [];
}

function discoveryEnvironment(endpoint: URL): NodeJS.ProcessEnv {
  const keys = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LD_LIBRARY_PATH',
    'CUDA_VISIBLE_DEVICES',
    'CUDA_DEVICE_ORDER',
    'HIP_VISIBLE_DEVICES',
    'ROCR_VISIBLE_DEVICES',
    'GPU_DEVICE_ORDINAL',
    'GGML_VK_VISIBLE_DEVICES',
    'VK_DRIVER_FILES',
    'VK_ICD_FILENAMES',
    'VK_LOADER_DRIVERS_SELECT',
    'VK_LOADER_DRIVERS_DISABLE',
    'HSA_OVERRIDE_GFX_VERSION',
  ];
  return {
    ...Object.fromEntries(keys.map((key) => [key, process.env[key]])),
    OLLAMA_HOST: endpoint.origin,
  };
}

function supportedVersion(output: string) {
  const version = /^ollama version is (\d+)\.(\d+)\.(\d+)\s*$/im.exec(output);
  if (!version || /client version/i.test(output)) return false;
  const major = Number(version[1]);
  const minor = Number(version[2]);
  const patch = Number(version[3]);
  return major > 0 || minor > 40 || (minor === 40 && patch >= 17);
}

async function probeOllama(endpoint: string): Promise<OllamaDeviceCatalog> {
  if (process.platform !== 'linux' && process.platform !== 'win32')
    return { devices: [], diagnostic: unavailable };
  const target = ollamaEndpoint(endpoint);
  const executable = await ollamaExecutable();
  if (!executable) return { devices: [], diagnostic: unavailable };
  const options = {
    env: discoveryEnvironment(target),
    encoding: 'utf8' as const,
    cwd: path.dirname(executable),
    windowsHide: true,
    maxBuffer: 128 * 1024,
    killSignal: 'SIGKILL' as const,
  };
  const { stdout: versionText } = await exec(executable, ['--version'], {
    ...options,
    timeout: 3_000,
  });
  // > Ollama prints a client version warning when the configured server runs a different version.
  if (!supportedVersion(versionText)) return { devices: [], diagnostic: unavailable };

  const dirs = await ollamaLibraryDirs(executable);
  const libraryPath = process.platform === 'linux' ? 'LD_LIBRARY_PATH' : 'PATH';
  const env = {
    ...options.env,
    [libraryPath]: [...dirs, options.env[libraryPath]].filter(Boolean).join(path.delimiter),
  };
  const { stdout } = await exec(
    executable,
    ['gpu-discover', ...dirs.flatMap((dir) => ['--lib-dir', dir])],
    { ...options, env, timeout: 15_000 },
  );
  return catalogFromOllamaProbe(JSON.parse(stdout));
}

export function createOllamaDeviceCatalog(
  endpoint: string,
  probe = probeOllama,
): (refresh?: boolean) => Promise<OllamaDeviceCatalog> {
  let cached: { catalog: OllamaDeviceCatalog; expires: number } | undefined;
  let pending: Promise<OllamaDeviceCatalog> | undefined;
  return async (refresh = false) => {
    if (pending) return pending;
    if (!refresh && cached && cached.expires > Date.now()) return cached.catalog;
    pending = Promise.resolve()
      .then(() => probe(endpoint))
      .catch((): OllamaDeviceCatalog => ({ devices: [], diagnostic: unavailable }))
      .then((catalog) => {
        cached = { catalog, expires: Date.now() + cacheMs };
        return catalog;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
