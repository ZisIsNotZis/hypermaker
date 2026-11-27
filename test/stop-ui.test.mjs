// The generation lifecycle as the canvas shows it: a running card offers Stop,
// pressing it ends the run, the card says what happened, and the failure text is
// on the card rather than only in a terminal nobody is watching.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { browserPath, launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

const missingBrowser = existsSync(browserPath()) ? null
  : `no Chromium at ${browserPath()}: run \`npx playwright install chromium\` or set HYPERMAKER_CHROME`;
const canvasTest = (name, fn) => test(name, missingBrowser ? { skip: missingBrowser } : {}, fn);

const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-stop-")), bin = join(base, "agent");
let port;
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(root, "test/fake-agent.mjs"))} "$@"\n`); chmodSync(bin, 0o755);
let app, browser;

before(async () => {
  if (missingBrowser) return;
  port = await freePort();
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: join(base, "ws"), HYPERMAKER_RESET_WORKSPACE: "1", AGENT_MODE: "tree", AGENT_DELAY: "6000" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); stopServer(app); stopAll(); });

const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const workspace = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());

canvasTest("a running card offers Stop, and pressing it ends the run visibly", async () => {
  const dir = mkdtempSync(join(base, "ws-"));
  await post("/api/workspace", { workdir: dir });
  const id = Object.keys((await post("/api/node", { x: 60, y: 60, type: "text", method: "llm", prompt: "slow one" })).nodes).at(-1);
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  const errors = []; page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector(`.card[data-id="${id}"]`);

  const stop = page.locator(`.card[data-id="${id}"] [data-cancel]`);
  assert.equal(await stop.isHidden(), true, "Stop is not offered while the card is idle");
  await page.locator(`.card[data-id="${id}"] [data-generate]`).click();
  await page.waitForFunction(id => document.querySelector(`.card[data-id="${id}"] .meta`)?.textContent.includes("running"), id, { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector("[data-cancel]:not([hidden])"), null, { timeout: 5000 });
  assert.equal(await stop.isVisible(), true, "Stop appears while the agent runs");
  assert.equal(await page.locator(`.card[data-id="${id}"] [data-generate]`).isDisabled(), true, "Generate is disabled rather than starting a second run");
  assert.equal(await page.locator(`.card[data-id="${id}"] [data-generate]`).textContent(), "Generating…");
  // Wait for the agent to be genuinely alive before stopping it.
  const marker = join(dir, String(id), "grandchild.txt");
  for (let i = 0; i < 80 && !existsSync(marker); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(existsSync(marker), true, "the agent was really running when Stop was pressed");

  await stop.click();
  await page.waitForFunction(id => document.querySelector(`.card[data-id="${id}"] .meta`)?.textContent.includes("cancelled"), id, { timeout: 6000 });
  assert.match(await page.locator(`.card[data-id="${id}"] .error`).textContent(), /stopped/i, "the card says why it stopped");
  assert.equal(await stop.isHidden(), true, "Stop goes away once the run is over");
  assert.equal(await page.locator(`.card[data-id="${id}"] [data-generate]`).isEnabled(), true, "the card can be generated again");
  assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  await page.close();
});

canvasTest("a failed run shows its reason on the card, and survives reopening", async () => {
  // A separate server whose agent always exits non-zero: the same thing a person
  // sees when a real run dies, without spending a real model call to find out.
  const failPort = await freePort(), failBase = mkdtempSync(join(base, "fail-"));
  const failing = startServer({ cwd: root, port: failPort, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: join(failBase, "ws"), HYPERMAKER_RESET_WORKSPACE: "1", AGENT_MODE: "fail" } });
  failing.stderr.on("data", chunk => process.stderr.write(chunk));
  try {
    await waitReady(failPort);
    const make = (path, body) => fetch(`http://127.0.0.1:${failPort}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
    const id = Object.keys((await make("/api/node", { x: 60, y: 60, type: "text", method: "llm", prompt: "will fail" })).nodes).at(-1);
    const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
    const errors = []; page.on("pageerror", e => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${failPort}/`);
    await page.waitForSelector(`.card[data-id="${id}"]`);
    await page.locator(`.card[data-id="${id}"] [data-generate]`).click();
    await page.waitForFunction(id => document.querySelector(`.card[data-id="${id}"] .meta`)?.textContent.includes("error"), id, { timeout: 8000 });
    assert.match(await page.locator(`.card[data-id="${id}"] .error`).textContent(), /exited with code 3/, "the card says the agent failed and why");
    assert.match(await page.locator(`.card[data-id="${id}"] .preview`).textContent(), /no artifact yet/, "no artifact is pretended");
    await page.reload(); await page.waitForSelector(`.card[data-id="${id}"]`); await page.waitForTimeout(300);
    assert.match(await page.locator(`.card[data-id="${id}"] .error`).textContent(), /exited with code 3/, "the reason is still there after reopening");
    assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
    await page.close();
  } finally { stopServer(failing); }
});
