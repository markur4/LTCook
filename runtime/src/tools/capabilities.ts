import { isWebTool } from './web.js';
import {
  isRepositoryTool,
  SESSION_MEMORY_TOOL_NAME,
  WORKTREE_TOOL_NAME,
} from './workspace-tools.js';

const investigationTools = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'web_search',
  'ltcook_web_search',
  'ltcook_web_fetch',
  'ltcook_web_content',
  'fetch_content',
  'get_search_content',
  'code_search',
  'code_fetch',
  'web_enable',
  'ltcook_ried',
]);

export function allowsRestrictedTool(name: string): boolean {
  // > The coordination tool enforces authority at the command level.
  if (name === 'ltcook_team') return true;
  return (
    investigationTools.has(name) || isRepositoryTool(name) || name === SESSION_MEMORY_TOOL_NAME
  );
}

export function isManagedWorkspaceTool(name: unknown): name is string {
  return (
    isWebTool(name) ||
    isRepositoryTool(name) ||
    name === SESSION_MEMORY_TOOL_NAME ||
    name === WORKTREE_TOOL_NAME
  );
}
