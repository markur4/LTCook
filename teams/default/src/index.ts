import type { TeamDefinition, TeamMember, TeamPackage, TeamServiceRuntime, TeamAgentRuntime, WorkflowPolicy } from '@ltcook/runtime/api';

const members: readonly TeamMember[] = [
  { key: 'main', name: 'Main', lifetime: 'persistent', modelAlias: 'smart', thinking: 'high', readOnly: false, instructionPaths: ['rules/delegation.md', 'rules/clear-writing.md', 'skills/lookup.md', 'skills/explore.md'] },
  { key: 'adjutant', name: 'Adjutant', lifetime: 'persistent', modelAlias: 'smol', thinking: 'medium', readOnly: false, instructionPaths: ['rules/delegation.md', 'rules/clear-writing.md'] },
  { key: 'senior', name: 'Senior', lifetime: 'persistent', modelAlias: 'smart', thinking: 'medium', readOnly: false, instructionPaths: ['rules/engineering.md'] },
  { key: 'junior', name: 'Junior', lifetime: 'persistent', modelAlias: 'smol', thinking: 'high', readOnly: false, instructionPaths: ['rules/engineering.md'] },
  { key: 'reviewer', name: 'Reviewer', lifetime: 'persistent', modelAlias: 'plan', thinking: 'high', readOnly: true, instructionPaths: ['rules/review.md'] },
  { key: 'explorer', name: 'Explorer', lifetime: 'persistent', modelAlias: 'smol', thinking: 'xhigh', readOnly: true, instructionPaths: ['skills/lookup.md', 'skills/explore.md'] },
  { key: 'senior-tmp', name: 'Senior (temporary)', lifetime: 'temporary', modelAlias: 'smart', thinking: 'medium', readOnly: false, instructionPaths: ['rules/engineering.md'] },
  { key: 'junior-tmp', name: 'Junior (temporary)', lifetime: 'temporary', modelAlias: 'smol', thinking: 'medium', readOnly: false, instructionPaths: ['rules/engineering.md'] },
  { key: 'reviewer-tmp', name: 'Reviewer (temporary)', lifetime: 'temporary', modelAlias: 'plan', thinking: 'high', readOnly: true, instructionPaths: ['rules/review.md'] },
  { key: 'explorer-tmp', name: 'Explorer (temporary)', lifetime: 'temporary', modelAlias: 'smol', thinking: 'medium', readOnly: true, instructionPaths: ['skills/lookup.md', 'skills/explore.md'] },
];
const resources = ['rules/delegation.md', 'rules/clear-writing.md', 'rules/engineering.md', 'rules/review.md', 'skills/lookup.md', 'skills/explore.md'] as const;
export const definition: TeamDefinition = {
  id: '@ltcook/team-default', name: 'Default', coordinatorKey: 'main', members,
  resources: resources.map((path) => ({ path, url: new URL(`../resources/${path}`, import.meta.url).href })),
  reviewPolicy: { mode: 'independent', reviewerKeys: ['reviewer', 'reviewer-tmp'], required: true },
};
function policyFor(team: TeamDefinition): WorkflowPolicy {
  return { coordinatorKey: team.coordinatorKey, delegateKeys: team.members.filter((member) => member.key !== team.coordinatorKey).map((member) => member.key), review: team.reviewPolicy };
}
export function activateService(runtime: TeamServiceRuntime): void {
  if (runtime.definition.id !== definition.id) throw new Error('Default team activation received a different definition');
  runtime.workflows.register(policyFor(runtime.definition));
}
export function activateAgent(runtime: TeamAgentRuntime): void {
  if (runtime.definition.id !== definition.id) throw new Error('Default team agent received a different definition');
  const member = runtime.definition.members.find((candidate) => candidate.key === runtime.identity.memberKey);
  if (member === undefined) throw new Error(`Unknown team member: ${runtime.identity.memberKey}`);
  runtime.instructions.register(runtime.definition.resources.filter((resource) => member.instructionPaths.includes(resource.path)));
}
const team: TeamPackage = { apiVersion: 1, definition, activateService, activateAgent };
export default team;
