import { createPiRpcRuntime } from '../../../runtime/src/integrations/pi-rpc.js';
import { REPO_SEARCH_TOOL_NAME } from '../../../runtime/src/tools/repo-search.js';

const runtime = await createPiRpcRuntime(['--offline', '--no-session']);
const cancellation = new AbortController();
const cancel = () => cancellation.abort(new Error('Standalone search cancelled by fixture.'));
process.stdin.once('data', cancel);
try {
  const tool = runtime.session.getToolDefinition(REPO_SEARCH_TOOL_NAME);
  const query = process.argv[2];
  if (!tool || !query) throw new Error('Standalone Pi repository search is unavailable.');
  const deadline = Date.now() + 90_000;
  let completed = false;
  while (Date.now() < deadline) {
    cancellation.signal.throwIfAborted();
    const result = await tool.execute(
      'standalone-search',
      { query, mode: 'semantic', limit: 5 },
      cancellation.signal,
      undefined,
      {} as never,
    );
    const details = result.details as { provider?: string; status?: string } | undefined;
    if (details?.provider === 'colgrep' && details.status === 'ready') {
      console.log(JSON.stringify(details));
      completed = true;
      break;
    }
    await Bun.sleep(100);
  }
  if (!completed) throw new Error('The standalone ColGREP background build timed out.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  process.stdin.removeListener('data', cancel);
  process.stdin.pause();
  await runtime.dispose();
}
