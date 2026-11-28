// A short film, made through the canvas from a blank workspace, whose narration is understood.
//
//   HYPERMAKER_CHROME=/path/to/chrome HYPERMAKER_ESPEAK=/path/to/espeak-ng \
//   node test/story-engine-voice.mjs
//   ... plus ASR_PYTHON=<venv/bin/python> ASR_MODEL=<model dir> to transcribe the film's own track.
//
// WHY THIS WALK EXISTS. Every other check of a narration measures the *signal*: it is loud, it is
// periodic, its phrases follow one another, its words are the voice's words, its bytes reproduce
// from its record. All of that was already true of a voice that an independent recognizer
// transcribed as nothing at all - WER 1.0 on this project's own 69-word corpus - so a green suite
// and an unlistenable film coexisted for a release. The only measurement that answers "can the
// person who made this follow it?" is a recognizer on the finished article, and this walk takes it
// from the *published MP4's own audio track*, after AAC, at the pace the film plays - not from the
// WAV that went in. That difference matters: the track is what a viewer hears, and an encoder that
// mangled it would leave every check upstream green.
//
// WHAT IT DOES, as gestures rather than calls:
//   * two pictures the walker picks are brought onto a blank canvas with + File;
//   * a two-act story is typed on a text card and a narration card reads it at 150 words a minute;
//   * the two pictures and the voice are dragged onto a film card, in the order the story is told;
//   * the film is published, decoded, and its narration is measured three ways: the product's own
//     acoustic judge, the reproduction check the server refuses a bad take with, and a real
//     speech recognizer on the extracted track.
//
// WHAT IT DOES NOT ESTABLISH. The two pictures are drawn by `test/harbour.mjs`, not photographed -
// this walk must run without a network and without a checked-in binary. So "the pictures read well"
// is established as *framing and caption legibility*, not as photographic composition. And no model
// is in the loop: the story is typed by the walker, so this is a film a person can make in five
// minutes with no account, not a film a model directed.
//
// Exit 0 only if the whole walk passes. The receipt (with the transcript) is written to
// `$STORY_OUT` or `.tmp/story-engine-voice/` so a number can be quoted without re-running it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { harbourPng } from "./harbour.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";
import { wavSamples } from "../voice/wav.mjs";
import { correlation, bindTake } from "../voice/bind.mjs";
import { judge } from "../voice/render.mjs";
import { readTranscript, verdict } from "../voice/transcript.mjs";
import { measure } from "../voice/measure.mjs";

const root = process.cwd();
const chrome = process.env.HYPERMAKER_CHROME || process.env.CHROME_BIN;
if (!chrome || !existsSync(chrome)) { console.error(`set HYPERMAKER_CHROME to a Chromium build; looked at ${chrome || "nothing"}`); process.exit(1); }
const espeak = process.env.HYPERMAKER_ESPEAK;
if (!espeak || !existsSync(espeak)) {
  // Not a skip and not a pass: the point of this walk is the engine's voice, and a run without it
  // would measure the built-in voice while claiming to have measured this. Refusing to run is the
  // only honest answer; `story-own-materials.mjs` is the walk for a machine with no engine.
  console.error(`set HYPERMAKER_ESPEAK to an espeak-ng binary; looked at ${espeak || "nothing"}`);
  console.error("without it this walk would measure the built-in voice and report it as the engine's.");
  process.exit(1);
}
const ff = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");
const ffprobe = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffprobe");
const out = process.env.STORY_OUT || join(root, ".tmp", "story-engine-voice");
mkdirSync(out, { recursive: true });
const base = mkdtempSync(join(tmpdir(), "hyper-story-engine-"));

// THE STORY: two acts, a beginning, a turn and an end. Each line is short enough to read at the pace
// it is spoken, which the caption gate below measures rather than assumes. Two acts because that is
// the film this project promised: two pictures, one narrative, and each act says its own line.
const STORY = [
  "The harbour wakes before the sun.",     // act one: the place, at rest
  "A gull drops a shell on the stones.",    // act one: the first small event
  "By evening the last boat turns for home.", // act two: the turn
  "The water keeps the light a little longer.", // act two: the end
];
const dawn = join(base, "harbour at dawn.png"), dusk = join(base, "harbour at dusk.png");
writeFileSync(dawn, harbourPng("dawn"));
writeFileSync(dusk, harbourPng("dusk"));

const port = await freePort();
const workdir = join(base, "ws");
// No agent may run. Anything that would spend a model fails instead, and the log proves it was
// never reached - a receipt that said "no model" while one ran is the mistake this project has made.
const called = join(base, "called.log"), bin = join(base, "codex");
writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(called)}\nexit 1\n`, { mode: 0o755 });
// The engine is named explicitly rather than left to PATH, so this walk measures the binary it says
// it measured even on a machine that has none installed system-wide.
const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1", HYPERMAKER_CHROME: chrome, HYPERMAKER_ESPEAK: espeak } });
await waitReady(port);
const browser = await chromium.launch({ headless: true, executablePath: chrome });
const receipt = { story: STORY, materials: [dawn, dusk], engine: espeak, steps: [], films: [] };
const note = (name, value) => { receipt.steps.push({ name, value }); console.log(name, JSON.stringify(value)); };
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1900, height: 1100 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector("#cards");
  const ws = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
  const card = id => page.locator(`.card[data-id="${id}"]`);
  const settle = async (id, tries = 3600) => {
    for (let i = 0; i < tries; i++) {
      const n = (await ws()).nodes[id];
      if (n && n.status !== "running" && (n.artifact || n.error)) return n;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`card ${id} never settled: ${JSON.stringify((await ws()).nodes[id])}`);
  };
  const press = async id => {
    const button = card(id).locator("[data-generate]");
    await button.waitFor({ state: "visible" });
    for (let i = 0; i < 200 && !(await button.isEnabled()); i++) await page.waitForTimeout(50);
    if (!(await button.isEnabled())) throw new Error(`the press on card ${id} never became usable`);
    const before = (await ws()).nodes[id];
    await button.click();
    for (let i = 0; i < 400; i++) {
      const n = (await ws()).nodes[id];
      if (n && (n.status === "running" || n.error || n.artifact !== before.artifact)) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`pressing on card ${id} started nothing`);
  };
  const link = async (from, to) => {
    const a = await card(from).locator("header").boundingBox(), b = await card(to).locator("header").boundingBox();
    await page.mouse.move(a.x + 40, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    assert.ok(((await ws()).nodes[to].inputs || []).includes(from), `dragging card ${from} onto ${to} recorded the input`);
  };

  // 1. BLANK CANVAS -> the walker's two pictures, through the + File control the person presses.
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#add-file").click()]);
  await chooser.setFiles([dawn, dusk]);
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 2, null, { timeout: 30000 });
  const graph = await ws();
  const pictureIds = Object.values(graph.nodes).filter(n => n.type === "image").map(n => n.id);
  assert.equal(pictureIds.length, 2, `two files became two picture cards: ${JSON.stringify(Object.values(graph.nodes).map(n => [n.id, n.type]))}`);
  note("the walker's two pictures are on the canvas", pictureIds.map(id => ({ id, artifact: graph.nodes[id].artifact })));

  // 2. THE WORDS: two acts, typed on one text card.
  await page.mouse.dblclick(80, 80); await page.waitForTimeout(300);
  const textCard = page.locator(".card").last();
  await textCard.locator("[data-prompt]").click();
  await textCard.locator("[data-prompt]").pressSequentially(STORY.join("\n"));
  await textCard.locator("[data-prompt]").blur();
  await page.waitForTimeout(300);
  const textId = Number(await textCard.getAttribute("data-id"));
  await press(textId);
  const words = await settle(textId);
  assert.equal(words.error, null, `the words: ${words.error}`);

  // 3. THE NARRATION, at a pace a person asked for on the card. No agent takes part: the server runs
  //    the renderer, and - because this machine has an engine - the renderer speaks with it.
  await page.mouse.dblclick(420, 80); await page.waitForTimeout(300);
  const voice = page.locator(".card").last();
  await voice.locator("[data-field=type]").selectOption("audio");
  await page.waitForFunction(() => document.querySelector(".card:last-child [data-field=method]")?.value === "readaloud", null, { timeout: 10000 });
  const voiceId = Number(await voice.getAttribute("data-id"));
  await link(textId, voiceId);
  await card(voiceId).locator(".repace input").fill("150");
  await card(voiceId).locator(".repace input").blur();
  await press(voiceId);
  const take = await settle(voiceId);
  assert.equal(take.error, null, `the narration: ${take.error}`);
  assert.ok(take.narration?.phrases?.length >= 4, `the take has a phrase time per line: ${JSON.stringify(take.narration?.phrases)}`);
  // THE ENGINE SPOKE, and the take says so. A card that claims an engine's voice while the built-in
  // one spoke would be the same class of lie as a timeline describing another take's audio.
  assert.equal(take.narration.voice?.engine, "espeak-ng", `the take records the engine that read it: ${JSON.stringify(take.narration.voice)}`);
  assert.ok(take.narration.voice.version, `and the engine's version, because a later one is a different voice: ${JSON.stringify(take.narration.voice)}`);
  note("the narration", {
    artifact: take.artifact,
    voice: take.narration.voice,
    phrases: take.narration.phrases.map(p => p.text),
    pace: take.narration.pace,
    seconds: take.narration.seconds,
    correlation: take.narration.take?.correlation,
  });
  // The card says which voice read it, on the line a person reads. `index.html` builds that line
  // from the take's own record, so this checks the sentence a person sees rather than the record
  // twice - a card that recorded the engine but said nothing about it is the defect it fixes.
  const cardLine = await card(voiceId).locator(".narration").innerText();
  assert.match(cardLine, /voice:\s*espeak-ng \(en-us\)/, `the card names the voice that read it, including the voice inside the engine: ${JSON.stringify(cardLine)}`);
  note("what the card says about the voice", cardLine);

  // 4. THE FILM: two acts, the pictures in the order the story is told, with the narration.
  await page.mouse.dblclick(760, 520); await page.waitForTimeout(300);
  const filmCard = page.locator(".card").last();
  await filmCard.locator("[data-field=type]").selectOption("video");
  await page.waitForFunction(() => document.querySelector(".card:last-child [data-field=method]")?.value === "firstcut", null, { timeout: 10000 });
  const filmId = Number(await filmCard.getAttribute("data-id"));
  for (const source of [voiceId, ...pictureIds]) await link(source, filmId);
  await press(filmId);
  const cut = await settle(filmId);
  assert.equal(cut.error, null, `the film: ${cut.error}`);
  assert.equal(cut.film.scenes.length, 2, `two pictures make two acts: ${JSON.stringify(cut.film.scenes)}`);
  note("the film card's own record", {
    artifact: cut.artifact,
    seconds: cut.film.seconds,
    scenes: cut.film.scenes.map(s => ({ start: s.start, end: s.end, from: s.from, caption: s.caption })),
    captions: cut.film.captions,
    soundtrack: cut.film.soundtrack,
  });

  // 5. THE FILM AS A VIEWER MEETS IT: decoded, played, and its own audio track transcribed.
  const file = join(workdir, String(filmId), cut.artifact);
  const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" }));
  const video = probe.streams.find(s => s.codec_type === "video"), audio = probe.streams.find(s => s.codec_type === "audio");
  assert.equal(video?.codec_name, "h264");
  assert.equal(audio?.codec_name, "aac");
  const extracted = join(base, "heard-from-film.wav");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "22050", extracted]);
  const heardTrack = wavSamples(readFileSync(extracted));
  const frozenNarration = join(workdir, String(filmId), cut.film.soundtrack.file);
  assert.ok(existsSync(frozenNarration), "the narration the film says it used is beside it");
  const wanted = wavSamples(readFileSync(frozenNarration)).samples;
  // The film's track against the take it names: a real video carrying the wrong voice passes every
  // cheaper check, so this is the one that decides the film plays *this* narration.
  let lag = 0, best = -2;
  for (let d = -2205; d <= 2205; d++) {
    const from = 22050 + d;
    if (from < 0 || from + 22050 > heardTrack.samples.length) continue;
    const score = correlation(heardTrack.samples.subarray(22050, 22050 + 22050), wanted.subarray(from, from + 22050));
    if (score > best) { best = score; lag = d; }
  }
  assert.ok(best >= 0.8, `the film's sound is the narration it says it used (${best.toFixed(3)})`);
  // And the product's own checks on the track a viewer hears, run here rather than trusted: the
  // acoustic judge on the decoded audio at the pace the film plays.
  const heardJudge = judge(extracted, STORY.join(" "));
  assert.deepEqual(heardJudge.problems, [], `the film's own track measures as speech: ${JSON.stringify(heardJudge)}`);
  note("the film's own track measures as speech", { verdict: heardJudge.verdict, seconds: Number(heardJudge.seconds.toFixed(2)), onsets: heardJudge.onsets, vowelKinds: heardJudge.vowelKinds, voicedShare: Number(heardJudge.voicedShare.toFixed(2)) });
  const played = await card(filmId).locator("video").evaluate(async v => {
    v.muted = true; v.currentTime = 0;
    await v.play().catch(() => {});
    await new Promise(r => setTimeout(r, 700));
    const at = v.currentTime; v.pause();
    return { at, duration: Number.isFinite(v.duration) ? v.duration : null, paused: v.paused };
  });
  assert.ok(played.at > 0.3, `the film plays in the canvas: ${JSON.stringify(played)}`);
  assert.ok(Number(probe.format.duration) >= cut.film.scenes.at(-1).end - 0.2, "the film runs to the end of its last act");

  // 6. THE DECISIVE MEASUREMENT: a real recognizer on the film's own track. This is the one thing
  //    the release did not have, and the reason the narration above is worth anything.
  const asrPython = process.env.ASR_PYTHON, asrModel = process.env.ASR_MODEL;
  let understanding = null;
  if (!asrPython || !asrModel) {
    console.log("no ASR_PYTHON/ASR_MODEL given: the film was measured, but not transcribed.");
    console.log("  this walk does NOT claim the narration is understood without them - set both to a");
    console.log("  faster-whisper venv python and a model directory to take the measurement.");
  } else {
    const py = `
import json, sys
from faster_whisper import WhisperModel
engine = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", cpu_threads=3, local_files_only=True)
segments, info = engine.transcribe(sys.argv[2], language="en", beam_size=5, condition_on_previous_text=False)
segments = list(segments)
print(json.dumps({"segments": len(segments), "heard": " ".join(s.text.strip() for s in segments)}))
`;
    const said = JSON.parse(execFileSync(asrPython, ["-c", py, asrModel, extracted], { encoding: "utf8", env: { ...process.env, HF_HOME: process.env.HF_HOME || join(asrModel, "..") } }));
    const at = readTranscript(STORY.join(" "), said.heard);
    const decided = verdict(at, { segments: said.segments });
    understanding = {
      recognizer: asrModel,
      model: "faster-whisper tiny.en, int8, cpu",
      transcript: said.heard,
      segments: said.segments,
      words: at.words,
      recovered: at.recovered,
      substitutions: at.substitutions,
      deletions: at.deletions,
      insertions: at.insertions,
      wer: at.wer,
      verdict: decided.kind,
      understood: decided.ok,
      message: decided.message,
    };
    note("a recognizer hears the film's own narration", understanding);
    assert.ok(decided.ok, `the published film's narration is understood from its own track: ${decided.message}`);
  }

  // 7. BOTH ACTS READ CLEARLY: each caption's rate on screen, and each act's own picture in frame.
  const captions = cut.film.captions;
  assert.ok(captions, "the film records what its captions measured");
  assert.ok(captions.worst <= captions.comfortable, `every caption is readable at the pace it is spoken: worst ${captions.worst} chars/s, comfortable ${captions.comfortable}`);
  note("the captions", captions);
  for (const [i, p] of (cut.film.placements || []).entries()) {
    assert.ok(p, `act ${i + 1} records the placement of its picture`);
    if (p.fit === "contain") assert.equal(p.kept, 1, `act ${i + 1} is shown whole, so nothing of it is lost`);
    else assert.ok(p.kept >= 0.96, `act ${i + 1} fills the frame, which may crop at most a sliver (kept ${p.kept})`);
  }
  const shots = [];
  for (const [i, scene] of cut.film.scenes.entries()) {
    const at = (Number(scene.start) + Number(scene.end)) / 2;
    const still = join(out, `act-${i + 1}.png`);
    execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", file, "-frames:v", "1", still]);
    shots.push(still);
  }
  // The scene frames against the pictures the walker supplied. The top two-thirds of the frame is
  // where the picture differs and where no caption covers it; measuring the whole frame compares
  // text with picture and squeezes the margin. Bars are the product's own (verifyFilm refuses below
  // 0.8 against the scene's own picture and decides by ranking with a margin).
  const grid = (args) => {
    const rgb = join(base, `g-${Math.random().toString(36).slice(2)}.rgb`);
    execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", ...args, "-vf", "crop=iw:ih*0.6667:0:0,scale=24:14:force_original_aspect_ratio=increase,crop=24:14", "-pix_fmt", "rgb24", "-c:v", "rawvideo", "-f", "image2", rgb]);
    return readFileSync(rgb);
  };
  const supplied = [dawn, dusk].map(f => grid(["-i", f]));
  const shown = shots.map(f => grid(["-i", f]));
  for (const [i, frame] of shown.entries()) {
    const scores = supplied.map(s => correlation(frame, s));
    const mine = scores[i], other = scores[1 - i];
    assert.ok(mine > 0.8, `act ${i + 1} shows the ${i ? "second" : "first"} picture the walker supplied (agreement ${mine.toFixed(3)})`);
    assert.ok(mine > other + 0.2, `and it is that picture rather than the other (own ${mine.toFixed(3)}, other ${other.toFixed(3)})`);
    note(`act ${i + 1} is the walker's ${i ? "second" : "first"} picture`, { own: Number(mine.toFixed(3)), other: Number(other.toFixed(3)) });
  }

  // 8. THE TAKE STILL RE-CHECKS. A published narration must reproduce from its own record on this
  //    machine; an engine take whose record does not say which engine is a take nobody can re-check.
  const publishedWav = join(workdir, String(voiceId), take.artifact);
  const timelineFile = publishedWav.replace(/\.wav$/i, ".timeline.json");
  if (existsSync(timelineFile)) {
    const bound = bindTake({ file: publishedWav, timeline: JSON.parse(readFileSync(timelineFile, "utf8")) });
    assert.ok(bound.ok, `the published take reproduces from its own record: ${bound.problems.join("; ")}`);
    assert.equal(bound.voice?.matched?.engine, "espeak-ng", `and reproduces as an engine take: ${JSON.stringify(bound.voice)}`);
    note("the published take reproduces from its own record", { correlation: bound.correlation, voice: bound.voice.matched });
  } else {
    note("the published take's timeline beside it", "not found at the expected name; the film's soundtrack copy was checked instead");
  }
  assert.equal(existsSync(called), false, "the whole film was made without running a model");
  note("page errors", errors);
  assert.deepEqual(errors, [], "the canvas raised no script error during the walk");
  receipt.films.push({
    artifact: cut.artifact,
    materials: "two pictures DRAWN by test/harbour.mjs (sky, sun or moon, water, headland, harbour lamps, a boat, a gull): one cold dawn and one evening. They are not photographs, so this establishes framing and legibility, not photographic composition.",
    seconds: Number(probe.format.duration).toFixed(2),
    streams: `${video?.codec_name}/${audio?.codec_name}`,
    size: `${video?.width}x${video?.height}`,
    voice: take.narration.voice,
    pace: take.narration.pace,
    captions,
    understanding,
    played,
  });
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 1));
  console.log(`receipt: ${join(out, "receipt.json")}`);
  console.log(`workspace: ${workdir}`);
  await browser.close();
  stopServer(app);
  stopAll();
}
process.exit(code);
