import path from 'node:path';
import type { PaseoAgent } from '@getpaseo/client';

export function skillRoots(agent: Pick<PaseoAgent, 'cwd'>): string[] {
  const { LTCOOK_GUIDANCE_DIR, LTCOOK_SHARED_SKILLS_DIR, LTCOOK_JS_ROOT } = process.env;
  return [
    agent.cwd,
    LTCOOK_GUIDANCE_DIR && path.join(LTCOOK_GUIDANCE_DIR, 'skills'),
    LTCOOK_SHARED_SKILLS_DIR,
    LTCOOK_JS_ROOT && path.join(LTCOOK_JS_ROOT, 'runtime', 'resources'),
    LTCOOK_JS_ROOT && path.join(LTCOOK_JS_ROOT, 'teams'),
  ].filter((root): root is string => typeof root === 'string' && path.isAbsolute(root));
}

export function contains(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    !!relative &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function isSkillDocumentCandidate(agent: Pick<PaseoAgent, 'cwd'>, file: string): boolean {
  return (
    path.basename(file) === 'SKILL.md' && skillRoots(agent).some((root) => contains(root, file))
  );
}
