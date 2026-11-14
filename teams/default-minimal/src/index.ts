import type { TeamDefinition, TeamMember, TeamPackage } from '@ltcook/runtime/team-api';

const members: readonly TeamMember[] = [
  {
    key: 'main',
    name: 'Main',
    lifetime: 'persistent',
    modelAlias: 'smart',
    thinking: 'high',
    readOnly: false,
    roles: ['coordinator'],
    workTypes: ['design', 'plan.finalize', 'task.execute'],
    rules: ['rules/main.md'],
    skills: [],
  },
  {
    key: 'adjutant',
    name: 'Adjutant',
    lifetime: 'persistent',
    modelAlias: 'smol',
    thinking: 'medium',
    readOnly: false,
    roles: ['adjutant'],
    workTypes: ['plan.prefill', 'task.execute'],
    rules: ['rules/adjutant.md'],
    skills: [],
  },
];
const resources = ['rules/main.md', 'rules/adjutant.md'] as const;
export const definition: TeamDefinition = {
  id: '@ltcook/team-default-minimal',
  name: 'Default Minimal',
  coordinatorKey: 'main',
  routing: {
    design: 'main',
    'plan.prefill': 'adjutant',
    'plan.finalize': 'main',
    'task.execute': 'main',
  },
  members,
  resources: resources.map((path) => ({
    path,
    kind: 'rule' as const,
    scope: 'team' as const,
    required: true,
    url: new URL(`../resources/${path}`, import.meta.url).href,
  })),
  reviewPolicy: { mode: 'self', reviewerKeys: [], required: false },
};
const team: TeamPackage = { apiVersion: 2, definition };
export default team;
