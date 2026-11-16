import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Skill, ResourceDiagnostic } from '@earendil-works/pi-coding-agent';
import type { GuidanceInspection, GuidanceResource, GuidanceScope } from '../guidance-api/index.js';
import type { TeamPackage } from '../team-api/index.js';

/** Safe resource diagnostics contain only resource identity and failure reason. */
export class NativeGuidanceError extends Error {}

/** Resolve mandatory and selected guidance before the native loader builds standing context. */
export class NativeGuidance {
  readonly inspection: GuidanceInspection = { resources: [], diagnostics: [] };
  readonly skillPaths: string[] = [];
  readonly rules: Array<{ path: string; content: string }> = [];
  private readonly sources = new Map<string, GuidanceResource>();
  private readonly userDirectory: string;
  private readonly resourceDiagnostics: GuidanceInspection['diagnostics'] = [];

  constructor(
    team: TeamPackage,
    memberKey: string,
    userDirectory: string,
    coreDirectory: string,
    private readonly reduced = false,
    private readonly sharedSkillsDirectory = '',
  ) {
    if (!path.isAbsolute(userDirectory))
      throw new NativeGuidanceError('User guidance directory must be an absolute AppRC path');
    if (sharedSkillsDirectory && !path.isAbsolute(sharedSkillsDirectory))
      throw new NativeGuidanceError('Shared skills directory must be an absolute user path');
    this.userDirectory = userDirectory;
    const member = team.definition.members.find((item) => item.key === memberKey);
    if (!member)
      throw new NativeGuidanceError('Native guidance member is not declared by the selected Team');
    const catalog: unknown = JSON.parse(
      readFileSync(path.join(coreDirectory, 'catalog.json'), 'utf8'),
    );
    if (!Array.isArray(catalog))
      throw new NativeGuidanceError('Core guidance catalog must be an array');
    const resources: GuidanceResource[] = catalog.map(
      (entry: { path: string; kind: 'rule' | 'skill'; required: boolean }) => ({
        ...entry,
        url: pathToFileURL(path.join(coreDirectory, entry.path)).href,
        scope: 'core',
      }),
    );
    resources.push(
      ...team.definition.resources.map((item) => ({ ...item, scope: 'team' as const })),
    );
    const userRules = path.join(userDirectory, 'rules');
    if (existsSync(userRules))
      for (const item of readdirSync(userRules, { recursive: true, withFileTypes: true })) {
        if (item.isFile() && item.name.endsWith('.md')) {
          const file = path.join(item.parentPath, item.name);
          resources.push({
            path: file,
            url: pathToFileURL(file).href,
            kind: 'rule',
            scope: 'user',
          });
        }
      }
    const names = new Map<string, string>();
    for (const resource of resources) {
      const file = resource.url.startsWith('file:') ? fileURLToPath(resource.url) : resource.path;
      const applicable =
        resource.scope !== 'team' || [...member.rules, ...member.skills].includes(resource.path);
      const row = {
        name: resource.path,
        path: file,
        scope: resource.scope ?? ('team' as GuidanceScope),
        kind: resource.kind,
        applicable,
        loaded: false,
      };
      this.inspection.resources.push(row);
      if (!applicable || (this.reduced && resource.scope !== 'core')) continue;
      if (!existsSync(file)) {
        this.inspection.diagnostics.push({ source: file, reason: 'Guidance resource is missing' });
        if (resource.required)
          throw new NativeGuidanceError(`Required guidance is missing: ${file}`);
        continue;
      }
      const physical = realpathSync(file);
      if (this.sources.has(physical)) continue;
      this.sources.set(physical, resource);
      if (resource.kind === 'rule') {
        const name = path.basename(file, '.md');
        const previous = names.get(name);
        if (previous && previous !== physical)
          throw new NativeGuidanceError(`Conflicting rule name ${name}: ${previous}, ${physical}`);
        names.set(name, physical);
        this.rules.push({ path: physical, content: readFileSync(physical, 'utf8') });
        row.loaded = true;
      } else this.skillPaths.push(file);
    }
    const userSkills = path.join(userDirectory, 'skills');
    if (!this.reduced && existsSync(userSkills)) this.skillPaths.push(userSkills);
    if (!this.reduced && sharedSkillsDirectory && existsSync(sharedSkillsDirectory))
      this.skillPaths.push(sharedSkillsDirectory);
    this.resourceDiagnostics.push(...this.inspection.diagnostics);
  }

  /** Native parser supplies names, invocation settings and actual successful load results. */
  skillsOverride = (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
    // > A reload replaces native loading results rather than accumulating old successes.
    this.inspection.diagnostics.splice(
      0,
      this.inspection.diagnostics.length,
      ...this.resourceDiagnostics,
    );
    for (const row of this.inspection.resources) if (row.kind === 'skill') row.loaded = false;
    for (const diagnostic of base.diagnostics) {
      const collision = diagnostic.collision;
      if (collision && realpathSync(collision.winnerPath) !== realpathSync(collision.loserPath))
        throw new NativeGuidanceError(
          `Conflicting skill name ${collision.name}: ${collision.winnerPath}, ${collision.loserPath}`,
        );
      this.inspection.diagnostics.push({
        source: diagnostic.path ?? 'native skill loader',
        reason: diagnostic.message,
        conflict: Boolean(collision),
      });
    }
    const physical = new Set<string>();
    const names = new Map<string, string>();
    const skills = base.skills.filter((skill) => {
      if (
        this.reduced &&
        !this.inspection.resources.some(
          (row) =>
            row.scope === 'core' &&
            existsSync(row.path) &&
            realpathSync(row.path) === realpathSync(skill.filePath),
        )
      )
        return false;
      const file = realpathSync(skill.filePath);
      const previous = names.get(skill.name);
      if (previous && previous !== file)
        throw new NativeGuidanceError(`Conflicting skill name ${skill.name}: ${previous}, ${file}`);
      names.set(skill.name, file);
      if (physical.has(file)) return false;
      physical.add(file);
      const resource = this.sources.get(file);
      const row = this.inspection.resources.find(
        (item) => existsSync(item.path) && realpathSync(item.path) === file,
      );
      if (row)
        Object.assign(row, {
          name: skill.name,
          loaded: true,
          explicitOnly: skill.disableModelInvocation,
        });
      else
        this.inspection.resources.push({
          name: skill.name,
          path: file,
          scope:
            resource?.scope ??
            ((this.userDirectory && file.startsWith(this.userDirectory + path.sep)) ||
            (this.sharedSkillsDirectory &&
              (skill.filePath.startsWith(this.sharedSkillsDirectory + path.sep) ||
                (existsSync(this.sharedSkillsDirectory) &&
                  file.startsWith(realpathSync(this.sharedSkillsDirectory) + path.sep))))
              ? 'user'
              : 'project'),
          kind: 'skill',
          applicable: true,
          loaded: true,
          explicitOnly: skill.disableModelInvocation,
        });
      return true;
    });
    for (const [file, resource] of this.sources)
      if (resource.kind === 'skill' && resource.required && !physical.has(file))
        throw new NativeGuidanceError(`Required skill was not loaded by Pi: ${file}`);
    return { skills, diagnostics: base.diagnostics.filter((item) => item.type !== 'collision') };
  };

  agentsFilesOverride = (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
    const files = new Map<string, { path: string; content: string }>();
    for (const row of this.inspection.resources) if (row.kind === 'rule') row.loaded = false;
    const rules: Array<{ path: string; content: string }> = [];
    for (const [file, resource] of this.sources) {
      if (resource.kind !== 'rule') continue;
      if (!existsSync(file)) {
        if (resource.required)
          throw new NativeGuidanceError(`Required guidance is missing: ${file}`);
        continue;
      }
      rules.push({ path: file, content: readFileSync(file, 'utf8') });
    }
    for (const item of [...(this.reduced ? [] : base.agentsFiles), ...rules]) {
      const file = realpathSync(item.path);
      if (files.has(file)) continue;
      files.set(file, item);
      const row = this.inspection.resources.find(
        (item) => existsSync(item.path) && realpathSync(item.path) === file,
      );
      if (row) row.loaded = true;
      else
        this.inspection.resources.push({
          name: path.basename(file),
          path: file,
          scope: 'project',
          kind: 'rule',
          applicable: true,
          loaded: true,
        });
    }
    return { agentsFiles: [...files.values()] };
  };
}

export function coreGuidanceDirectory(): string {
  return process.env.LTCOOK_JS_ROOT
    ? path.join(process.env.LTCOOK_JS_ROOT, 'runtime', 'resources')
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../resources');
}
