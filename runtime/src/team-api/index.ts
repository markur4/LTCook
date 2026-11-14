import type { GuidanceResource } from '../guidance-api/index.js';
export type WorkType = 'design' | 'plan.prefill' | 'plan.finalize' | 'task.execute';
export type ModelAlias = 'smart' | 'smol' | 'plan';
export interface TeamMember {
  key: string;
  name: string;
  lifetime: 'persistent' | 'temporary';
  modelAlias: ModelAlias;
  thinking: string;
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
  coordinatorKey: string;
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
  apiVersion: 2;
  definition: TeamDefinition;
  selectAssignee?(
    context: Readonly<WorkContext>,
    eligible: readonly TeamMember[],
  ): string | Promise<string>;
}
