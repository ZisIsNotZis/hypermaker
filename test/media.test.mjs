import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { browserPath, launchBrowser } from "./browser.mjs";

// Image generation is not faked here: test/fake-remotion-codex.mjs bundles and
// renders with Remotion for real, so a passing run proves the harness, the prompt
// assembly and the canvas preview can carry a genuine artifact, not a text file
// that happens to end in .png.
const root = process.cwd(), port = 8961, base = mkdtempSync(join(tmpdir(), "hypermaker-media-")), bin = join(base, "remotion-codex");
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(root, "test/fake-remotion-codex.mjs"))} "$@"\n`); chmodSync(bin, 0o755);
let app, browser;

// Remotion needs a real browser. Point at one with HYPERMAKER_CHROME/CHROME_BIN,
// otherwise use Playwright's bundled build; when neither exists, say so instead
// of reporting a green test that rendered nothing.
const chrome = browserPath();
const canRender = existsSync(chrome);

before(async () => {
  if (!canRender) return;
  app = spawn("node", ["server/index.mjs"], { cwd: root, env: { ...process.env, PORT: String(port), CODEX_BIN: bin, HYPERMAKER_WORKDIR: join(base, "workspace"), HYPERMAKER_RESET_WORKSPACE: "1" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/registry`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); app?.kill(); });

const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const workspace = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());

test("an image node renders a real PNG through Remotion and previews it", async t => {
  if (!canRender) return t.skip(`no browser available for Remotion (set HYPERMAKER_CHROME); looked at ${chrome}`);
  const dir = mkdtempSync(join(base, "ws-"));
  await post("/api/workspace", { workdir: dir });
  const created = await post("/api/node", { x: 80, y: 90, type: "image", method: "remotion", quality: "demo", prompt: "a purple square" });
  const id = Object.keys(created.nodes).at(-1);
  assert.equal(created.nodes[id].type, "image", "the node starts as an image node");

  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack || String(error)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector(`.card[data-id="${id}"]`);
  await page.locator(`.card[data-id="${id}"] [data-generate]`).click();

  // Remotion bundling plus a still render takes seconds, not milliseconds.
  let node;
  for (let i = 0; i < 120; i++) {
    node = (await workspace()).nodes[id];
    if (node?.artifact || node?.error) break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(node?.artifact || node?.error, `generation finished, got ${JSON.stringify(node)}`);
  assert.equal(node.error, null, `generation reported no error, got ${node.error}`);
  assert.equal(node.artifact, "remotion-square.png");

  // The artifact on disk is a real PNG, not a text file with a PNG name.
  const file = join(dir, String(id), node.artifact);
  const bytes = readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "artifact has the PNG signature");
  assert.ok(bytes.length > 1000, `artifact is a real image, got ${bytes.length} bytes`);

  // And the canvas shows it: a loaded <img> with the rendered dimensions.
  await page.waitForFunction(() => {
    const img = document.querySelector(".preview img");
    return img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 10000 });
  const shown = await page.evaluate(() => { const img = document.querySelector(".preview img"); return { width: img.naturalWidth, height: img.naturalHeight, src: img.getAttribute("src") }; });
  assert.deepEqual({ width: shown.width, height: shown.height }, { width: 320, height: 180 }, "the preview shows the rendered 320x180 frame");
  assert.match(shown.src, /\/api\/file/, "the preview loads through the file endpoint");
  assert.equal(await page.locator(`.card[data-id="${id}"] .title`).textContent(), "remotion-square.png");
  assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  await page.close();
});
