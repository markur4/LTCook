import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type ServiceController = {
  start(): Promise<string>;
  stop(): Promise<string>;
  status(): Promise<string>;
  logs(): Promise<string>;
  remove(): Promise<string>;
};

type Receipt = {
  schema: 1;
  podman_executable: string;
  compose_provider: string;
  connection: 'local' | 'direct' | 'paseo-tunnel';
  compose_project: string;
  compose_file: string;
  service_config_dir: string;
};

const run = (
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): string => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: environment,
    cwd,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ''} failed${result.status === null ? '' : ` (${result.status})`}`,
    );
  }
  let output = result.stdout.trim();
  for (const name of ['CRAWL4AI_API_TOKEN', 'SEARXNG_SECRET', 'LTCOOK_API_TOKEN']) {
    const secret = environment[name];
    if (secret) output = output.replaceAll(secret, '[REDACTED]');
  }
  return output;
};

export function createServiceController(
  environment: Readonly<NodeJS.ProcessEnv>,
): ServiceController {
  const deployment = environment.LTCOOK_DEPLOYMENT_DIR;
  if (!deployment || !isAbsolute(deployment))
    throw new Error('LTCOOK_DEPLOYMENT_DIR must be an absolute AppRC deployment path.');
  const receiptPath = join(deployment, 'services.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
  const expectedComposeFile = join(deployment, 'app', 'services', 'compose.yaml');
  const expectedConfigDir = join(deployment, 'service-config');
  const projectIdentity = readFileSync(join(deployment, '.ltcook-compose-project'), 'utf8').trim();
  if (
    receipt.schema !== 1 ||
    !/^ltcook-[0-9a-f]{12}$/.test(projectIdentity) ||
    receipt.compose_project !== projectIdentity ||
    receipt.connection !== (environment.LTCOOK_SERVICE_CONNECTION ?? 'local') ||
    resolve(receipt.compose_file) !== resolve(expectedComposeFile) ||
    resolve(receipt.service_config_dir) !== resolve(expectedConfigDir)
  ) {
    throw new Error('LTCook service preparation receipt does not match this configuration.');
  }
  if (receipt.connection === 'local') {
    for (const path of [receipt.podman_executable, receipt.compose_provider]) {
      if (!isAbsolute(path))
        throw new Error('Service preparation receipt contains a non-absolute path.');
    }
  }
  for (const path of [receipt.compose_file, receipt.service_config_dir]) {
    if (!isAbsolute(path))
      throw new Error('Service preparation receipt contains a non-absolute path.');
  }
  if (!isAbsolute(receiptPath) || resolve(dirname(receiptPath)) !== resolve(deployment))
    throw new Error('Invalid LTCook deployment path.');
  const env = { ...environment, PODMAN_COMPOSE_PROVIDER: receipt.compose_provider };
  const args = (action: string): string[] => [
    'compose',
    '--project-name',
    receipt.compose_project,
    '-f',
    receipt.compose_file,
    action,
  ];
  const compose = (arguments_: string[]): string =>
    run(receipt.podman_executable, arguments_, env, dirname(receipt.compose_file));
  const local = (): void => {
    if (receipt.connection !== 'local')
      throw new Error('Configured remote services must be operated on their configured host.');
    run(receipt.podman_executable, ['info', '--format', 'json'], env);
  };
  return {
    async start() {
      if (receipt.connection !== 'local')
        throw new Error(
          `Local service control is unavailable for ${receipt.connection}; configure central-service URLs and check them through the application connection.`,
        );
      local();
      if (!environment.CRAWL4AI_API_TOKEN || !environment.SEARXNG_SECRET)
        throw new Error('CRAWL4AI_API_TOKEN and SEARXNG_SECRET must be configured in AppRC.');
      return compose(args('up').concat('-d', '--remove-orphans'));
    },
    async stop() {
      if (receipt.connection !== 'local')
        throw new Error(
          `Local service control is unavailable for ${receipt.connection}; stop services on their configured host.`,
        );
      local();
      return compose(args('stop').concat('searxng', 'crawl4ai'));
    },
    async status() {
      if (receipt.connection !== 'local')
        return `Remote services configured via ${receipt.connection}; remote health is not checked by the local service controller.`;
      local();
      return compose(args('ps').concat('--all'));
    },
    async logs() {
      if (receipt.connection !== 'local')
        throw new Error(
          `Local logs are unavailable for ${receipt.connection}; read logs on the configured service host.`,
        );
      local();
      return compose(args('logs').concat('--no-color', '--tail', '200'));
    },
    async remove() {
      if (receipt.connection !== 'local')
        throw new Error('Refusing to remove externally owned services.');
      local();
      return compose(args('down').concat('--remove-orphans'));
    },
  };
}
