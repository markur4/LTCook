import path from 'node:path';
import type { PaseoAgent, PaseoAgentHandle } from '@getpaseo/client';
import type { ActivityAnchor, SkillLoad } from '../shared/activity';
import { isSkillDocumentCandidate } from './skill-paths';

export type Timeline = Awaited<ReturnType<PaseoAgentHandle['timeline']['refetch']>>;
export type TimelineItem = Timeline['entries'][number]['item'];
export type RegisteredSkill = { name: string; path: string };
export type SkillCatalog = {
  commands: ReadonlyMap<string, string>;
  files: ReadonlyMap<string, string>;
  canReadDocument?: (file: string) => boolean;
};
export type SkillUse = {
  name: string;
  description?: string;
  documentAvailable: boolean;
  filePath?: string;
  at: number;
  anchor?: ActivityAnchor;
};

export const activityHistoryLimit = 32;
export const timelinePageSize = 160;
export const activeTurnPageLimit = 8;

export function timelineTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function listedSkillCommands(
  handle: PaseoAgentHandle,
): Promise<Map<string, string> | undefined> {
  const result = await handle.commands().catch(() => undefined);
  if (!result || result.error) return undefined;
  return new Map(
    result.commands
      .filter(({ kind }) => kind === 'skill')
      .map(({ name, description }) => [name.replace(/^\/?skill:/, ''), description]),
  );
}

export function registeredSkillFiles(skills: RegisteredSkill[]): Map<string, string> {
  return new Map(skills.map(({ name, path: file }) => [path.normalize(file), name]));
}

export function parseSkillMarkdown(markdown: string): { name: string; body: string } | undefined {
  const header = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  const name =
    header && /^name:[ \t]*(['"]?)([\w.-]+)\1[ \t]*(?:#.*)?$/m.exec(header[1] ?? '')?.[2];
  if (header && name) return { name, body: markdown.slice(header[0].length).trim() };
}

function codexSkillRead(
  command: string,
  output?: string,
): { file: string; name: string } | undefined {
  // > Require a direct read and returned front matter from Codex shell results.
  const reader =
    /^(?:cat|head(?:[ \t]+(?:-n[ \t]*|-)\d+)?|sed[ \t]+-n[ \t]+(['"]?)1,\d+p\1)[ \t]+(?:--[ \t]+)?(.+)$/;
  const operand = reader.exec(command.trim())?.[2];
  if (!operand || !output) return undefined;
  const token = /^(?:"([^"$`\\]+)"|'([^']+)'|([^\s<>&|;$*?`\\"'~#{}\[\]]+))$/.exec(operand);
  const file = token?.[1] ?? token?.[2] ?? token?.[3];
  if (!file || path.basename(file) !== 'SKILL.md') return undefined;
  const name = parseSkillMarkdown(output.slice(0, 4096))?.name;
  return name ? { file, name } : undefined;
}

function skillPath(cwd: string | null | undefined, file: string): string | undefined {
  // > A parent traversal through a symlink can name a different file after normalization.
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(file)) return undefined;
  if (path.isAbsolute(file)) return path.normalize(file);
  if (cwd && path.isAbsolute(cwd)) return path.resolve(cwd, file);
}

export function timelineAnchor(
  item: TimelineItem,
  epoch: string | undefined,
  position: number,
  at: number,
  turnId?: string,
): ActivityAnchor | undefined {
  if (!epoch || !Number.isSafeInteger(position) || position < 0) return undefined;
  if (item.type !== 'user_message' && item.type !== 'tool_call') return undefined;
  const id = item.type === 'tool_call' ? item.callId : item.messageId || item.clientMessageId;
  if (!id) return undefined;
  return {
    epoch,
    position,
    kind: item.type === 'tool_call' ? 'tool' : 'message',
    id,
    at,
    ...(turnId ? { turnId } : {}),
  };
}

export function observeSkillUse(
  agent: { provider: PaseoAgent['provider']; cwd?: string | null },
  catalog: SkillCatalog,
  item: TimelineItem,
  at: number,
  anchor?: ActivityAnchor,
): SkillUse | undefined {
  let name: string | undefined;
  let file: string | undefined;
  if (item.type === 'user_message' && (agent.provider === 'pi' || agent.provider === 'ltcook')) {
    const wrapper = /^<skill name="([^"]+)" location="([^"]+)">\n/.exec(item.text);
    name = wrapper?.[1];
    if (wrapper?.[2]) file = skillPath(undefined, wrapper[2]);
  } else if (item.type === 'tool_call' && item.status === 'completed') {
    if (item.detail.type === 'read') {
      file = skillPath(agent.cwd, item.detail.filePath);
      name = file ? catalog.files.get(file) : undefined;
    } else if (
      agent.provider === 'codex' &&
      item.detail.type === 'shell' &&
      (item.detail.exitCode == null || item.detail.exitCode === 0)
    ) {
      const match = codexSkillRead(item.detail.command, item.detail.output);
      name = match?.name;
      if (match) file = skillPath(item.detail.cwd, match.file);
    }
  }
  if (!name) return undefined;
  const registeredFile = !!file && catalog.files.get(file) === name;
  const knownCommand = catalog.commands.has(name);
  if (!knownCommand && (agent.provider === 'codex' || !registeredFile)) return undefined;
  const documentAvailable = file ? (catalog.canReadDocument?.(file) ?? registeredFile) : false;
  const description = catalog.commands.get(name);
  return {
    name,
    ...(description ? { description } : {}),
    documentAvailable,
    ...(file ? { filePath: file } : {}),
    at,
    anchor,
  };
}

/** Group the bounded canonical occurrences in timeline order. */
export function recentSkillLoads(uses: ReadonlyMap<number, SkillUse>): SkillLoad[] {
  const skills = new Map<string, SkillLoad>();
  const recent = [...uses].sort(([left], [right]) => right - left).slice(0, activityHistoryLimit);
  for (const [, use] of recent.reverse()) {
    const previous = skills.get(use.name);
    const occurrences = previous?.occurrences ?? [];
    if (use.anchor) occurrences.push(use.anchor);
    skills.set(use.name, {
      id: use.name,
      name: use.name,
      loadedAt: use.at,
      ...(use.description ? { description: use.description } : {}),
      documentAvailable: use.documentAvailable,
      occurrences,
    });
  }
  return [...skills.values()];
}

/** Read observed uses from a bounded history window for a single native turn. */
export async function readTurnSkills(
  agent: PaseoAgent,
  handle: PaseoAgentHandle,
  input: { epoch: string; turnId: string; position?: number; tail?: Timeline },
  signal: AbortSignal,
  registeredSkills: (
    agent: PaseoAgent,
    signal: AbortSignal,
  ) => Promise<RegisteredSkill[] | undefined>,
): Promise<SkillLoad[]> {
  if (signal.aborted || agent.archivedAt || !['pi', 'ltcook', 'codex'].includes(agent.provider)) {
    return [];
  }
  const { epoch, turnId, position } = input;
  if (!epoch || !turnId) return [];
  if (position !== undefined && (!Number.isSafeInteger(position + 1) || position < 0)) {
    return [];
  }
  const [commands, files] = await Promise.all([
    agent.providerUnavailable ? undefined : listedSkillCommands(handle),
    registeredSkills(agent, signal).catch(() => undefined),
  ]);
  if ((!commands && !files) || signal.aborted) return [];
  const catalog = {
    commands: commands ?? new Map<string, string>(),
    files: registeredSkillFiles(files ?? []),
    canReadDocument: (file: string) => isSkillDocumentCandidate(agent, file),
  };
  const uses = new Map<number, SkillUse>();
  const seenTools = new Set<string>();
  let cursor = position === undefined ? undefined : { epoch, seq: position + 1 };
  let foundTurn = false;
  for (let pageIndex = 0; pageIndex < activeTurnPageLimit && !signal.aborted; pageIndex++) {
    const page =
      (pageIndex === 0 && !cursor ? input.tail : undefined) ??
      (await handle.timeline
        .refetch({
          direction: cursor ? 'before' : 'tail',
          cursor,
          projection: 'canonical',
          limit: timelinePageSize,
        })
        .catch(() => undefined));
    if (
      !page ||
      signal.aborted ||
      page.agent?.archivedAt ||
      page.error ||
      page.epoch !== epoch ||
      page.reset ||
      page.staleCursor ||
      page.gap
    ) {
      return [];
    }
    if (
      !foundTurn &&
      position !== undefined &&
      !page.entries.some((entry) => entry.seqEnd === position && entry.turnId === turnId)
    ) {
      return [];
    }
    const ordered = [...page.entries].sort((left, right) => right.seqEnd - left.seqEnd);
    for (const entry of ordered) {
      if (entry.turnId !== turnId || (position !== undefined && entry.seqEnd > position)) continue;
      foundTurn = true;
      const at = timelineTime(entry.timestamp);
      const anchor = timelineAnchor(entry.item, epoch, entry.seqEnd, at, entry.turnId);
      const use = observeSkillUse(agent, catalog, entry.item, at, anchor);
      if (!use) continue;
      if (entry.item.type === 'tool_call') {
        if (seenTools.has(entry.item.callId)) continue;
        seenTools.add(entry.item.callId);
      }
      uses.set(entry.seqEnd, use);
      if (uses.size >= activityHistoryLimit) return recentSkillLoads(uses);
    }
    const oldestTurn = ordered.findLast((entry) => entry.turnId)?.turnId;
    if (foundTurn && oldestTurn && oldestTurn !== turnId) break;
    const next = page.startCursor;
    if (!page.hasOlder || !next || (cursor && next.seq >= cursor.seq)) break;
    cursor = next;
  }
  return recentSkillLoads(uses);
}
