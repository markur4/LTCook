import { describe, expect, test } from 'bun:test';
import type { TeamPackage } from '@ltcook/runtime/api';
import defaultTeam from '@ltcook/team-default';
import minimalTeam from '@ltcook/team-default-minimal';
import { nativeToolAllowed } from '../../../runtime/src/integrations/native-policy.js';

const packages: TeamPackage[] = [defaultTeam, minimalTeam];

describe.each(packages)('team API contract: %s', (team) => {
  test('declares a supported API, a unique coordinator, and resolvable instructions', () => {
    expect(team.apiVersion).toBe(1);
    expect(
      team.definition.members.filter((member) => member.key === team.definition.coordinatorKey),
    ).toHaveLength(1);
    for (const member of team.definition.members) {
      expect(
        member.instructionPaths.every((path) =>
          team.definition.resources.some((resource) => resource.path === path),
        ),
      ).toBe(true);
    }
  });
});

test('Pass reviewers can fix findings through native editing tools', () => {
  for (const reviewerKey of defaultTeam.definition.reviewPolicy.reviewerKeys) {
    const reviewer = defaultTeam.definition.members.find((member) => member.key === reviewerKey);
    if (!reviewer) throw new Error(`Review policy references an undeclared member: ${reviewerKey}`);
    expect(nativeToolAllowed(reviewer.readOnly, 'edit')).toBe(true);
    expect(nativeToolAllowed(reviewer.readOnly, 'write')).toBe(true);
  }
});
