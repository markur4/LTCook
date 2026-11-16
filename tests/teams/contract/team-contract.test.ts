import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import type { TeamPackage } from '@ltcook/runtime/team-api';
import defaultTeam from '@ltcook/team-default';
import minimalTeam from '@ltcook/team-default-minimal';
import { nativeToolAllowed } from '../../../runtime/src/integrations/native-policy.js';

const packages: TeamPackage[] = [defaultTeam, minimalTeam];
const expectedMembers = new Map([
  [
    defaultTeam.definition.id,
    [
      [
        'leader',
        'persistent',
        'smart',
        'high',
        false,
        ['leader'],
        ['design', 'plan.finalize', 'task.execute'],
      ],
      [
        'adjutant',
        'persistent',
        'smol',
        'medium',
        false,
        ['adjutant'],
        ['plan.prefill', 'task.execute'],
      ],
      ['senior', 'persistent', 'smart', 'medium', false, ['senior'], ['task.execute']],
      ['junior', 'persistent', 'smol', 'high', false, ['junior'], ['task.execute']],
      ['reviewer', 'persistent', 'plan', 'high', false, ['reviewer'], ['task.execute']],
      ['explorer', 'persistent', 'smol', 'xhigh', true, ['explorer'], ['task.execute']],
      ['senior-tmp', 'temporary', 'smart', 'medium', false, ['senior'], ['task.execute']],
      ['junior-tmp', 'temporary', 'smol', 'medium', false, ['junior'], ['task.execute']],
      ['reviewer-tmp', 'temporary', 'plan', 'high', false, ['reviewer'], ['task.execute']],
      ['explorer-tmp', 'temporary', 'smol', 'medium', true, ['explorer'], ['task.execute']],
    ],
  ],
  [
    minimalTeam.definition.id,
    [
      [
        'leader',
        'persistent',
        'smart',
        'high',
        false,
        ['leader'],
        ['design', 'plan.finalize', 'task.execute'],
      ],
      [
        'adjutant',
        'persistent',
        'smol',
        'medium',
        false,
        ['adjutant'],
        ['plan.prefill', 'task.execute'],
      ],
    ],
  ],
]);

const expectedRoutes = new Map([
  [
    defaultTeam.definition.id,
    {
      design: 'leader',
      'plan.prefill': 'adjutant',
      'plan.finalize': 'leader',
      'task.execute': 'senior',
    },
  ],
  [
    minimalTeam.definition.id,
    {
      design: 'leader',
      'plan.prefill': 'adjutant',
      'plan.finalize': 'leader',
      'task.execute': 'leader',
    },
  ],
]);

for (const team of packages) {
  describe(`team API contract: ${team.definition.id}`, () => {
    test('declares v3 routing and keeps member identities and model settings', () => {
      expect(team.apiVersion).toBe(3);
      expect(
        team.definition.members.filter((member) => member.key === team.definition.leaderKey),
      ).toHaveLength(1);

      expect(team.definition.routing).toEqual(expectedRoutes.get(team.definition.id));
      const members = team.definition.members.map(
        ({ key, lifetime, modelAlias, thinking, readOnly, roles, workTypes }) => [
          key,
          lifetime,
          modelAlias,
          thinking,
          readOnly,
          roles,
          workTypes,
        ],
      );
      expect(members).toEqual(expectedMembers.get(team.definition.id));

      for (const [workType, memberKey] of Object.entries(team.definition.routing)) {
        const assignee = team.definition.members.find((member) => member.key === memberKey);
        expect(assignee?.workTypes).toContain(workType);
      }
    });

    test('uses separate Team rule and skill references backed by required local resources', () => {
      const resourceByPath = new Map(
        team.definition.resources.map((resource) => [resource.path, resource]),
      );
      expect(resourceByPath.size).toBe(team.definition.resources.length);
      expect(resourceByPath.has('rules/clear-writing.md')).toBe(false);

      for (const resource of team.definition.resources) {
        expect(resource.scope).toBe('team');
        expect(resource.required).toBe(true);
        expect(existsSync(fileURLToPath(resource.url))).toBe(true);
      }

      for (const member of team.definition.members) {
        expect(member.roles.length).toBeGreaterThan(0);
        for (const path of member.rules) expect(resourceByPath.get(path)?.kind).toBe('rule');
        for (const path of member.skills) expect(resourceByPath.get(path)?.kind).toBe('skill');
      }
    });
  });
}

test('Core guidance catalog keeps functional resources required', () => {
  const resourcesRoot = resolve(import.meta.dir, '../../../runtime/resources');
  const catalog = JSON.parse(readFileSync(resolve(resourcesRoot, 'catalog.json'), 'utf8')) as {
    path: string;
    kind: 'rule' | 'skill';
    required: boolean;
  }[];
  const byPath = new Map(catalog.map((resource) => [resource.path, resource]));

  expect(byPath.size).toBe(catalog.length);
  for (const resource of catalog)
    expect(existsSync(resolve(resourcesRoot, resource.path))).toBe(true);
  for (const path of ['rules/planning.md']) {
    expect(byPath.get(path)).toMatchObject({ kind: 'rule', required: true });
  }
  for (const path of [
    'skills/ltcook-planning/SKILL.md',
    'skills/ltcook-lookup/SKILL.md',
    'skills/ltcook-explore/SKILL.md',
  ]) {
    expect(byPath.get(path)).toMatchObject({ kind: 'skill', required: true });
  }
});

test('Core SKILL.md files pass the native Pi parser', () => {
  const skillsDirectory = resolve(import.meta.dir, '../../../runtime/resources/skills');
  const loaded = loadSkillsFromDir({ dir: skillsDirectory, source: 'ltcook-core' });

  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.skills.map((skill) => skill.name).sort()).toEqual([
    'ltcook-explore',
    'ltcook-lookup',
    'ltcook-planning',
  ]);
});

test('Team API v3 preserves both review policies', () => {
  expect(defaultTeam.definition.reviewPolicy).toEqual({
    mode: 'independent',
    reviewerKeys: ['reviewer', 'reviewer-tmp'],
    required: true,
  });
  expect(minimalTeam.definition.reviewPolicy).toEqual({
    mode: 'self',
    reviewerKeys: [],
    required: false,
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
