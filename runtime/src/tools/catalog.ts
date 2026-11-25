import { createRiedTool } from './ried.js';
import type { RiedService } from '../repository/discovery.js';
import { createRepoSearchTool } from './repo-search.js';
import { createRepoLocateTool } from './repo-locate.js';
import { createSummarizeTool } from './summarize.js';
import { createWebTools, type WebToolService } from './web.js';
import type { OllamaSettings } from '../integrations/ollama.js';
import { createSessionMemoryTool } from './session-memory.js';
import type { SessionMemory } from '../session-memory/service.js';
import type { createColgrepProvider } from '../repository/providers/colgrep.js';
import type { ToolDefinition } from './types.js';

export function createTools(
  ried: RiedService,
  ollama?: OllamaSettings,
  web?: WebToolService,
  memory?: SessionMemory,
  colgrep?: ReturnType<typeof createColgrepProvider>,
): readonly ToolDefinition[] {
  const repoSearch = createRepoSearchTool(colgrep);
  return [
    createRiedTool(ried),
    repoSearch,
    createRepoLocateTool(repoSearch),
    ...(ollama
      ? [createSummarizeTool(ollama, undefined, memory && (() => memory.holdForeground()))]
      : []),
    ...(memory ? [createSessionMemoryTool(memory)] : []),
    ...(web ? createWebTools(web) : []),
  ];
}
