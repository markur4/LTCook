import { afterEach, expect, test } from 'bun:test';
import {
  DefaultResourceLoader,
  SettingsManager,
  formatSkillsForPrompt,
} from '@earendil-works/pi-coding-agent';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeGuidance } from '../../../runtime/src/integrations/native-guidance.js';
import minimal from '../../../teams/default-minimal/src/index.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ltcook-guidance-'));
  roots.push(root);
  const core = path.join(root, 'core');
  const user = path.join(root, 'user');
  const project = path.join(root, 'project');
  const agentDir = path.join(root, 'browser-home', '.pi');
  for (const dir of [core, user, project, agentDir]) mkdirSync(dir, { recursive: true });
  function file(relative: string, text: string) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
    return target;
  }
  file('core/rules/baseline.md', 'Standing Core requirement.');
  file(
    'core/skills/ltcook-method/SKILL.md',
    '---\nname: ltcook-method\ndescription: Shared method\n---\nSecret body should be read on demand.',
  );
  file(
    'core/catalog.json',
    JSON.stringify([
      { path: 'rules/baseline.md', kind: 'rule', required: true },
      { path: 'skills/ltcook-method/SKILL.md', kind: 'skill', required: true },
    ]),
  );
  const team = {
    ...minimal,
    definition: {
      ...minimal.definition,
      resources: [],
      members: minimal.definition.members.map((member) => ({ ...member, rules: [], skills: [] })),
    },
  };
  const guidance = () => new NativeGuidance(team, 'main', user, core);
  async function load(managed: NativeGuidance, projectTrusted = true) {
    const settingsManager = SettingsManager.create(project, agentDir, { projectTrusted });
    const loader = new DefaultResourceLoader({
      cwd: project,
      agentDir,
      settingsManager,
      noExtensions: true,
      noThemes: true,
      noPromptTemplates: true,
      additionalSkillPaths: managed.skillPaths,
      skillsOverride: managed.skillsOverride,
      agentsFilesOverride: managed.agentsFilesOverride,
    });
    await loader.reload();
    return loader;
  }
  return { root, core, user, project, file, guidance, load };
}

test('native loader keeps rules standing and skill bodies progressive across a different agent HOME', async () => {
  const f = fixture();
  f.file('user/rules/preferences.md', 'User writing preference.');
  f.file(
    'user/skills/manual/SKILL.md',
    '---\nname: manual\ndescription: Explicit method\ndisable-model-invocation: true\n---\nOnly when requested.',
  );
  f.file('project/AGENTS.md', 'Project standing guidance.');
  const managed = f.guidance();
  const loader = await f.load(managed);
  expect(
    loader
      .getAgentsFiles()
      .agentsFiles.map((item) => item.content)
      .join('\n'),
  ).toContain('Standing Core requirement.');
  expect(
    loader
      .getAgentsFiles()
      .agentsFiles.map((item) => item.content)
      .join('\n'),
  ).toContain('User writing preference.');
  expect(
    loader
      .getAgentsFiles()
      .agentsFiles.map((item) => item.content)
      .join('\n'),
  ).toContain('Project standing guidance.');
  const skills = loader.getSkills().skills;
  const prompt = formatSkillsForPrompt(skills);
  expect(prompt).toContain('Shared method');
  expect(prompt).not.toContain('Secret body');
  expect(prompt).not.toContain('Explicit method');
  expect(skills.find((item) => item.name === 'manual')?.disableModelInvocation).toBe(true);
  expect(
    managed.inspection.resources.some(
      (item) => item.scope === 'user' && item.kind === 'skill' && item.loaded,
    ),
  ).toBe(true);
});

test('same physical skill is deduplicated but distinct conflicting names stop loading', async () => {
  const f = fixture();
  mkdirSync(path.join(f.user, 'skills'), { recursive: true });
  symlinkSync(path.join(f.core, 'skills/ltcook-method'), path.join(f.user, 'skills/ltcook-method'));
  expect(
    (await f.load(f.guidance())).getSkills().skills.filter((item) => item.name === 'ltcook-method'),
  ).toHaveLength(1);
  f.file(
    'user/skills/conflict/SKILL.md',
    '---\nname: ltcook-method\ndescription: Conflicting method\n---\nConflict.',
  );
  await expect(f.load(f.guidance())).rejects.toThrow('Conflicting skill name');
});

test('missing required guidance stops activation', () => {
  const f = fixture();
  rmSync(path.join(f.core, 'rules/baseline.md'));
  expect(f.guidance).toThrow('Required guidance is missing');
});
