import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { loadTeam } from '../integrations/team-loader.js';
import { NativeGuidance } from '../integrations/native-guidance.js';
import { hash, resourceIdentity } from './setup.js';

/** Native resource parsing and guidance composition without a model or executable extensions. */
export async function staticAudit(input: {
  team: Awaited<ReturnType<typeof loadTeam>>;
  workspace: string;
  guidance: string;
  resources: string;
}) {
  const resources = [];
  const findings: Array<Record<string, unknown>> = [];
  for (const member of input.team.definition.members) {
    let guidance: NativeGuidance;
    try {
      guidance = new NativeGuidance(
        input.team,
        member.key,
        input.guidance,
        input.resources,
        false,
        path.join(input.guidance, 'shared-skills'),
      );
    } catch (error) {
      findings.push({
        kind: 'resource-load-error',
        member: member.key,
        reason: (error instanceof Error ? error.message : 'Native resource loading failed')
          .replaceAll(input.resources, '<core>')
          .replaceAll(input.guidance, '<user>')
          .replaceAll(input.workspace, '<project>'),
      });
      continue;
    }
    const loader = new DefaultResourceLoader({
      cwd: input.workspace,
      agentDir: input.guidance,
      settingsManager: SettingsManager.inMemory({}),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      // > Audit only captured inputs, never the host's automatically discovered skills.
      additionalSkillPaths: [
        ...guidance.skillPaths,
        ...['.agents', '.pi']
          .map((directory) => path.join(input.workspace, directory, 'skills'))
          .filter((directory) => existsSync(directory)),
      ],
      skillsOverride: guidance.skillsOverride,
      agentsFilesOverride: guidance.agentsFilesOverride,
    });
    try {
      await loader.reload();
    } catch (error) {
      findings.push({
        kind: 'resource-load-error',
        member: member.key,
        reason: error instanceof Error ? error.message : 'Native resource loading failed',
      });
    }
    for (const resource of guidance.inspection.resources) {
      if (resource.loaded) {
        const words = (await readFile(resource.path, 'utf8')).split(/\s+/).length;
        if (words > 3000)
          findings.push({
            kind: 'large_resource',
            member: member.key,
            source: resourceIdentity(resource, input.workspace, input.guidance),
            words,
          });
      }
      resources.push({
        member: member.key,
        ...resource,
        name: path.isAbsolute(resource.name) ? path.basename(resource.name) : resource.name,
        path: resourceIdentity(resource, input.workspace, input.guidance),
        ...(resource.loaded ? { sha256: hash(await readFile(resource.path)) } : {}),
      });
    }
  }
  const seen = new Map<string, string>();
  for (const resource of resources)
    if (resource.sha256) {
      const prior = seen.get(resource.sha256);
      if (prior && prior !== resource.path)
        findings.push({ kind: 'duplicate', sources: [prior, resource.path] });
      seen.set(resource.sha256, resource.path);
    }
  return {
    resources,
    resourceCount: resources.length,
    loadedResourceCount: resources.filter((resource) => resource.loaded).length,
    uniqueContentCount: seen.size,
    findings,
    coverageComplete: false,
    coverageNote:
      'Production guidance and Pi resource loaders; executable extension-generated instructions require semantic runtime capture.',
  };
}
