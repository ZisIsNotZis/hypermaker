// A supervisor watched a 65 MiB clip get generated in a real browser: the press showed
// "my-clip.mp4 … larger than 64 MiB … cannot be undone", and after reloading the page
// mid-run the server still had that sentence and the canvas did not. A long render is
// precisely when someone closes the tab and comes back, so the notice has to be part of
// the card, not a message about one request.
//
// The test drives the real canvas: it puts a card in a workspace whose card directory
// holds a file over the copy limit, presses Generate in the page, reloads, and reads the
// card. It asserts the element's text, not the presence of a class, because a card that
// renders an empty box is exactly the failure being guarded against.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserPath, launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

const missingBrowser = existsSync(browserPath()) ? null
  : `no Chromium at ${browserPath()}: run \`npx playwright install chromium\` or set HYPERMAKER_CHROME`;
const canvasTest = (name, fn) => test(name, missingBrowser ? { skip: missingBrowser } : {}, fn);

const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-protection-"));
const bin = join(base, "agent");
// Slow enough that the run is still going while the page reloads.
writeFileSync(join(base, "agent.mjs"), `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR, out = process.argv[process.argv.indexOf("--output-last-message") + 1];
const asked = readFileSync(join(dir, "prompt.txt"), "utf8");
writeFileSync(join(dir, "note.txt"), "the run's own note");
await new Promise(r => setTimeout(r, 4000));
writeFileSync(out, JSON.stringify({ prompt: asked, script: null, artifact: "note.txt", type: "text", method: "llm", error: null }));
`);
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(base, "agent.mjs"))} "$@"\n`);
chmodSync(bin, 0o755);

let app, browser, port, workdir;
before(async () => {
  if (missingBrowser) return;
  port = await freePort();
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: join(base, "ws"), HYPERMAKER_RESET_WORKSPACE: "1" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); stopServer(app); stopAll(); });

const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());

canvasTest("a large file's protection notice is on the card before the run and still there after a reload", async () => {
  // A workspace card with material next to it that is over the copy tier.
  workdir = join(base, `ws-${Date.now()}`);
  mkdirSync(join(workdir, "1"), { recursive: true });
  const clip = join(workdir, "1", "my-clip.mp4");
  writeFileSync(clip, "ftyp");
  appendFileSync(clip, Buffer.alloc(65 * 1024 * 1024));
  writeFileSync(join(workdir, "workspace.yml"), [
    "1:", "  x: 60", "  y: 60", "  inputs: []", "  type: text", "  method: llm",
    '  prompt: "a take with a clip"', "  quality: standard", "  status: draft", ""
  ].join("\n"));
  await post("/api/workspace", { workdir });

  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack || String(error)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('.card[data-id="1"]');

  // Press Generate the way a person does.
  await page.locator('.card[data-id="1"] [data-generate]').click();
  const notice = page.locator('.card[data-id="1"] .protection');
  await notice.waitFor({ timeout: 15000 });
  const first = await notice.textContent();
  assert.match(first, /my-clip\.mp4/, `the notice names the file, got ${first}`);

  // Reload mid-run: this is the moment the supervisor lost it. Stop must still be there
  // too, or the reload silently killed the ability to stop a long render.
  await page.waitForFunction(() => document.querySelector('.card[data-id="1"] [data-cancel]')?.hidden === false);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector('.card[data-id="1"] .protection', { timeout: 15000 });
  const after = await page.locator('.card[data-id="1"] .protection').textContent();
  assert.equal(after, first, "the card says the same thing after the reload");
  assert.equal(await page.locator('.card[data-id="1"] [data-cancel]').isHidden(), false, "and Stop is still offered");
  // Card raised errors would invalidate the reading above.
  assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  await page.close();
});

canvasTest("an ordinary card shows no protection notice at all", async () => {
  const plain = join(base, `ws-plain-${Date.now()}`);
  mkdirSync(join(plain, "1"), { recursive: true });
  writeFileSync(join(plain, "workspace.yml"), [
    "1:", "  x: 60", "  y: 60", "  inputs: []", "  type: text", "  method: llm",
    '  prompt: "an ordinary take"', "  quality: standard", "  status: draft", ""
  ].join("\n"));
  await post("/api/workspace", { workdir: plain });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('.card[data-id="1"]');
  await page.locator('.card[data-id="1"] [data-generate]').click();
  await page.waitForFunction(() => document.querySelector('.card[data-id="1"] .meta')?.textContent.includes("running"));
  assert.equal(await page.locator('.card[data-id="1"] .protection').count(), 0, "a card with nothing large is not given a warning");
  await page.close();
});
