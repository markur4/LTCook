export const SESSION_MEMORY_TOOL_NAME = 'session-memory';
export const REPO_SEARCH_TIMEOUT_MS = 120_000;
export const REPO_SEARCH_TOOL_NAME = 'ltcook_repo_search';
export const REPO_LOCATE_TOOL_NAME = 'ltcook_repo_locate';
export const WORKTREE_TOOL_NAME = 'ltcook_worktree';
export const WORKTREE_TOOL_DESCRIPTION =
  'Report the Git worktree used by this session so Changes follows it. After creating or selecting a worktree for the task, report its absolute path with operation="use". After successful removal, report that same path with operation="release". Include the Pass ID when this worktree belongs to a Pass. If registration fails, check that Git lists the checkout in the session repository. This tool does not create or remove worktrees.';

export const REPOSITORY_TOOL_NAMES = [REPO_SEARCH_TOOL_NAME, REPO_LOCATE_TOOL_NAME] as const;

export function isRepositoryTool(name: unknown): name is (typeof REPOSITORY_TOOL_NAMES)[number] {
  return name === REPO_SEARCH_TOOL_NAME || name === REPO_LOCATE_TOOL_NAME;
}
