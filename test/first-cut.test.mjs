import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { browserPath, launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";
import { verifyFilm } from "../server/film.mjs";
import { firstCut } from "../server/offline.mjs";

// A WAV of the same length as a take, carrying nothing. Built here rather than with the bundled
// ffmpeg's `anullsrc`, which this Remotion build ships without.
function silenceWav(seconds, rate = 22050) {
  const frames = Math.round(seconds * rate), data = Buffer.alloc(frames * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// The first film, made by the server with no model in the path.
//
// This is the chain a person with one sentence and no Codex account could not complete at all:
// the text card needed an agent, the narration needed an agent, and the film needed an agent -
// so a blank canvas on a machine whose model route does not answer (see `docs/evidence/`) was a
// canvas where nothing could be made. Each link is now a method the server runs, and the choice
// of what a new card starts on belongs to the registry rather than to the canvas.
//
// What is *not* relaxed is the checking. A narration still has to measure as speech and say only
// words the card was given; a film still has to last as long as its narration and carry that
// narration's voice rather than any audio track. The last test proves the film check refuses what
// it is for - a silent track, and a film you can only hear the beginning of - because a check
// that has never refused anything is not evidence.
const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-first-cut-"));
const chrome = browserPath();
const skip = existsSync(chrome) ? null : `no browser for Remotion (set HYPERMAKER_CHROME); looked at ${chrome}`;
const ff = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");

// An agent that records any call and exits at once. The whole claim of this file is that the
// first film needs no agent, so the probe existing at all is how "it ran anyway" gets caught.
const bin = join(base, "codex"), called = join(base, "called.log");
writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(called)}\necho '{"artifact":null,"error":"the agent path was entered"}' > "$4"\nexit 1\n`);
chmodSync(bin, 0o755);

let app, port, workdir;
test.before(async () => {
  if (skip) return;
  port = await freePort();
  workdir = join(base, "ws");
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1", HYPERMAKER_CHROME: chrome } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
});
test.after(() => { stopServer(app); stopAll(); });

const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const workspace = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
const latest = res => Number(Object.keys(res.nodes).at(-1));
async function settle(id, tries = 2400) {
  for (let i = 0; i < tries; i++) {
    const n = (await workspace()).nodes[id];
    if (n && n.status !== "running" && (n.artifact || n.error)) return n;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`node ${id} never settled: ${JSON.stringify((await workspace()).nodes[id])}`);
}

test("a blank canvas makes a playable film from one sentence, with no model and no account", async t => {
  if (skip) return t.skip(skip);

  // 1. The words. A new text card starts on the method that writes the person's own prompt, so
  //    the most ordinary first step needs nothing installed.
  const text = latest(await post("/api/node", { x: 40, y: 40, type: "text", prompt: "The sea at night is never still." }));
  assert.equal((await workspace()).nodes[text].method, "plain", "a new text card starts on the method that needs no model");
  await post("/api/generate", { id: text });
  const words = await settle(text);
  assert.equal(words.error, null, `the words were written, got ${words.error}`);
  assert.equal(readFileSync(join(workdir, String(text), words.artifact), "utf8").trim(), "The sea at night is never still.", "the text card holds exactly the sentence that was typed");

  // 2. The take, at a pace chosen *before* the first read. This is the thing the card could not
  //    do: the pace box appeared only after a take existed, so the first read's pace came from an
  //    instruction in the prompt and whatever an agent made of it.
  const audio = latest(await post("/api/node", { x: 380, y: 40, type: "audio", prompt: "" }));
  assert.equal((await workspace()).nodes[audio].method, "readaloud", "a new audio card starts on the server-run read");
  await post("/api/link", { source: text, target: audio });
  await post("/api/generate", { id: audio, wpm: 200 });
  const spoken = await settle(audio);
  assert.equal(spoken.error, null, `the take was read, got ${spoken.error}`);
  assert.ok(Math.abs(spoken.narration.pace.wpm - 200) <= 4, `asked for 200 words a minute before the first read, the take reads at ${spoken.narration.pace.wpm}`);
  assert.equal(spoken.narration.pace.askedWpm, 200, "the take records what it was asked for as well as what it reached");
  assert.equal(spoken.promptUsed, `the words from #${text} - read at 200 words a minute`, "the card says where the words came from and how fast it was asked to read them");

  // 3. The film, from the take and the words.
  const film = latest(await post("/api/node", { x: 720, y: 40, type: "video" }));
  assert.equal((await workspace()).nodes[film].method, "firstcut", "a new video card starts on the server-run cut");
  await post("/api/link", { source: audio, target: film });
  await post("/api/link", { source: text, target: film });
  await post("/api/generate", { id: film });
  const cut = await settle(film);
  assert.equal(cut.error, null, `the film was rendered, got ${cut.error}`);
  assert.match(cut.artifact, /^versions\/v\d+-film\.mp4$/, "the film is published under a versioned name");
  const bytes = readFileSync(join(workdir, String(film), cut.artifact));
  assert.deepEqual([...bytes.subarray(4, 8)].map(c => String.fromCharCode(c)).join(""), "ftyp", "the published file is a real MP4, not a placeholder");

  // 4. What the film measured, read back from the published bytes rather than from the render's
  //    own opinion: h264 with an AAC track, at least as long as the narration, and its embedded
  //    audio is that narration.
  assert.equal(cut.film.videoCodec, "h264");
  assert.equal(cut.film.audioCodec, "aac");
  assert.equal(cut.film.fps, 30, "the measured frame rate is the one the composition asked for");
  assert.ok(cut.film.peak > 0.05, `the embedded track is not silence, peak ${cut.film.peak}`);
  assert.ok(cut.film.correlation > 0.9, `the embedded track is this narration, agreement ${cut.film.correlation}`);
  assert.ok(cut.film.seconds + 0.1 >= Number(spoken.narration.seconds), `the film (${cut.film.seconds}s) is not shorter than its narration (${spoken.narration.seconds}s)`);

  // 5. The film's published record is the source that made its picture, not a description of it.
  //    A supervisor opened the published file expecting the render's source and found only
  //    comments naming the soundtrack and the length - the code that decided how the film looks
  //    had been dropped with the run directory, so the take could not reproduce its own bytes.
  //    The header is still there, and under it is the composition itself.
  assert.ok(cut.script, `the film published a record of what made it, got ${cut.script}`);
  assert.match(cut.script, /^versions\/v\d+-first-cut-source\.jsx$/, `the record is published beside the film and numbered with it: ${cut.script}`);
  const source = readFileSync(join(workdir, String(film), cut.script), "utf8");
  assert.match(source, /^\/\/ soundtrack: .*\(\d+\.\d\d s at \d+ Hz\)/m, "the header says which soundtrack and how long it was");
  assert.match(source, /import \{ AbsoluteFill, Audio,/, "the published record is JavaScript that renders a composition");
  assert.match(source, /registerRoot\(Root\)/, "and it registers the composition it rendered");
  assert.ok(source.includes(`durationInFrames={${cut.film.frames}}`), `the composition's frame count is the published length (${cut.film.frames}), so the record is the source that made this file`);
  assert.match(source, /staticFile\('track\.wav'\)/, "the narration is the track the composition plays");
  // The soundtrack file it names is the frozen copy of the take on the linked card, so a person
  // can check the record against the audio card rather than against a name nothing points at.
  assert.equal(cut.film.soundtrack.id, audio, "the film records which audio card it was made from");
  assert.equal(cut.film.soundtrack.artifact, spoken.artifact, "and which take of that card");

  // 6. And no agent was asked for any of it.
  assert.equal(existsSync(called), false, "the agent path was never entered for a first film");
});

test("a first read refuses what it cannot say, and publishes nothing", async t => {
  if (skip) return t.skip(skip);
  // A symbol the voice cannot name is refused by name, before a render is spent, and the card
  // keeps whatever it had (nothing here, so it stays a draft with a reason).
  const audio = latest(await post("/api/node", { x: 40, y: 420, type: "audio", prompt: "The price is ¥500." }));
  await post("/api/generate", { id: audio });
  const refused = await settle(audio);
  assert.equal(refused.artifact, null, "nothing was published for a line the voice cannot say");
  assert.match(refused.error, /¥/, `the refusal names the symbol it could not say: ${refused.error}`);
  assert.match(refused.error, /currency this voice does not name/, `the refusal says what is wrong with it: ${refused.error}`);
  assert.equal(existsSync(join(workdir, String(audio), "versions")), false, "no version was created for a refused read");

  // An empty card has nothing to read, and says so instead of publishing silence.
  const empty = latest(await post("/api/node", { x: 380, y: 420, type: "audio", prompt: "" }));
  await post("/api/generate", { id: empty });
  const nothing = await settle(empty);
  assert.equal(nothing.artifact, null, "an empty card published nothing");
  assert.match(nothing.error, /nothing to read out loud/i, `the empty card says why: ${nothing.error}`);

  // A pace the voice cannot reach is refused with the limit and the pace the script reaches, not
  // silently clamped to something nobody asked for.
  const fast = latest(await post("/api/node", { x: 720, y: 420, type: "audio", prompt: "The sea at night is never still." }));
  await post("/api/generate", { id: fast, wpm: 900 });
  const tooFast = await settle(fast);
  assert.equal(tooFast.artifact, null, "an unreachable pace published nothing");
  assert.match(tooFast.error, /outside what this voice can do/, `the refusal names the limit: ${tooFast.error}`);
  assert.match(tooFast.error, /reads this script at \d+ words per minute/, `and the pace it does reach: ${tooFast.error}`);
});

test("a first film refuses a film it cannot show carries its narration", async t => {
  if (skip) return t.skip(skip);
  // A card with no soundtrack is refused before anything is rendered.
  const lone = latest(await post("/api/node", { x: 40, y: 760, type: "video", prompt: "" }));
  await post("/api/generate", { id: lone });
  const refused = await settle(lone);
  assert.equal(refused.artifact, null);
  assert.match(refused.error, /needs a soundtrack/, `the refusal says what is missing: ${refused.error}`);
});

test("a server-read take can be re-read at another pace, and a film keeps the take it was made from", async t => {
  if (skip) return t.skip(skip);
  // The two paths that follow a first film, walked by a supervisor by hand and pinned here
  // because each is a promise the product makes about a take that already exists:
  //   * a take the server read is re-readable exactly like an agent's, because after the bytes
  //     exist they are the same kind of file with the same timeline;
  //   * re-reading it does not restyle a film that was already cut from the old take - the film
  //     keeps playing the narration it was made from, and the next Generate would use the new one.
  const text = latest(await post("/api/node", { x: 40, y: 1180, type: "text", prompt: "The tide comes in at six." }));
  await post("/api/generate", { id: text });
  await settle(text);
  const audio = latest(await post("/api/node", { x: 380, y: 1180, type: "audio" }));
  await post("/api/link", { source: text, target: audio });
  await post("/api/generate", { id: audio, wpm: 140 });
  const first = await settle(audio);
  assert.equal(first.error, null, `the first read: ${first.error}`);
  assert.ok(Math.abs(first.narration.pace.wpm - 140) <= 4, `asked 140, reads ${first.narration.pace.wpm}`);

  // The film, from that take.
  const film = latest(await post("/api/node", { x: 720, y: 1180, type: "video" }));
  await post("/api/link", { source: audio, target: film });
  await post("/api/link", { source: text, target: film });
  await post("/api/generate", { id: film });
  const cut = await settle(film);
  assert.equal(cut.error, null, `the film: ${cut.error}`);
  const filmFile = join(workdir, String(film), cut.artifact);
  const filmBytes = readFileSync(filmFile);

  // Re-read the take at another pace from the card.
  const reply = await post("/api/repace", { id: audio, wpm: 115 });
  assert.equal(reply.code ?? 202, 202, `the re-read was refused: ${reply.error}`);
  const second = await settle(audio);
  assert.equal(second.error, null, `the re-read: ${second.error}`);
  assert.ok(Math.abs(second.narration.pace.wpm - 115) <= 4, `asked 115, the re-read reads ${second.narration.pace.wpm}`);
  assert.equal(second.versions.length, 1, "the take it was re-read from is kept");
  assert.equal(second.versions[0].artifact, first.artifact);
  assert.equal(second.narration.repace.onlyThePaceChanged, true, `the re-read should differ only in pace: ${second.narration.repace.notReproduced}`);

  // And the film is untouched by any of it: same bytes, and it still names the take it used.
  assert.ok(readFileSync(filmFile).equals(filmBytes), "re-reading a narration must not re-cut a film that was already made from it");
  const after = (await workspace()).nodes[film];
  assert.equal(after.artifact, cut.artifact, "the film on the card is still the one that was published");
  assert.equal(after.film.soundtrack.artifact, first.artifact, "and it still says which narration it was made from");
  assert.notEqual(after.film.soundtrack.artifact, second.artifact, "not the take that replaced it on the audio card");
});

test("Stop during a server-run film cancels it and keeps the approved take, its sources and its measurements", async t => {
  if (skip) return t.skip(skip);
  // A film render takes seconds, which is exactly the window a person presses Stop in. The
  // promise is that stopping it costs nothing: the take on the card, the material it froze and
  // the numbers measured about it are exactly as they were, and the card can be tried again.
  const text = latest(await post("/api/node", { x: 40, y: 1540, type: "text", prompt: "A slow tide, and a long wait for it." }));
  await post("/api/generate", { id: text }); await settle(text);
  const audio = latest(await post("/api/node", { x: 380, y: 1540, type: "audio" }));
  await post("/api/link", { source: text, target: audio });
  await post("/api/generate", { id: audio, wpm: 150 });
  const spoken = await settle(audio);
  assert.equal(spoken.error, null, `the narration: ${spoken.error}`);

  const film = latest(await post("/api/node", { x: 720, y: 1540, type: "video" }));
  await post("/api/link", { source: audio, target: film });
  await post("/api/link", { source: text, target: film });
  await post("/api/generate", { id: film });
  const first = await settle(film);
  assert.equal(first.error, null, `the first film: ${first.error}`);
  const approved = { artifact: first.artifact, film: first.film, sources: first.sources };

  // Press Generate again and stop it *while the renderer is working*, not while the card is still
  // being prepared: the window that matters is the one a person actually sits through. The signal
  // is the run's own bundle appearing in the attempt directory, which happens after the
  // composition is written and before the frames are done.
  let rendering = false;
  await post("/api/generate", { id: film });
  for (let i = 0; i < 1200; i++) {
    const n = (await workspace()).nodes[film];
    if (!n || n.status !== "running") break;
    if (rendering) break;
    if (n.attempt && (existsSync(join(n.attempt, "build")) || existsSync(join(n.attempt, "public")))) {
      rendering = true;
      await post("/api/cancel", { id: film });
      continue;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(rendering, true, "the film really got as far as rendering before Stop was pressed, so this test is about a stopped render");
  let stopped = (await workspace()).nodes[film];
  for (let i = 0; i < 600 && stopped.status === "running"; i++) { await new Promise(r => setTimeout(r, 50)); stopped = (await workspace()).nodes[film]; }
  assert.equal(stopped.status, "cancelled", `a stopped film is cancelled, not a failed render: ${stopped.status} / ${stopped.error}`);
  assert.equal(stopped.artifact, approved.artifact, "the approved film is still the one on the card");
  assert.deepEqual(stopped.film, approved.film, "and its measurements are still there");
  assert.deepEqual(stopped.sources, approved.sources, "and the material it was made from");
  assert.equal(existsSync(join(workdir, String(film), approved.artifact)), true, "the published file was never touched");
});

test("the film check refuses silence, a truncated film, and another take's voice", async t => {
  if (skip) return t.skip(skip);
  // The negative controls for `verifyFilm`, built from a *real* film rather than from a fixture:
  // without them, "the film carried its narration" could be a check that never looks at the audio
  // at all - and a real agent has already shipped a silent film once with every cheaper check
  // passing. Each case changes exactly one thing about a film that is known good.
  //
  // The bundled ffmpeg has encoders and muxers but no `lavfi` source filters, which is why these
  // are made by remuxing a real render instead of synthesising a test card with `color=`.
  const dir = mkdtempSync(join(tmpdir(), "hypermaker-filmcheck-"));
  const narration = join(dir, "narration.wav"), timeline = join(dir, "t.json"), script = join(dir, "s.txt");
  writeFileSync(script, "The sea at night is never still.\nIt carries every colour of the sky.");
  execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", script, "--out", narration, "--timeline", timeline], { stdio: "pipe" });
  const good = join(dir, "good.mp4");
  await firstCut({ attemptDir: dir, sources: [{ id: 1, type: "audio", artifact: "narration.wav", frozen: narration }], cancelRef: {} });
  const rendered = join(dir, "film.mp4");
  assert.ok(existsSync(rendered), "the real render used as the base of these controls exists");
  const passed = verifyFilm({ file: rendered, soundtrackFile: narration, projectRoot: root });
  assert.equal(passed.ok, true, `the good film must pass before its failures mean anything: ${passed.problems.join("; ")}`);
  const remux = (out, audio, extra = []) => {
    execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", rendered, "-i", audio, ...extra, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", out]);
    return out;
  };

  // 1. Silence: both streams real, and every sample zero.
  const silentAudio = join(dir, "silence.wav");
  writeFileSync(silentAudio, silenceWav(6));
  const quiet = verifyFilm({ file: remux(good, silentAudio), soundtrackFile: narration, projectRoot: root });
  assert.equal(quiet.ok, false, "a silent film was accepted");
  assert.match(quiet.problems.join(" "), /every sample is zero|plays in silence/, `the refusal should name the silence: ${quiet.problems.join("; ")}`);

  // 2. Truncated: the film stops before its narration does. The sound is real and it *is* this
  //    narration, so only the length comparison can catch it - the failure a fixed frame count
  //    produced when a longer sentence was read.
  const short = join(dir, "short.mp4");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", rendered, "-t", "1", "-c:v", "copy", "-c:a", "aac", short]);
  const cut = verifyFilm({ file: short, soundtrackFile: narration, projectRoot: root });
  assert.equal(cut.ok, false, "a film shorter than its narration was accepted");
  assert.match(cut.problems.join(" "), /cut off|lasts .* but its narration lasts/, `the refusal should name the truncation: ${cut.problems.join("; ")}`);

  // 3. Another take's voice: real audio, and not this narration.
  const other = join(dir, "other.wav");
  execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--text", "A different sentence entirely, at another pace.", "--out", other, "--timeline", join(dir, "o.json")], { stdio: "pipe" });
  const stranger = verifyFilm({ file: remux(join(dir, "wrong.mp4"), other), soundtrackFile: narration, projectRoot: root });
  assert.equal(stranger.ok, false, "a film carrying another take's narration was accepted");
  assert.match(stranger.problems.join(" "), /not the narration it was given/, `the refusal should say the sound is not this take's: ${stranger.problems.join("; ")}`);
  assert.doesNotMatch(stranger.problems.join(" "), /too short|cut off|stops at/, `a different recording must not be described as this take with a piece missing: ${stranger.problems.join("; ")}`);

  // 4. No audio stream at all: strip it and keep the picture.
  const mute = join(dir, "mute.mp4");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", rendered, "-map", "0:v:0", "-c:v", "copy", "-an", mute]);
  const silentTrack = verifyFilm({ file: mute, soundtrackFile: narration, projectRoot: root });
  assert.equal(silentTrack.ok, false, "a film with no audio stream was accepted");
  assert.match(silentTrack.problems.join(" "), /no audio stream/, `the refusal should say the track is missing: ${silentTrack.problems.join("; ")}`);
});

test("the canvas offers the pace before the first take, and pressing Generate sends it", async t => {
  if (skip) return t.skip(skip);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => document.querySelector("#cards"));
    // A card added the way a person adds one, then switched to audio.
    await page.locator("#add-card").click();
    await page.waitForFunction(() => document.querySelectorAll(".card").length > 0);
    const id = Number(Object.keys((await workspace()).nodes).at(-1));
    await page.locator(`.card[data-id="${id}"] [data-field=type]`).selectOption("audio");
    await page.waitForFunction(cardId => document.querySelector(`.card[data-id="${cardId}"] [data-field=method]`)?.value === "readaloud", id);

    // The box is there before any take exists - the first read is where the pace matters most -
    // and it starts at an ordinary speed rather than empty.
    const box = page.locator(`.card[data-id="${id}"] .repace input`);
    await box.waitFor({ state: "visible", timeout: 10000 });
    assert.equal(await box.inputValue(), "150", "the pace box starts at ordinary speech");

    const prompt = page.locator(`.card[data-id="${id}"] [data-prompt]`);
    await prompt.fill("The tide comes in at six.");
    await page.locator(`.card[data-id="${id}"] .repace input`).fill("110");
    await page.locator(`.card[data-id="${id}"] [data-generate]`).click();
    const settled = await settle(id);
    assert.equal(settled.error, null, `the first read from the canvas failed: ${settled.error}`);
    assert.ok(Math.abs(settled.narration.pace.wpm - 110) <= 4, `the number typed in the box is the pace of the first take, got ${settled.narration.pace.wpm}`);
    // The box now describes the bytes: the number the take actually reads at, not the one that was
    // asked for. `settle` returns as soon as the server has recorded the take, which is a moment
    // before the canvas repaints, so this waits for the repaint rather than racing it.
    const read = String(Math.round(settled.narration.pace.wpm));
    await page.waitForFunction(({ cardId, want }) => document.querySelector(`.card[data-id="${cardId}"] .repace input`)?.value === want, { cardId: id, want: read }, { timeout: 5000 });
    assert.equal(await page.locator(`.card[data-id="${id}"] .repace input`).inputValue(), read, "after the take the box shows what the take reads at");
    assert.equal(await page.locator(`.card[data-id="${id}"] [data-repace]`).count(), 1, "and the read-again control is offered for this take");
  } finally {
    await browser.close();
  }
});
