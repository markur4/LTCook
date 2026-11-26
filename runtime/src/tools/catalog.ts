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
import type { ToolContext, ToolDefinition } from './types.js';

export class ToolCatalog {
  readonly definitions: readonly ToolDefinition[];
  private readonly byName: ReadonlyMap<string, ToolDefinition>;

  constructor(definitions: readonly ToolDefinition[]) {
    this.definitions = [...definitions];
    this.byName = new Map(this.definitions.map((tool) => [tool.name, tool]));
  }

  async invoke(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<Record<string, unknown>> {
    const tool = this.byName.get(name);
    if (!tool) throw new Error('Unknown LTCook tool.');
    return tool.invoke(input, context);
  }
}

export function createTools(
  ried: RiedService,
  ollama?: OllamaSettings,
  web?: WebToolService,
  memory?: SessionMemory,
  colgrep?: ReturnType<typeof createColgrepProvider>,
  worktree?: ToolDefinition,
): ToolCatalog {
  const repoSearch = createRepoSearchTool(colgrep);
  return new ToolCatalog([
    createRiedTool(ried),
    repoSearch,
    createRepoLocateTool(repoSearch),
    ...(worktree ? [worktree] : []),
    ...(ollama
      ? [createSummarizeTool(ollama, undefined, memory && (() => memory.holdForeground()))]
      : []),
    ...(memory ? [createSessionMemoryTool(memory)] : []),
    ...(web ? createWebTools(web) : []),
  ]);
}
