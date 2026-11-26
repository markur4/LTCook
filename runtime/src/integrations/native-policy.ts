import { allowsRestrictedTool } from '../tools/capabilities.js';

export function nativeToolAllowed(readOnly: boolean, toolName: string): boolean {
  return !readOnly || allowsRestrictedTool(toolName);
}

const PRIVATE_PARENT_KEYS = [
  'LTCOOK_API_TOKEN',
  'LTCOOK_RUNTIME_USER_TOKEN',
  'LTCOOK_PASEO_PASSWORD',
  'LTCOOK_SHELL_PROVENANCE',
];

export function agentEnvironment(source: Record<string, string>): Record<string, string> {
  const environment = { ...source };
  for (const key of PRIVATE_PARENT_KEYS) environment[key] = '';
  return environment;
}
