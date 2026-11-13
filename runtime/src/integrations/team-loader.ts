import type { TeamPackage } from '../api/team.js';

/** Load the one selected version-1 team package for native and service entrypoints. */
export async function selectedTeam(selection: string): Promise<TeamPackage> {
  const moduleName =
    selection === 'default'
      ? '@ltcook/team-default'
      : selection === 'default-minimal'
        ? '@ltcook/team-default-minimal'
        : selection;
  const loaded = (await import(moduleName)) as { default?: TeamPackage };
  const team = loaded.default;
  if (!team || team.apiVersion !== 1) {
    throw new Error(`Selected team module does not export apiVersion 1: ${selection}`);
  }
  return team;
}
