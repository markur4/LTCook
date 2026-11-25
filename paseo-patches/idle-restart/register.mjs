import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { patches } from './patch.mjs';

// The published ESM is readable and shipped with a version-pinned LTCook install.
// Resolve it from this deployment so the hook only touches that copy.
const require = createRequire(import.meta.url);
const serverEntry = pathToFileURL(require.resolve('@getpaseo/server'));
const serverRoot = new URL('../../../', serverEntry);
const manifest = JSON.parse(readFileSync(new URL('package.json', serverRoot), 'utf8'));
if (manifest.name !== '@getpaseo/server' || manifest.version !== '0.16.0-beta.2') {
  throw new Error('LTCook idle restart requires @getpaseo/server 0.16.0-beta.2');
}

const sources = new Map();
const gateUrl = new URL('./gate.mjs', import.meta.url).href;
for (const [file, { sha256, apply }] of Object.entries(patches)) {
  const url = new URL(file, serverRoot);
  const source = readFileSync(url, 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== sha256) {
    throw new Error(`Unexpected Paseo source for LTCook idle restart: ${file}`);
  }
  sources.set(url.href, apply(source, { gateUrl, registerUrl: import.meta.url }));
}

registerHooks({
  load(url, context, nextLoad) {
    const source = sources.get(url);
    return source === undefined
      ? nextLoad(url, context)
      : { format: 'module', source, shortCircuit: true };
  },
});
