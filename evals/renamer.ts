import { resolveModel } from '../runtime/src/models/aliases.js';
import { createWorkspaceMetadataGenerator } from '../runtime/src/services/workspace-metadata-inference.js';
import {
  boundedWorkspaceTitle,
  RenameProposalSchema,
} from '../runtime/src/services/workspace-metadata.js';
import { WORKSPACE_TITLE_LIMIT } from '../runtime/src/services/renamer.js';

const model = resolveModel('tiny', process.env);
if (model.provider !== 'openai-codex' || model.model !== 'gpt-6-luna' || model.reasoning !== 'low')
  throw new Error(
    'This Agent Eval requires hosted GPT-6 Luna at the configured @tiny low reasoning.',
  );

const started = performance.now();
const proposal = RenameProposalSchema.parse(
  await createWorkspaceMetadataGenerator().rename(
    {
      id: 'rename-fixture',
      workspaceId: 'fixture-workspace',
      agentId: 'fixture-agent',
      nameWorkspace: true,
      nameTab: false,
      projectName: 'LTCook',
      workspaceTitle: 'LTCook login issue',
      agentTitle: '',
      prompt: 'Fix the crash on login in the LTCook project.',
    },
    AbortSignal.timeout(60_000),
  ),
);
const proposedTitle = proposal.workspaceTitle ?? '';
const title = boundedWorkspaceTitle(proposedTitle, WORKSPACE_TITLE_LIMIT);
if (
  /ltcook/i.test(proposedTitle) ||
  !/(login|sign[ -]?in|auth)/i.test(title) ||
  proposal.agents.length
)
  throw new Error(
    `Expected a workspace title that identifies the login task and omits the project name. Proposal was ${JSON.stringify(proposedTitle)}.`,
  );

console.log(
  JSON.stringify({
    model: model.model,
    reasoning: model.reasoning,
    title,
    elapsedMs: Math.round(performance.now() - started),
  }),
);
