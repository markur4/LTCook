import type {
  TeamDefinition,
  TeamMember,
  TeamPackage,
  TeamServiceRuntime,
  TeamAgentRuntime,
} from '@ltcook/runtime/api';

const members: readonly TeamMember[] = [
  {
    key: 'main',
    name: 'Main',
    lifetime: 'persistent',
    modelAlias: 'smart',
    thinking: 'high',
    readOnly: false,
    instructionPaths: ['rules/main.md', 'skills/lookup.md', 'skills/explore.md'],
  },
  {
    key: 'adjutant',
    name: 'Adjutant',
    lifetime: 'persistent',
    modelAlias: 'smol',
    thinking: 'medium',
    readOnly: false,
    instructionPaths: ['rules/adjutant.md'],
  },
];
const resources = [
  'rules/main.md',
  'rules/adjutant.md',
  'skills/lookup.md',
  'skills/explore.md',
] as const;
export const definition: TeamDefinition = {
  id: '@ltcook/team-default-minimal',
  name: 'Default Minimal',
  coordinatorKey: 'main',
  members,
  resources: resources.map((path) => ({
    path,
    url: new URL(`../resources/${path}`, import.meta.url).href,
  })),
  reviewPolicy: { mode: 'self', reviewerKeys: [], required: false },
};
export function activateService(runtime: TeamServiceRuntime): void {
  if (runtime.definition.id !== definition.id)
    throw new Error('Minimal team activation received a different definition');
}
export function activateAgent(runtime: TeamAgentRuntime): void {
  if (runtime.definition.id !== definition.id)
    throw new Error('Minimal team agent received a different definition');
  const member = runtime.definition.members.find(
    (candidate) => candidate.key === runtime.identity.memberKey,
  );
  if (member === undefined) throw new Error(`Unknown team member: ${runtime.identity.memberKey}`);
  runtime.instructions.register(
    runtime.definition.resources.filter((resource) =>
      member.instructionPaths.includes(resource.path),
    ),
  );
}
const team: TeamPackage = { apiVersion: 1, definition, activateService, activateAgent };
export default team;
