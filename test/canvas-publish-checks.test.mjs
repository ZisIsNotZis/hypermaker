// The publish seam, walked the way a person walks it: drop a picture on a card, press Make, read what
// the card says.
//
// This file exists because of a real miss. A panorama scene was placed correctly (1280x160 at y=280,
// measured independently at 0.9999) and the film was REFUSED through the canvas with the scene
// scoring -0.391. Every probe that called `firstCut` directly passed: the cut returns `placements`
// and `cues`, and the checks read them. But `runBuiltin` returned those two facts nested inside
// `film`, so `result.placements` and `result.cues` were `undefined` at the check - the scene was
// compared with a re-derived placement, and the caption gate was handed nothing and passed
// everything. A test that calls the function under the checks cannot see a field the caller forgets
// to pass, which is why these go through the canvas.
//
// Each case below asserts ONE outcome and a fact that would be false if the answer were reached for
// the wrong reason.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { harbourPng } from "./harbour.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

const root = process.cwd();
const chrome = process.env.HYPERMAKER_CHROME || process.env.CHROME_BIN;
const skip = chrome && existsSync(chrome) ? null : "no browser for Remotion (set HYPERMAKER_CHROME)";
const ff = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");
const base = mkdtempSync(join(tmpdir(), "hypermaker-canvas-checks-"));
for (const signal of ["exit", "SIGINT", "SIGTERM"]) process.on(signal, stopAll);

async function canvas({ story, pictures, wpm = null }) {
  const port = await freePort(), workdir = join(base, `ws-${port}`);
  // No model: this is the server-run path, and an agent that ran would make the receipt a lie.
  const called = join(base, `called-${port}.log`), bin = join(base, `codex-${port}`);
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(called)}\nexit 1\n`, { mode: 0o755 });
  const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1", HYPERMAKER_CHROME: chrome } });
  await waitReady(port);
  const call = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init);
  const json = (method, path, payload) => call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
  const view = () => call("/api/workspace").then(r => r.json());
  const upload = (name, bytes, at) => call(`/api/upload?x=${at.x}&y=${at.y}&name=${encodeURIComponent(name)}`, { method: "POST", body: bytes });
  const settle = async (id, tries = 3600) => {
    for (let i = 0; i < tries; i++) {
      const n = (await view()).nodes[id];
      if (n && n.status !== "running" && (n.artifact || n.error)) return n;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`card ${id} never settled: ${JSON.stringify((await view()).nodes[id])}`);
  };
  const press = async (id, extra = {}) => {
    const before = (await view()).nodes[id];
    await json("POST", "/api/generate", { id, prompt: before.prompt || "", ...extra });
    return settle(id);
  };
  const text = await json("POST", "/api/node", { x: 40, y: 40, type: "text", prompt: story.join("\n") });
  const textId = Number(Object.keys(text.nodes).at(-1));
  await json("POST", "/api/generate", { id: textId, prompt: story.join("\n") });
  await settle(textId);
  const voice = await json("POST", "/api/node", { x: 340, y: 40, type: "audio", method: "readaloud" });
  const voiceId = Number(Object.keys(voice.nodes).at(-1));
  await json("POST", "/api/link", { source: textId, target: voiceId });
  const take = await press(voiceId, wpm ? { wpm } : {});
  assert.equal(take.error, null, `the narration: ${take.error}`);
  const pictureIds = [];
  for (const [i, picture] of pictures.entries()) {
    const res = await (await upload(picture.name, picture.bytes, { x: 100 + i * 300, y: 300 })).json();
    pictureIds.push(Number(Object.keys(res.nodes).at(-1)));
  }
  const film = await json("POST", "/api/node", { x: 700, y: 300, type: "video", method: "firstcut" });
  const filmId = Number(Object.keys(film.nodes).at(-1));
  for (const source of [voiceId, ...pictureIds]) await json("POST", "/api/link", { source, target: filmId });
  return { port, workdir, filmId, pictureIds, voiceId, press, view, called, close: () => stopServer(app) };
}

const STORY = ["The harbour wakes before the sun.", "A gull drops a shell on the stones.", "The last boat turns for home."];
// ONE LINE read fast, so its single cue is above the bar. The voice turns each *line* into a phrase,
// so a long line is one cue whose on-screen time is the whole line's speaking time. Measured on this
// line: 200 words a minute gives 16.8 chars/s and correctly PUBLISHES (under the bar of 20); 290
// gives 22-24 and must be refused - which is the pace this test uses, because a test that expects a
// refusal at a pace that should publish would be testing the wrong thing and would pass by accident
// if the gate refused everything.
const TOO_LONG = ["A gull drops a shell on the stones and nobody answers it, and the last boat waits for the tide to turn before it finally turns for home across the wide grey water, past the harbour wall and the sleeping town and the long dark road that runs along the shore all the way to the edge of the morning light where the gulls are already calling."];

test("a panorama dragged onto a scene publishes through the canvas, and the card says it is shown whole", { skip: skip || false }, async () => {
  const wide = join(base, "wide.png");
  writeFileSync(wide, harbourPng("dusk"));
  const pano = join(base, "panorama.png");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", wide, "-vf", "scale=1440:-1,crop=1440:180:0:300", pano], { stdio: "pipe" });

  const c = await canvas({
    story: STORY,
    pictures: [{ name: "harbour.png", bytes: harbourPng("dawn") }, { name: "panorama.png", bytes: readFileSync(pano) }],
  });
  try {
    const cut = await c.press(c.filmId);
    assert.equal(cut.error, null, `a correctly framed panorama must publish through the canvas: ${cut.error}`);
    assert.ok(cut.artifact, "the film was published");
    // The two facts the seam used to drop, now present at the check AND on the card.
    assert.ok(Array.isArray(cut.film?.placements), `the film records its placements: ${JSON.stringify(cut.film?.placements)}`);
    const second = cut.film.placements[1];
    assert.equal(second.fit, "contain", `the panorama is shown whole: ${JSON.stringify(second)}`);
    assert.equal(second.kept, 1);
    assert.deepEqual([second.source.width, second.source.height], [1440, 180], "the recorded source is the file that was dropped");
    assert.ok(cut.film.scenes[1].shown > 0.8, `scene two is measured against its panorama, not skipped: ${cut.film.scenes[1].shown}`);
    // The published bytes are a film that reopens and plays - a record is not a film.
    const reopened = (await c.view()).nodes[c.filmId];
    assert.equal(reopened.artifact, cut.artifact, "the take survives a re-read of the workspace");
    assert.equal(existsSync(join(c.workdir, String(c.filmId), cut.artifact)), true, "the bytes are on disk");
    assert.ok(Number(reopened.film.seconds) > 2.5, `the film has a real duration: ${reopened.film.seconds}`);
  } finally { c.close(); }
});

test("the checks are reached from the cut: a caption that is too fast is refused, a readable one publishes", { skip: skip || false }, async () => {
  const c = await canvas({
    story: STORY,
    pictures: [{ name: "a.png", bytes: harbourPng("dawn") }, { name: "b.png", bytes: harbourPng("dusk") }],
  });
  try {
    const cut = await c.press(c.filmId);
    assert.equal(cut.error, null, `the honest film: ${cut.error}`);
    for (const scene of cut.film.scenes) assert.ok(scene.shown > 0.8, `scene ${scene.index + 1} agrees with its picture: ${scene.shown}`);

    // THE SEAM is proven by the two outcomes below and by the panorama case above, which is the
    // point of going through the canvas: `placements` reaching the scene check is what lets a
    // panorama publish, and `cues` reaching the caption gate is what refuses an unreadable one.
    // Asserting those two observable results needs no knowledge of field names, and a field that
    // stops being passed breaks one of them immediately.
    //
    // A CAPTION THAT CANNOT BE READ. Through the canvas: one long line read at a high pace, so its
    // single cue is far above the bar. The film must not publish, and the reason must be readability.
    const fast = await canvas({
      story: TOO_LONG,
      pictures: [{ name: "a.png", bytes: harbourPng("dawn") }],
      wpm: 290,
    });
    try {
      const refused = await fast.press(fast.filmId);
      assert.equal(refused.artifact, null, `an unreadable film must not publish, got ${refused.artifact}`);
      assert.match(refused.error || "", /cannot be read at the pace it speaks them/i, `the refusal names readability: ${refused.error}`);
      // And it names the MEASURED rate, above the stated bar - so the refusal is about this film's
      // words, not a generic failure that would also appear if the gate were simply broken.
      const rate = /([0-9]+(?:\.[0-9]+)?) characters a second/.exec(refused.error || "");
      assert.ok(rate, `the refusal states the rate: ${refused.error}`);
      assert.ok(Number(rate[1]) > 20, `the rate it refused is above the bar, got ${rate[1]}`);
    } finally { fast.close(); }

    // THE POSITIVE CONTROL for the same gate: the same line at 200 words a minute measures 16.8
    // chars/s - under the bar - and must PUBLISH. Without this, a gate that refused every film would
    // satisfy the assertion above and nobody would notice.
    const ok = await canvas({
      story: TOO_LONG,
      pictures: [{ name: "a.png", bytes: harbourPng("dawn") }],
      wpm: 200,
    });
    try {
      const published = await ok.press(ok.filmId);
      assert.equal(published.error, null, `a readable film at 200 words a minute publishes: ${published.error}`);
      assert.ok(published.artifact, "and it has bytes");
      assert.ok(published.film.captions.worst <= published.film.captions.comfortable, `its measured rate is under the bar: ${JSON.stringify(published.film.captions)}`);
    } finally { ok.close(); }
  } finally { c.close(); }
});
