import { createRiedTool, type RiedService } from './ried.js';
import { createSummarizeTool } from './summarize.js';
import { createWebTools, type WebToolService } from './web.js';
import type { OllamaSettings } from '../integrations/ollama.js';
import type { ToolDefinition } from './types.js';

export function createTools(
  ried: RiedService,
  ollama?: OllamaSettings,
  web?: WebToolService,
): readonly ToolDefinition[] {
  return [
    createRiedTool(ried),
    ...(ollama ? [createSummarizeTool(ollama)] : []),
    ...(web ? createWebTools(web) : []),
  ];
}
