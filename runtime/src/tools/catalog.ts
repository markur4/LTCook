import { createRiedTool } from './ried.js';
import type { RiedService } from '../repository/discovery.js';
import { createRepoSearchTool } from './repo-search.js';
import { createRepoLocateTool } from './repo-locate.js';
import { createSummarizeTool } from './summarize.js';
import { createWebTools, type WebToolService } from './web.js';
import type { OllamaSettings } from '../integrations/ollama.js';
import type { ToolDefinition } from './types.js';

export function createTools(
  ried: RiedService,
  ollama?: OllamaSettings,
  web?: WebToolService,
): readonly ToolDefinition[] {
  const repoSearch = createRepoSearchTool();
  return [
    createRiedTool(ried),
    repoSearch,
    createRepoLocateTool(repoSearch),
    ...(ollama ? [createSummarizeTool(ollama)] : []),
    ...(web ? createWebTools(web) : []),
  ];
}
