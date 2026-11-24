import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type MemoryAttachment = { id: string; name: string; text: string };

const attachmentPattern =
  /\[LTCook pasted text ([0-9a-f-]{36}) ([0-9a-f]{64})\]\r?\n([\s\S]*?)\r?\n\[End LTCook pasted text \1\]/g;
const citationPattern = /\[LTCook attachment: ([0-9a-f-]{36}) ([0-9a-f]{64})\]/g;
const draftLifetimeMs = 24 * 60 * 60 * 1000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function missing(error: NodeJS.ErrnoException): undefined {
  if (error.code !== 'ENOENT') throw error;
}

export class PastedDocuments {
  constructor(
    private readonly directory: string,
    private readonly secret: string,
  ) {}

  private signature(id: string, text: string): Buffer {
    return createHmac('sha256', this.secret)
      .update(JSON.stringify([id, text]))
      .digest();
  }

  private draftPath(id: string) {
    return path.join(this.directory, 'drafts', id + '.txt');
  }

  async draft(text: string) {
    const id = randomUUID();
    const directory = path.join(this.directory, 'drafts');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const expireBefore = Date.now() - draftLifetimeMs;
    await Promise.all(
      (await readdir(directory)).map(async (file) => {
        const candidate = path.join(directory, file);
        const details = await stat(candidate).catch(() => undefined);
        if (details?.isFile() && details.mtimeMs < expireBefore)
          await rm(candidate, { force: true });
      }),
    );
    await writeFile(this.draftPath(id), text, { mode: 0o600, flag: 'wx' });
    const signature = this.signature(id, text).toString('hex');
    return {
      id,
      identifier: '[LTCook attachment: ' + id + ' ' + signature + ']',
      title: 'Pasted text',
      subtitle: String(text.length) + ' characters',
      url: 'ltcook://pasted-text/' + id,
      resourceType: 'ltcook-pasted-text',
      text:
        '[LTCook pasted text ' +
        id +
        ' ' +
        signature +
        ']\n' +
        text +
        '\n[End LTCook pasted text ' +
        id +
        ']',
    };
  }

  async discard(id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid pasted text draft.');
    await rm(this.draftPath(id), { force: true });
  }

  private epochDirectory(agentId: string, epoch: string): string {
    return path.join(this.directory, digest(agentId), digest(epoch));
  }

  async project(agentId: string, epoch: string, seq: number, source: string) {
    const attachments = new Map<string, MemoryAttachment>();
    const messageDirectory = path.join(this.epochDirectory(agentId, epoch), String(seq));
    const accept = (id: string, signature: string, text: string) => {
      if (!timingSafeEqual(this.signature(id, text), Buffer.from(signature, 'hex'))) return false;
      attachments.set(id, { id, name: 'Pasted text', text });
      return true;
    };
    let direct = source;
    for (const [block, id, signature, text] of source.matchAll(attachmentPattern)) {
      if (!id || !signature || text === undefined || !accept(id, signature, text)) continue;
      const destination = path.join(messageDirectory, id + '.txt');
      if ((await stat(destination).catch(() => undefined)) === undefined) {
        await mkdir(messageDirectory, { recursive: true, mode: 0o700 });
        const temporary = path.join(messageDirectory, randomUUID() + '.tmp');
        try {
          await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
          await rename(temporary, destination);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      await this.discard(id);
      direct = direct.replace(block, '');
    }
    for (const [citation, id, signature] of direct.matchAll(citationPattern)) {
      if (!id || !signature) continue;
      const destination = path.join(messageDirectory, id + '.txt');
      const existing = await readFile(destination, 'utf8').catch(missing);
      if (existing !== undefined && accept(id, signature, existing)) {
        direct = direct.replace(citation, '');
        continue;
      }
      const draft = await readFile(this.draftPath(id), 'utf8').catch(missing);
      if (draft !== undefined && accept(id, signature, draft)) {
        await mkdir(messageDirectory, { recursive: true, mode: 0o700 });
        await rename(this.draftPath(id), destination).catch(missing);
        direct = direct.replace(citation, '');
      }
    }
    return {
      text: attachments.size ? direct.trim() : source,
      attachments: [...attachments.values()],
    };
  }

  async invalidate(agentId: string, epoch: string, from?: number) {
    const directory = this.epochDirectory(agentId, epoch);
    if (from === undefined) {
      await rm(directory, { recursive: true, force: true });
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isDirectory() && /^\d+$/.test(entry.name) && Number(entry.name) >= from,
        )
        .map(({ name }) => rm(path.join(directory, name), { recursive: true, force: true })),
    );
  }
}
