import { constants } from 'node:fs';
import { open, realpath, stat as statFile } from 'node:fs/promises';
import path from 'node:path';
import type { PaseoAgent, PaseoAgentHandle } from '@getpaseo/client';
import type { ActivityAnchor } from '../shared/activity';
import {
  listedSkillCommands,
  observeSkillUse,
  parseSkillMarkdown,
  registeredSkillFiles,
  timelineAnchor,
  timelineTime,
  type RegisteredSkill,
} from './activity-uses';

import { contains, isSkillDocumentCandidate, skillRoots } from './skill-paths';

type DocumentRequest = {
  skillId: string;
  occurrence?: ActivityAnchor;
  view: 'preview' | 'full';
};

const maxDocumentBytes = 512 * 1024;
const previewCharacters = 1400;

export async function readSkillDocument(
  handle: PaseoAgentHandle,
  { skillId, occurrence, view }: DocumentRequest,
  registeredSkills: (agent: PaseoAgent) => Promise<RegisteredSkill[] | undefined>,
): Promise<{ name: string; markdown: string }> {
  const unavailable = () => new Error('This skill document is unavailable.');
  const agent = (await handle.refresh())?.agent;
  if (!agent || agent.archivedAt) throw unavailable();
  const registered = (await registeredSkills(agent).catch(() => undefined)) ?? [];
  const catalog = registeredSkillFiles(registered);
  let file: string | undefined;

  if (occurrence) {
    const page = await handle.timeline.refetch({
      direction: 'after',
      cursor: { epoch: occurrence.epoch, seq: Math.max(0, occurrence.position - 1) },
      projection: 'canonical',
      limit: 8,
    });
    if (
      !page.agent ||
      page.agent.archivedAt ||
      page.epoch !== occurrence.epoch ||
      page.error ||
      page.reset ||
      page.staleCursor ||
      page.gap
    ) {
      throw unavailable();
    }
    const entry = page.entries.find((candidate) => {
      if (
        candidate.seqEnd !== occurrence.position ||
        (occurrence.turnId && candidate.turnId !== occurrence.turnId)
      ) {
        return false;
      }
      const target = timelineAnchor(
        candidate.item,
        page.epoch,
        candidate.seqEnd,
        timelineTime(candidate.timestamp),
        candidate.turnId,
      );
      return target?.kind === occurrence.kind && target.id === occurrence.id;
    });
    if (!entry) throw unavailable();
    const commands = (await listedSkillCommands(handle)) ?? new Map();
    const use = observeSkillUse(agent, { commands, files: catalog }, entry.item, occurrence.at);
    if (use?.name === skillId) file = use.filePath;
  } else {
    const matching = registered.filter(({ name }) => name === skillId);
    if (matching.length === 1) file = matching[0]?.path;
  }

  if (!file || !isSkillDocumentCandidate(agent, file)) throw unavailable();
  try {
    const resolved = await realpath(file);
    const roots = await Promise.all(
      skillRoots(agent).map((root) => realpath(root).catch(() => '')),
    );
    if (
      path.basename(resolved) !== 'SKILL.md' ||
      !roots.some((root) => root && contains(root, resolved))
    ) {
      throw unavailable();
    }
    const document = await open(
      resolved,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    let markdown: string;
    try {
      const stat = await document.stat();
      if (!stat.isFile() || stat.size > maxDocumentBytes) throw unavailable();
      // > Check the opened file before reading in case a workspace path changed during open.
      if (process.platform === 'linux') {
        if ((await realpath(`/proc/self/fd/${document.fd}`)) !== resolved) throw unavailable();
      } else {
        const currentPath = await realpath(file);
        const current = await statFile(currentPath);
        if (currentPath !== resolved || current.dev !== stat.dev || current.ino !== stat.ino) {
          throw unavailable();
        }
      }
      const buffer = Buffer.alloc(Math.min(stat.size + 1, maxDocumentBytes + 1));
      let readSize = 0;
      while (readSize < buffer.length) {
        const { bytesRead } = await document.read(buffer, readSize, buffer.length - readSize);
        if (bytesRead === 0) break;
        readSize += bytesRead;
      }
      if (readSize > stat.size) throw unavailable();
      markdown = buffer.subarray(0, readSize).toString('utf8');
    } finally {
      await document.close();
    }
    const parsed = parseSkillMarkdown(markdown);
    if (!parsed || parsed.name !== skillId) throw unavailable();
    return {
      name: parsed.name,
      markdown:
        view === 'preview' && parsed.body.length > previewCharacters
          ? `${parsed.body.slice(0, previewCharacters).trimEnd()}…`
          : parsed.body,
    };
  } catch {
    throw unavailable();
  }
}
