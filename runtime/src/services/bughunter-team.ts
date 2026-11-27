import type { TeamMember, TeamPackage } from '../team-api/index.js';

export const bugHunterTeamId = '@ltcook/internal-bughunter';
export const bugHunterInvestigatorKeys = [
  'investigator-1',
  'investigator-2',
  'investigator-3',
] as const;
export const bugFixWorkerKeys = {
  'proper-fix': ['proper-fix-1', 'proper-fix-2', 'proper-fix-3'],
  workaround: ['workaround-1', 'workaround-2', 'workaround-3'],
} as const;
export const bugFixReviewerKey = 'bugfix-reviewer';

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
      ...Object.entries(bugFixWorkerKeys).flatMap(([kind, keys]) =>
        keys.map((key): TeamMember => ({
          key,
          name:
            kind === 'proper-fix' ? 'BugHunter Proper Fix Worker' : 'BugHunter Workaround Worker',
          lifetime: 'temporary',
          modelAlias: kind === 'proper-fix' ? 'medium' : 'smol',
          thinking: kind === 'proper-fix' ? 'high' : 'xhigh',
          readOnly: false,
          roles: ['worker'],
          workTypes: ['task.execute'],
          rules: [],
          skills: [],
        })),
      ),
      {
        ...coordinator,
        key: bugFixReviewerKey,
        name: 'BugHunter Reviewer',
        lifetime: 'temporary',
        modelAlias: 'smart',
        thinking: 'high',
        roles: ['reviewer'],
        workTypes: ['task.execute'],
      },
    ],
    reviewPolicy: { mode: 'independent', reviewerKeys: [bugFixReviewerKey], required: true },
    resources: [],
  },
};

export interface BugScanNativeRequest {
  workspaceRoot: string;
  recordWorkspaceRoot?: string;
  huntId?: string;
  requestId: string;
  role: 'coordinator' | 'investigator';
  workerSlot?: 0 | 1 | 2;
  brief: string;
  evidence: unknown;
  sourceRevision?: string;
  sourceRepositoryRoot?: string;
  signal: AbortSignal;
}

export interface BugFixNativeTask {
  id: string;
  kind: keyof typeof bugFixWorkerKeys;
  paths: readonly string[];
  brief: string;
  acceptance: string;
}

export interface BugFixNativeRequest {
  workspaceRoot: string;
  recordWorkspaceRoot: string;
  huntId: string;
  requestId: string;
  tasks: readonly BugFixNativeTask[];
  authorize(action: 'edit' | 'verify', taskId: string, relativePath?: string): boolean;
  signal: AbortSignal;
}
