import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ModelAliasSchema, ReasoningEffortSchema } from '@ltcook/model-contracts';
import type { TeamPackage } from '../team-api/index.js';

export interface TeamCatalogEntry {
  origin: 'bundled';
  selection: string;
  teamId: string;
  name: string;
  description: string;
  status: 'installed' | 'available' | 'invalid';
  reason?: string;
  leader: { key: string; name: string };
  persistentMembers: number;
  temporaryMembers: number;
}

const strings = z.array(z.string().min(1));
const workType = z.enum(['design', 'plan.prefill', 'plan.finalize', 'task.execute']);
const packageSchema = z.object({
  apiVersion: z.literal(3),
  definition: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    leaderKey: z.literal('leader'),
    members: z.array(
      z.object({
        key: z.string().min(1),
        name: z.string().min(1),
        lifetime: z.enum(['persistent', 'temporary']),
        modelAlias: ModelAliasSchema,
        thinking: ReasoningEffortSchema.optional(),
        readOnly: z.boolean(),
        roles: strings,
        workTypes: z.array(workType),
        rules: strings,
        skills: strings,
      }),
    ),
    resources: z.array(
      z.object({
        path: z.string().min(1),
        url: z.string().min(1),
        kind: z.enum(['rule', 'skill']),
        required: z.boolean().optional(),
        scope: z.enum(['core', 'team', 'project', 'user']).optional(),
      }),
    ),
    routing: z.object({
      design: z.string(),
      'plan.prefill': z.string(),
      'plan.finalize': z.string(),
      'task.execute': z.string(),
    }),
    reviewPolicy: z.object({
      mode: z.enum(['independent', 'self']),
      reviewerKeys: strings,
      required: z.boolean(),
    }),
  }),
  selectAssignee: z
    .custom<NonNullable<TeamPackage['selectAssignee']>>((value) => typeof value === 'function')
    .optional(),
});

/** Validate managed application modules before admitting them to the runtime. */
export function validateTeam(value: unknown): TeamPackage {
  const team: TeamPackage = packageSchema.parse(value);
  const definition = team.definition;
  const keys = new Set(definition.members.map((member) => member.key));
  const leader = definition.members.find((member) => member.key === definition.leaderKey);
  if (
    keys.size !== definition.members.length ||
    !leader ||
    leader.lifetime !== 'persistent' ||
    !leader.roles.includes('leader')
  )
    throw new Error('Team must declare one persistent Leader');
  for (const type of ['design', 'plan.prefill', 'plan.finalize', 'task.execute'] as const) {
    const member = definition.members.find((member) => member.key === definition.routing?.[type]);
    if (!member?.workTypes.includes(type)) throw new Error(`Invalid routing for ${type}`);
  }
  if (
    !definition.reviewPolicy ||
    !Array.isArray(definition.reviewPolicy.reviewerKeys) ||
    definition.reviewPolicy.reviewerKeys.some((key) => !keys.has(key))
  )
    throw new Error('Invalid Team review policy');
  return team;
}

/** Catalog only packages from the managed teams workspace, never browser import strings. */
export class TeamRegistry {
  private readonly packages = new Map<string, TeamPackage>();
  private readonly entries = new Map<string, TeamCatalogEntry>();
  constructor(teams: readonly TeamPackage[] = []) {
    for (const team of teams) this.register(team.definition.id, team);
  }
  private register(selection: string, value: unknown, description = ''): void {
    const team = validateTeam(value);
    if (
      [...this.packages.values()].some((existing) => existing.definition.id === team.definition.id)
    )
      throw new Error(`Duplicate Team identity: ${team.definition.id}`);
    this.packages.set(selection, team);
    const leader = team.definition.members.find(
      (member) => member.key === team.definition.leaderKey,
    )!;
    this.entries.set(selection, {
      origin: 'bundled',
      selection,
      teamId: team.definition.id,
      name: team.definition.name,
      description,
      status: 'installed',
      leader: { key: leader.key, name: leader.name },
      persistentMembers: team.definition.members.filter(
        (member) => member.lifetime === 'persistent',
      ).length,
      temporaryMembers: team.definition.members.filter((member) => member.lifetime === 'temporary')
        .length,
    });
  }
  static async load(
    root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
  ): Promise<TeamRegistry> {
    const registry = new TeamRegistry();
    for (const directory of (await readdir(path.join(root, 'teams'), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (!directory.isDirectory()) continue;
      const selection = directory.name;
      let teamId = selection;
      let description = '';
      try {
        const manifest: unknown = JSON.parse(
          await readFile(path.join(root, 'teams', selection, 'package.json'), 'utf8'),
        );
        if (
          !manifest ||
          typeof manifest !== 'object' ||
          !('name' in manifest) ||
          typeof manifest.name !== 'string'
        )
          throw new Error('Missing Team package name');
        teamId = manifest.name;
        description =
          'description' in manifest && typeof manifest.description === 'string'
            ? manifest.description
            : '';
        const loaded = (await import(teamId)) as { default?: unknown };
        const team = validateTeam(loaded.default);
        if (team.definition.id !== teamId)
          throw new Error('Team identity does not match its local package name');
        registry.register(selection, team, description);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Team package could not be loaded';
        const missing =
          error instanceof Error &&
          'code' in error &&
          ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(String(error.code));
        registry.entries.set(selection, {
          origin: 'bundled',
          selection,
          teamId,
          name: selection,
          description,
          status: missing ? 'available' : 'invalid',
          reason,
          leader: { key: 'leader', name: 'Leader' },
          persistentMembers: 0,
          temporaryMembers: 0,
        });
      }
    }
    return registry;
  }
  catalog(): TeamCatalogEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry, leader: { ...entry.leader } }));
  }
  resolve(selection: string): TeamPackage {
    const team =
      this.packages.get(selection) ??
      [...this.packages.values()].find((team) => team.definition.id === selection);
    if (!team)
      throw new Error(
        `Team is unavailable or invalid: ${selection}; rebuild or reinstall its local package`,
      );
    return team;
  }
}

/** Resolve an explicitly selected local Team for a native agent process. */
export async function loadTeam(selection: string, root?: string): Promise<TeamPackage> {
  return (await TeamRegistry.load(root)).resolve(selection);
}
