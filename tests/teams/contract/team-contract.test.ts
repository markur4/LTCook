import { describe, expect, test } from 'bun:test';
import type { TeamAgentRuntime, TeamPackage, TeamServiceRuntime, WorkflowPolicy } from '@ltcook/runtime/api';
import defaultTeam from '@ltcook/team-default';
import minimalTeam from '@ltcook/team-default-minimal';

const packages: TeamPackage[] = [defaultTeam, minimalTeam];
function serviceRuntime(team: TeamPackage, registered: WorkflowPolicy[]): TeamServiceRuntime {
  return {
    definition: team.definition,
    session: { id: 'session', teamId: team.definition.id, workspaceRoot: '/workspace', createdAt: '2026-01-01T00:00:00.000Z' },
    coordination: { snapshot: async () => { throw new Error('not used'); }, execute: async () => undefined },
    agents: { ensure: async () => { throw new Error('not used'); }, list: () => [], close: async () => undefined },
    messaging: { send: async () => undefined },
    workflows: { register: (policy) => registered.push(policy) },
  };
}
function agentRuntime(team: TeamPackage, installed: string[][]): TeamAgentRuntime {
  return {
    definition: team.definition,
    identity: { sessionId: 'session', teamId: team.definition.id, memberKey: team.definition.coordinatorKey, nativeAgentId: 'native-main' },
    coordination: { snapshot: async () => { throw new Error('not used'); }, execute: async () => undefined },
    instructions: { register: (resources) => installed.push(resources.map((resource) => resource.path)) },
  };
}

describe.each(packages)('team API contract: %s', (team) => {
  test('publishes API version 1, one coordinator, and declared resources', () => {
    expect(team.apiVersion).toBe(1);
    expect(team.definition.members.filter((member) => member.key === team.definition.coordinatorKey)).toHaveLength(1);
    expect(team.definition.resources.length).toBeGreaterThan(0);
    for (const member of team.definition.members) {
      expect(member.instructionPaths.every((path) => team.definition.resources.some((resource) => resource.path === path))).toBe(true);
    }
  });

  test('activates the selected team workflow and selected resources through the public contract', async () => {
    const policies: WorkflowPolicy[] = [];
    const resources: string[][] = [];
    await team.activateService(serviceRuntime(team, policies));
    await team.activateAgent(agentRuntime(team, resources));
    expect(policies).toHaveLength(1);
    expect(policies[0]?.coordinatorKey).toBe(team.definition.coordinatorKey);
    expect(resources).toEqual([team.definition.members.find((member) => member.key === team.definition.coordinatorKey)?.instructionPaths]);
  });

});
test('default declares six persistent members and four explicit temporary roles', () => {
  expect(defaultTeam.definition.members.filter((member) => member.lifetime === 'persistent')).toHaveLength(6);
  expect(defaultTeam.definition.members.filter((member) => member.lifetime === 'temporary')).toHaveLength(4);
  expect(defaultTeam.definition.reviewPolicy).toMatchObject({ mode: 'independent', required: true });
});

test('minimal is exactly persistent Main and Adjutant with no independent review claim', () => {
  expect(minimalTeam.definition.members.map((member) => [member.name, member.lifetime])).toEqual([['Main', 'persistent'], ['Adjutant', 'persistent']]);
  expect(minimalTeam.definition.reviewPolicy).toMatchObject({ mode: 'self', reviewerKeys: [], required: false });
});
