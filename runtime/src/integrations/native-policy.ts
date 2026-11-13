const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'web_search',
  'fetch_content',
  'get_search_content',
  'code_search',
  'code_fetch',
  'ltcook_team',
  'web_enable',
]);

export function nativeToolAllowed(readOnly: boolean, toolName: string): boolean {
  return !readOnly || READ_ONLY_TOOLS.has(toolName);
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
