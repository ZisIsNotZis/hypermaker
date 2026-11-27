import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserPath, launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

// An audio card is only useful if the file plays and the player can say how long
// it is. Both halves were once broken in a way the video card hid:
//   * the file endpoint sent no content-length and ignored Range, so Chromium
//     reported `duration: null` for a real WAV and the progress bar was dead,
//     while an MP4 survived on its own `moov` box and looked fine;
//   * nothing produced audio at all unless tts.cpp or bark.cpp happened to be
//     installed, which on a fresh machine they are not.
// The stand-in agent synthesizes real PCM with no external tool, so this test
// exercises the artifact, the endpoint and the player without a speech model.
const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-audio-")), bin = join(base, "audio-codex");
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(root, "test/fake-audio-codex.mjs"))} "$@"\n`); chmodSync(bin, 0o755);

const chrome = browserPath();
const skip = existsSync(chrome) ? null : `no browser for the canvas preview (set HYPERMAKER_CHROME); looked at ${chrome}`;

let app, browser, port, dir;
before(async () => {
  if (skip) return;
  port = await freePort();
  dir = mkdtempSync(join(base, "ws-"));
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: dir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); stopServer(app); stopAll(); });

const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const workspace = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());

test("an audio node renders a real WAV and the canvas player can report its length", async t => {
  if (skip) return t.skip(skip);
  const created = await post("/api/node", { x: 80, y: 90, type: "audio", method: "synth", quality: "demo", prompt: "a six second test tone" });
  const id = Object.keys(created.nodes).at(-1);
  assert.equal(created.nodes[id].method, "synth", "an audio card can start on a method that needs nothing installed");

  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack || String(error)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector(`.card[data-id="${id}"]`);
  await page.locator(`.card[data-id="${id}"] [data-generate]`).click();

  let node;
  for (let i = 0; i < 80; i++) {
    node = (await workspace()).nodes[id];
    if (node?.artifact || node?.error) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(node?.error, null, `generation reported no error, got ${node?.error}`);
  assert.equal(node?.artifact, "tone-test.wav");

  // The bytes on disk are a real RIFF/WAVE file with the declared shape.
  const bytes = readFileSync(join(dir, String(id), node.artifact));
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "RIFF", "artifact starts with a RIFF header");
  assert.equal(bytes.subarray(8, 12).toString("latin1"), "WAVE", "artifact declares the WAVE form");
  assert.equal(bytes.readUInt16LE(20), 1, "artifact is uncompressed PCM");
  assert.equal(bytes.readUInt16LE(22), 1, "artifact is mono");
  assert.equal(bytes.readUInt32LE(24), 44100, "artifact is 44100 Hz");
  assert.equal(bytes.readUInt16LE(34), 16, "artifact is 16-bit");
  const dataSize = bytes.readUInt32LE(40);
  assert.equal(dataSize, bytes.length - 44, "the data chunk size matches the bytes that follow");
  // A realistic clip length, not a token beep: the player only loses its
  // duration on files bigger than its read-ahead buffer, so a short fixture
  // would let the endpoint regress without this test noticing.
  assert.equal(dataSize / 2 / 44100, 6, "artifact is six seconds of audio");
  assert.ok(bytes.length > 400_000, `artifact is a normal clip size, got ${bytes.length} bytes`);
  assert.ok(bytes.subarray(44).some((byte, i) => i % 2 === 0 && byte !== 0), "the samples are not silence");

  // The endpoint answers like a media server: a length, range support, and a 206
  // that carries the slice it actually sent.
  const fileUrl = `http://127.0.0.1:${port}/api/file?path=${encodeURIComponent(join(dir, String(id), node.artifact))}`;
  const full = await fetch(fileUrl);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-length"), String(bytes.length), "the response states its length");
  assert.equal(full.headers.get("accept-ranges"), "bytes", "the response offers byte ranges");
  const part = await fetch(fileUrl, { headers: { range: "bytes=0-99" } });
  assert.equal(part.status, 206, "a range request gets a partial response");
  assert.equal(part.headers.get("content-range"), `bytes 0-99/${bytes.length}`);

  // And the canvas plays it: a real duration, which is what a null-length
  // response used to take away while every other check still looked green.
  await page.waitForFunction(() => {
    const audio = document.querySelector(".preview audio");
    return audio && audio.readyState >= 1 && !Number.isNaN(audio.duration);
  }, null, { timeout: 10000 });
  const shown = await page.evaluate(() => {
    const audio = document.querySelector(".preview audio");
    return { duration: audio.duration, readyState: audio.readyState, seekable: audio.seekable.length, src: audio.getAttribute("src"), error: audio.error && audio.error.code };
  });
  assert.equal(shown.error, null, "the player reports no media error");
  assert.equal(Number(shown.duration.toFixed(2)), 6, `the player reports the real length, got ${shown.duration}`);
  assert.ok(shown.seekable >= 1, "the player can seek, so the progress bar is usable");
  assert.match(shown.src, /\/api\/file/, "the preview loads through the file endpoint");
  assert.equal(await page.locator(`.card[data-id="${id}"] .title`).textContent(), "tone-test.wav");
  assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  await page.close();
});
