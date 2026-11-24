export const SESSION_MEMORY_TOOL_NAME = 'session-memory';
export const WORKSPACE_MCP_SERVER = 'ltcook_workspace';
export const REPO_SEARCH_TIMEOUT_MS = 120_000;
export const REPO_SEARCH_TOOL_NAME = 'ltcook_repo_search';
export const REPO_LOCATE_TOOL_NAME = 'ltcook_repo_locate';

export const REPOSITORY_TOOL_NAMES = [REPO_SEARCH_TOOL_NAME, REPO_LOCATE_TOOL_NAME] as const;

export function isRepositoryTool(name: unknown): name is (typeof REPOSITORY_TOOL_NAMES)[number] {
  return name === REPO_SEARCH_TOOL_NAME || name === REPO_LOCATE_TOOL_NAME;
}
