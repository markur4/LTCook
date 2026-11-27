import type { TeamMember, TeamPackage } from '../team-api/index.js';

export const bugHunterTeamId = '@ltcook/internal-bughunter';
export const bugHunterInvestigatorKeys = [
  'investigator-1',
  'investigator-2',
  'investigator-3',
] as const;

const coordinator: TeamMember = {
  key: 'leader',
  name: 'BugHunter Coordinator',
  lifetime: 'persistent',
  modelAlias: 'medium',
  thinking: 'high',
  readOnly: true,
  roles: ['leader'],
  workTypes: ['design', 'plan.prefill', 'plan.finalize', 'task.execute'],
  rules: [],
  skills: [],
};

export const bugHunterTeam: TeamPackage = {
  apiVersion: 3,
  definition: {
    id: bugHunterTeamId,
    name: 'BugHunter',
    leaderKey: 'leader',
    routing: {
      design: 'leader',
      'plan.prefill': 'leader',
      'plan.finalize': 'leader',
      'task.execute': 'leader',
    },
    members: [
      coordinator,
      ...bugHunterInvestigatorKeys.map((key): TeamMember => ({
        ...coordinator,
        key,
        name: 'BugHunter Investigator',
        lifetime: 'temporary',
        roles: ['investigator'],
        workTypes: ['design'],
      })),
    ],
    reviewPolicy: { mode: 'self', reviewerKeys: [], required: false },
    resources: [],
  },
};

export interface BugScanNativeRequest {
  workspaceRoot: string;
  recordWorkspaceRoot?: string;
  requestId: string;
  role: 'coordinator' | 'investigator';
  workerSlot?: 0 | 1 | 2;
  brief: string;
  evidence: unknown;
  sourceRevision?: string;
  sourceRepositoryRoot?: string;
  signal: AbortSignal;
}
