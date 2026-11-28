// Serve a completed, synthetic story-captions-only --local-files --restart run
// for an independent recipient. Give them only the printed URL and a content brief.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { freePort, startServer, stopServer, waitReady } from './server.mjs';

const receiptPath = process.argv[2];
assert.ok(receiptPath, 'pass the synthetic run receipt.json');
const { workspace, modelCalls, reopened } = JSON.parse(readFileSync(receiptPath, 'utf8'));
assert.equal(modelCalls, 0);
assert.ok(reopened?.continued && existsSync(join(workspace, 'workspace.yml')), 'run the complete three-cut synthetic story first');
const port = await freePort();
const app = startServer({ port, env: {
  CODEX_BIN: join(dirname(workspace), 'no-codex.mjs'),
  HYPERMAKER_ESPEAK: join(dirname(workspace), 'absent-espeak-ng'),
  HYPERMAKER_WORKDIR: workspace,
  HYPERMAKER_RESET_WORKSPACE: '0',
  NODE_ENV: 'development',
} });
try {
  await waitReady(port);
  console.log(`http://127.0.0.1:${port}/`);
  await once(app, 'exit');
} finally {
  stopServer(app);
}
