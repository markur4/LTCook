import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  listeners = new Map<string, () => void>();
  children: Element[] = [];
  style: Record<string, string> = {};
  textContent = '';
  removed = false;

  setAttribute() {}
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, listener);
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  remove() {
    this.removed = true;
  }
}

test('an open Paseo tab offers a reload when the served build changes', async () => {
  const script = await readFile(new URL('../../../paseo-patches/build-check.js', import.meta.url));
  const loaded = 'a'.repeat(64);
  let current = loaded;
  let reloads = 0;
  const body = new Element();
  const focus = new Map<string, () => Promise<void>>();
  runInNewContext(script.toString(), {
    AbortSignal,
    document: {
      body,
      visibilityState: 'visible',
      querySelector: () => ({ content: loaded }),
      createElement: () => new Element(),
      addEventListener: () => {},
    },
    window: {
      addEventListener: (name: string, callback: () => Promise<void>) => focus.set(name, callback),
      setInterval: () => {},
      location: { reload: () => reloads++ },
    },
    fetch: async () => ({ ok: true, json: async () => ({ build: current }) }),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(body.children).toHaveLength(0);

  current = 'b'.repeat(64);
  await focus.get('focus')?.();
  const notice = body.children[0]!;
  const [message, reload] = notice.children;
  expect(message?.textContent).toContain(loaded.slice(0, 12));
  expect(message?.textContent).toContain(current.slice(0, 12));
  expect(reloads).toBe(0);
  expect(reload?.textContent).toBe('Reload Paseo');
  reload?.listeners.get('click')?.();
  expect(reloads).toBe(1);

  current = loaded;
  await focus.get('focus')?.();
  expect(notice.removed).toBe(true);
});
