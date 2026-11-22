import { createRiedTool, type RiedService } from './ried.js';
import type { ToolDefinition } from './types.js';

export function createTools(ried: RiedService): readonly ToolDefinition[] {
  return [createRiedTool(ried)];
}
