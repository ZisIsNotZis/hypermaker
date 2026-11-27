import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { browserPath, launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";
import { wavStats } from "./wav.mjs";

// The outcome a person asked for: put a real poster and a real WAV on the canvas,
// press Generate on one more card, and get a film you can play *with sound* - not a
// silent video standing next to a separate audio file you would have to combine.
// After reopening, the film still says which materials it came from, even if one
// of those cards has since been deleted.
//
// Each check here exists because something cheaper passed while the result was
// wrong:
//   * a real agent run produced an MP4 with a valid AAC track of pure silence, so
//     the test measures peak sample, not the presence of a track;
//   * a linked card with no artifact reached the agent as a bare `artifact:
//     (none)`, so the prompt is asserted to carry both real paths;
//   * provenance used to exist only as canvas links, so deleting an input card
//     left a finished film with nothing to explain it.
const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-film-")), bin = join(base, "codex");
// One stand-in binary, dispatching on the node's type so the poster and the film
// are both rendered for real by Remotion.
// The run's own type comes from the environment, not from reading prompt.txt: an
// earlier version read the file inside the child, which could be read before it
// was written and made this test fail intermittently by running the wrong
// renderer. The type is a fact the server already has when it spawns the run.
writeFileSync(bin, `#!/bin/sh
if [ "$HYPERMAKER_NODE_TYPE" = "image" ]; then
  exec node ${JSON.stringify(join(root, "test/fake-poster-codex.mjs"))} "$@"
fi
exec node ${JSON.stringify(join(root, "test/fake-film-codex.mjs"))} "$@"
`);
chmodSync(bin, 0o755);

const chrome = browserPath();
const skip = existsSync(chrome) ? null : `no browser for Remotion or the canvas (set HYPERMAKER_CHROME); looked at ${chrome}`;
const ff = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");

function writeWav(file, seconds = 3) {
  const rate = 44100, frames = rate * seconds, samples = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const t = i / rate, env = Math.min(1, t / 0.05, (seconds - t) / 0.1);
    samples.writeInt16LE(Math.round(env * 0.55 * Math.sin(2 * Math.PI * 440 * t) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + samples.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(samples.length, 40);
  writeFileSync(file, Buffer.concat([header, samples]));
}

function peakOf(file, scratch) {
  const out = join(scratch, "check.wav");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "44100", out]);
  return wavStats(out).peak;
}

let app, browser, port, workdir;
before(async () => {
  if (skip) return;
  port = await freePort();
  workdir = join(base, "ws");
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); stopServer(app); stopAll(); });

const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const patch = (body) => fetch(`http://127.0.0.1:${port}/api/node`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const workspace = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
async function settle(id, tries = 400) {
  let node;
  for (let i = 0; i < tries; i++) {
    node = (await workspace()).nodes[id];
    if (node?.artifact || node?.error) return node;
    await new Promise(r => setTimeout(r, 250));
  }
  return node;
}

test("one card turns generated canvas material into a playable film with sound, and remembers its sources", async t => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack || String(error)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.querySelector("#cards"));
  const generate = async id => {
    await page.waitForSelector(`.card[data-id="${id}"] [data-generate]`);
    await page.locator(`.card[data-id="${id}"] [data-generate]`).click();
    return settle(id);
  };

  // 1. A poster that is really rendered by Remotion - a linked-but-empty card
  //    would prove the link, not the material.
  const imageId = Number(Object.keys((await post("/api/node", { x: 60, y: 60, type: "image", method: "remotion", prompt: "the poster", quality: "demo" })).nodes).at(-1));
  await page.reload({ waitUntil: "load" });
  const poster = await generate(imageId);
  assert.equal(poster.error, null, `the poster rendered, got ${poster.error}`);
  const posterBytes = readFileSync(join(workdir, String(imageId), poster.artifact));
  assert.deepEqual([...posterBytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "the poster is a real PNG");

  // 2. A real WAV on its own card (the audio path is tested separately).
  const audioId = Number(Object.keys((await post("/api/node", { x: 60, y: 420, type: "audio", method: "synth", prompt: "the tone", quality: "demo" })).nodes).at(-1));
  mkdirSync(join(workdir, String(audioId)), { recursive: true });
  writeWav(join(workdir, String(audioId), "tone.wav"));
  assert.equal((await patch({ id: audioId, artifact: "tone.wav" })).nodes[audioId].artifact, "tone.wav");

  // 3. One film card, linked to both materials.
  const filmId = Number(Object.keys((await post("/api/node", { x: 420, y: 220, type: "video", method: "remotion", prompt: "make one film from these", quality: "demo" })).nodes).at(-1));
  await post("/api/link", { source: imageId, target: filmId });
  await post("/api/link", { source: audioId, target: filmId });
  await page.reload({ waitUntil: "load" });

  const film = await generate(filmId);
  assert.equal(film.error, null, `the film rendered without error, got ${film.error}`);

  // 4. The prompt the agent received named both real artifacts. This is the exact
  //    break a person hit: links existed, but the prompt said `artifact: (none)`.
  const prompt = readFileSync(join(workdir, String(filmId), "prompt.txt"), "utf8");
  assert.match(prompt, new RegExp(`artifact path: .*${imageId}.*${poster.artifact}`), `the prompt named the poster, got:\n${prompt.match(/# INPUTS[\s\S]{0,600}/)?.[0]}`);
  assert.match(prompt, new RegExp(`artifact path: .*${audioId}.*tone\\.wav`), "the prompt named the audio file");
  assert.doesNotMatch(prompt, /artifact: \(none\)/, "neither input reached the agent as an empty card");

  // 5. The film is a real h264 container with audible sound in it.
  const file = join(workdir, String(filmId), film.artifact);
  const bytes = readFileSync(file);
  assert.equal(bytes.subarray(4, 8).toString("latin1"), "ftyp", "the film is an ISO base media file");
  assert.ok(bytes.includes(Buffer.from("avc1")), "the film has an h264 track");
  assert.ok(bytes.includes(Buffer.from("mp4a")), "the film declares an audio track");
  const peak = peakOf(file, base);
  assert.ok(peak > 1000, `the film's audio is audible, not a silent track (peak ${peak})`);

  // 6. The canvas plays it, which is what "a film you can watch" means.
  await page.waitForFunction(() => {
    const video = document.querySelector(".preview video");
    return video && video.readyState >= 1 && video.videoWidth > 0;
  }, null, { timeout: 20000 });
  const shown = await page.evaluate(() => {
    const video = document.querySelector(".preview video");
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
  });
  // h264 needs even dimensions, so 720x405 becomes 720x404 - the same thing the
  // real agent hit. Asserting 405 would pin a value the codec cannot produce.
  assert.deepEqual({ width: shown.width, height: shown.height }, { width: 720, height: 404 });
  assert.ok(shown.duration > 2.5, `the film runs its full length, got ${shown.duration}`);

  // 7. Provenance is on the card, and survives the input card being deleted.
  const provenance = await page.locator(`.card[data-id="${filmId}"] .sources`).textContent();
  assert.match(provenance, new RegExp(`#${imageId} image`), `the card names the poster, got ${provenance}`);
  assert.match(provenance, new RegExp(`#${audioId} audio`), `the card names the audio, got ${provenance}`);
  assert.match(provenance, /tone\.wav/, "the card names the audio file itself");

  await page.evaluate(id => fetch("/api/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }), audioId);

  // Reopen the way a person actually does the next day: stop the server and start
  // it again, so the workspace is read back from workspace.yml. Reloading only the
  // page would leave the in-memory graph in place and prove nothing about what was
  // persisted - a set of sources that serialize but never parse would pass that.
  stopServer(app);
  await new Promise(r => setTimeout(r, 500));
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "0" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(`.card[data-id="${filmId}"]`);
  await page.waitForTimeout(600);
  const afterReopen = await page.locator(`.card[data-id="${filmId}"] .sources`).textContent();
  assert.match(afterReopen, new RegExp(`#${audioId} audio`), `provenance outlives the deleted input, got ${afterReopen}`);
  assert.equal(await page.locator(`.card[data-id="${audioId}"]`).count(), 0, "the deleted card is gone");
  assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  await page.close();
});
