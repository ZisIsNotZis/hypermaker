import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { browserPath, launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

// Media generation is not faked here: test/fake-remotion-codex.mjs bundles and
// renders with Remotion for real, so a passing run proves the harness, the prompt
// assembly and the canvas preview can carry a genuine artifact, not a text file
// that happens to end in .png or .mp4.
const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-media-")), bin = join(base, "remotion-codex");
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(root, "test/fake-remotion-codex.mjs"))} "$@"\n`); chmodSync(bin, 0o755);

// Remotion needs a real browser to render, and the canvas needs one to show the
// result. When HYPERMAKER_CHROME/CHROME_BIN is unset Playwright's bundled build
// is used; when neither exists both tests skip with one readable reason instead
// of reporting green while rendering nothing.
const chrome = browserPath();
const skip = existsSync(chrome) ? null
  : `no browser for Remotion or the canvas (set HYPERMAKER_CHROME); looked at ${chrome}`;

const apps = [];
let browser, stillPort, videoPort;
async function startApp(env) {
  const port = await freePort();
  const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: join(base, `ws-${port}`), HYPERMAKER_RESET_WORKSPACE: "1", ...env } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  apps.push(app);
  await waitReady(port);
  return port;
}
// Pin the switch on both sides: the fixture branches on REMOTION_TEST_VIDEO, so a
// shell that already exports it would otherwise turn the image case into a video
// render and fail on the PNG assertion.
before(async () => { if (skip) return; stillPort = await startApp({ REMOTION_TEST_VIDEO: "0" }); videoPort = await startApp({ REMOTION_TEST_VIDEO: "1" }); browser = await launchBrowser(); });
after(async () => { await browser?.close(); for (const app of apps) stopServer(app); stopAll(); });

const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const workspace = port => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());

// Bundling a Remotion project plus rendering takes seconds, not milliseconds.
async function settled(port, id, tries = 240) {
  let node;
  for (let i = 0; i < tries; i++) {
    node = (await workspace(port)).nodes[id];
    if (node?.artifact || node?.error) return node;
    await new Promise(r => setTimeout(r, 250));
  }
  return node;
}

// Creates the node and drives it from the canvas, the way a person does, then
// returns the page and the finished node record.
async function generate(port, spec) {
  const dir = mkdtempSync(join(base, "ws-"));
  await post(port, "/api/workspace", { workdir: dir });
  const created = await post(port, "/api/node", { x: 80, y: 90, quality: "demo", prompt: "a purple square", ...spec });
  const id = Object.keys(created.nodes).at(-1);
  assert.equal(created.nodes[id].type, spec.type, `the node starts as a ${spec.type} node`);

  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack || String(error)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector(`.card[data-id="${id}"]`);
  await page.locator(`.card[data-id="${id}"] [data-generate]`).click();

  const node = await settled(port, id);
  assert.ok(node?.artifact || node?.error, `generation finished, got ${JSON.stringify(node)}`);
  assert.equal(node.error, null, `generation reported no error, got ${node.error}`);
  return { dir, id, node, page, errors };
}

test("an image node renders a real PNG through Remotion and previews it", async t => {
  if (skip) return t.skip(skip);
  const { dir, id, node, page, errors } = await generate(stillPort, { type: "image", method: "remotion" });
  assert.equal(node.artifact, "remotion-square.png");

  // The artifact on disk is a real PNG, not a text file with a PNG name.
  const bytes = readFileSync(join(dir, String(id), node.artifact));
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

test("a video node renders a real MP4 through Remotion and previews it", async t => {
  if (skip) return t.skip(skip);
  const { dir, id, node, page, errors } = await generate(videoPort, { type: "video", method: "remotion" });
  assert.equal(node.artifact, "remotion-square.mp4");

  // A video is not "an mp4 name": the file must be an ISO base media container
  // with real track data, which is what renderMedia + FFmpeg produce and what a
  // text file renamed to .mp4 cannot fake.
  const bytes = readFileSync(join(dir, String(id), node.artifact));
  assert.equal(bytes.subarray(4, 8).toString("latin1"), "ftyp", "artifact starts with an ISO base media ftyp box");
  assert.match(bytes.subarray(8, 12).toString("latin1"), /isom|mp42/, "artifact has a known brand");
  assert.ok(bytes.includes(Buffer.from("avc1")), "artifact carries an h264 track");
  assert.ok(bytes.includes(Buffer.from("moov")), "artifact has a movie box, so it is not a truncated file");
  assert.ok(bytes.length > 8000, `artifact is a real video, got ${bytes.length} bytes`);

  // And the canvas offers it as a playable <video> instead of a broken image.
  await page.waitForFunction(() => {
    const video = document.querySelector(".preview video");
    return video && video.readyState >= 1 && video.videoWidth > 0;
  }, null, { timeout: 15000 });
  const shown = await page.evaluate(() => { const video = document.querySelector(".preview video"); return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, src: video.getAttribute("src"), readyState: video.readyState }; });
  assert.deepEqual({ width: shown.width, height: shown.height }, { width: 320, height: 180 }, "the preview decodes the rendered 320x180 video");
  assert.ok(shown.duration > 0, `the preview reports a real duration, got ${shown.duration}`);
  assert.match(shown.src, /\/api\/file/, "the preview loads through the file endpoint");
  assert.equal(await page.locator(`.card[data-id="${id}"] .title`).textContent(), "remotion-square.mp4");
  assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  await page.close();
});
