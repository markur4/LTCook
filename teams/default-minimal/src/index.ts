import type { TeamDefinition, TeamMember, TeamPackage } from '@ltcook/runtime/team-api';

const members: readonly TeamMember[] = [
  {
    key: 'leader',
    name: 'Leader',
    lifetime: 'persistent',
    modelAlias: 'smart',
    thinking: 'high',
    readOnly: false,
    roles: ['leader'],
    workTypes: ['design', 'plan.finalize', 'task.execute'],
    rules: ['rules/leader.md'],
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
const resources = ['rules/leader.md', 'rules/adjutant.md'] as const;
export const definition: TeamDefinition = {
  id: '@ltcook/team-default-minimal',
  name: 'Default Minimal',
  leaderKey: 'leader',
  routing: {
    design: 'leader',
    'plan.prefill': 'adjutant',
    'plan.finalize': 'leader',
    'task.execute': 'leader',
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
const team: TeamPackage = { apiVersion: 3, definition };
export default team;
