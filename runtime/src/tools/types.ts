import type { Static, TObject } from 'typebox';
import { Value } from 'typebox/value';
import type { RepositoryWorkspace } from '../repository/workspace.js';

export interface ToolContext {
  agentId: string;
  workspaceRoot: string;
  sessionId?: string;
  workspaceFileAccess: boolean;
  repositorySearchAccess?: boolean;
  repositoryWorkspace?: RepositoryWorkspace;
  signal: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: TObject;
  outputSchema: TObject;
  invoke(input: unknown, context: ToolContext): Promise<Record<string, unknown>>;
}

/** Validate arguments and results at any transport's tool boundary. */
export function defineTool<I extends TObject, O extends TObject>(definition: {
  name: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  execute(input: Static<I>, context: ToolContext): Promise<Static<O>>;
}) {
  return {
    ...definition,
    async invoke(input: unknown, context: ToolContext): Promise<Record<string, unknown>> {
      if (!Value.Check(definition.inputSchema, input)) {
        throw new Error('Invalid tool arguments.');
      }
      context.signal.throwIfAborted();
      const output = await definition.execute(input, context);
      context.signal.throwIfAborted();
      if (!Value.Check(definition.outputSchema, output)) {
        throw new Error('Tool returned an invalid result.');
      }
      return output;
    },
  } satisfies ToolDefinition;
}
