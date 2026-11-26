import type { ModelAlias, ReasoningEffort } from '@ltcook/model-contracts';
import type { GuidanceResource } from '../guidance-api/index.js';
export type { ModelAlias } from '@ltcook/model-contracts';
export type WorkType = 'design' | 'plan.prefill' | 'plan.finalize' | 'task.execute';
export interface TeamMember {
  key: string;
  name: string;
  lifetime: 'persistent' | 'temporary';
  modelAlias: ModelAlias;
  thinking?: ReasoningEffort;
  readOnly: boolean;
  roles: readonly string[];
  workTypes: readonly WorkType[];
  rules: readonly string[];
  skills: readonly string[];
}
export interface ReviewPolicy {
  mode: 'independent' | 'self';
  reviewerKeys: readonly string[];
  required: boolean;
}
export interface TeamDefinition {
  id: string;
  name: string;
  leaderKey: string;
  members: readonly TeamMember[];
  resources: readonly GuidanceResource[];
  routing: Record<WorkType, string>;
  reviewPolicy: ReviewPolicy;
}
export interface WorkContext {
  workType: WorkType;
  sessionId: string;
  workspaceRoot: string;
}
export interface TeamPackage {
  apiVersion: 3;
  definition: TeamDefinition;
  selectAssignee?(
    context: Readonly<WorkContext>,
    eligible: readonly TeamMember[],
  ): string | Promise<string>;
}
