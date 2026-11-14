export type GuidanceScope = 'core' | 'team' | 'project' | 'user';
export type GuidanceKind = 'rule' | 'skill';
export interface GuidanceResource {
  path: string;
  url: string;
  kind: GuidanceKind;
  required?: boolean;
  scope?: GuidanceScope;
}
export interface GuidanceInspection {
  resources: {
    name: string;
    path: string;
    scope: GuidanceScope;
    kind: GuidanceKind;
    applicable: boolean;
    loaded: boolean;
    explicitOnly?: boolean;
  }[];
  diagnostics: { source: string; reason: string; conflict?: boolean }[];
}
