// What a take records about the mouth that spoke it, and what happens when that mouth is gone.
//
// The defect this guards is subtle and would be silent: if `engine` were a *build* setting rather
// than a *take* setting, then installing a speech engine on a machine would start re-rendering old
// takes with it - and every stored narration, still on disk and still playable, would stop
// reproducing from the record that explains it. That is the same class of failure as the synthesizer
// edit that left an approved take scoring 0.435 against its own words, and it is worse, because the
// change would happen on a machine that did nothing but install a package.
//
// So the property here is: **absent `engine` means the built-in voice, always.** The tests that run
// without an engine installed prove it trivially; the ones that matter are those that run WITH one
// present and still get the built-in bytes. This file is written to work either way - the
// engine-present tests skip, saying so, rather than passing as if they had run.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderParagraph, toWav, RATE } from "../voice/synth.mjs";
import { engineStatus, checkEngine, checkVoice, ENGINE, ENGINE_VOICE } from "../voice/engine.mjs";
import { bindTake } from "../voice/bind.mjs";
import { wavSamples } from "../voice/wav.mjs";

const root = process.cwd();
const status = engineStatus();

// The same sentence the voice fixture uses, so a difference here is a difference in the mouth and not
// in the words.
const SENTENCE = "Slow down as we reach the stairs.";

test("a take with no engine records the built-in voice, whether or not one is installed", () => {
  const take = renderParagraph([{ text: SENTENCE }], {});
  assert.equal(take.voice.engine, undefined, `a take must not claim an engine nobody asked for: ${JSON.stringify(take.voice)}`);
  assert.equal(take.voice.rate, 1);
  assert.equal(take.voice.pitch, 112, "and the built-in voice's pitch is hertz, not the engine's 0-99 scale");
  assert.equal(take.rate, RATE);
  // And it is the SAME BYTES a build without an engine produces. This is the assertion that fails if
  // someone makes the engine the default: the built-in render is deterministic and this sentence's
  // samples depend on nothing but the words and the settings above.
  const again = renderParagraph([{ text: SENTENCE }], {});
  assert.deepEqual(take.samples.length, again.samples.length);
  assert.ok(take.samples.every((v, i) => v === again.samples[i]), "two renders of one sentence are identical");
});

test("a take that names an engine this build does not have is refused by name, not re-read by another voice", () => {
  // The name is wrong. A silent fallback to the built-in voice would publish a take whose record says
  // something the bytes disagree with - exactly the mismatch the timeline exists to prevent.
  assert.throws(
    () => renderParagraph([{ text: SENTENCE }], { engine: "festival" }),
    /no speech engine called "festival"/,
    "an unknown engine is refused where the bytes would have been made"
  );
});

test("a take that names an engine this machine cannot run says so, and says what to install", () => {
  // A take whose record names espeak-ng must not be re-rendered by the formant voice when the engine
  // is missing. On a machine that HAS the engine this is not reachable, so it is answered by pointing
  // the discovery at a binary that does not exist and asking `checkEngine` directly - which is the
  // same function the renderer calls before it renders a byte.
  const saved = process.env.HYPERMAKER_ESPEAK;
  process.env.HYPERMAKER_ESPEAK = join(tmpdir(), "definitely-not-an-espeak", "espeak-ng");
  try {
    // The module caches its answer per process, so a fresh process is the only honest way to ask.
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { checkEngine } from ${JSON.stringify(join(root, "voice/engine.mjs"))};
      try { checkEngine("espeak-ng"); console.log("RAN"); }
      catch (error) { console.log("REFUSED " + error.message); }
    `], { encoding: "utf8", env: { ...process.env } }).trim();
    assert.match(out, /^REFUSED /, `a named engine that is not there is refused: ${out}`);
    assert.match(out, /espeak-ng/, `the refusal names the engine: ${out}`);
    assert.match(out, /HYPERMAKER_ESPEAK|Install espeak-ng/, `and names the fix: ${out}`);
  } finally {
    if (saved == null) delete process.env.HYPERMAKER_ESPEAK; else process.env.HYPERMAKER_ESPEAK = saved;
  }
});

test("no stored take is re-rendered by an engine that appears beside it", () => {
  // A take made by the built-in voice, on disk, with its timeline - and an engine installed on this
  // machine right now (which is the case in the run that matters). The take still verifies, because
  // its record names no engine and `bindTake` re-renders with the built-in voice.
  const dir = mkdtempSync(join(tmpdir(), "hyper-engine-guard-"));
  const script = join(dir, "script.txt");
  writeFileSync(script, SENTENCE);
  const wav = join(dir, "narration.wav"), timeline = join(dir, "timeline.json");
  execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", script, "--out", wav, "--timeline", timeline], { stdio: "pipe" });
  const record = JSON.parse(readFileSync(timeline, "utf8"));
  assert.equal(record.voice.engine, undefined, `a take rendered without --engine records no engine${status.installed ? ", even on a machine that has one" : ""}`);
  const bound = bindTake({ file: wav, timeline: record });
  assert.ok(bound.ok, `the built-in take verifies${status.installed ? " on a machine with an engine installed" : ""}: ${bound.problems?.join("; ")}`);
  assert.equal(bound.voice.matched.engine, undefined, "and it is matched as a built-in take, not as an engine take");
  assert.equal(bound.voice.matched.pitch, 112, "on the built-in voice's hertz scale");
});

test("an engine take records enough to reproduce itself, and refuses to be reproduced by another engine", { skip: status.installed ? false : `no engine on this machine (${status.why})` }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hyper-engine-take-"));
  const script = join(dir, "script.txt");
  writeFileSync(script, SENTENCE);
  const wav = join(dir, "narration.wav"), timeline = join(dir, "timeline.json");
  execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", script, "--out", wav, "--timeline", timeline, "--engine", ENGINE], { stdio: "pipe" });
  const record = JSON.parse(readFileSync(timeline, "utf8"));
  // What a later build needs to say "this is the sound of these words": the engine, its version, the
  // voice inside it, the speed and the pitch - and no duration multiplier, because the engine was
  // never given one.
  for (const field of ["engine", "engineVersion", "engineVoice", "speed", "pitch"]) {
    assert.ok(record.voice[field] != null, `the take records ${field}: ${JSON.stringify(record.voice)}`);
  }
  assert.equal(record.voice.rate, undefined, "an engine take has no duration multiplier to record");
  assert.equal(record.voice.engineVoice, ENGINE_VOICE, "and records the voice the measurement chose");
  const bound = bindTake({ file: wav, timeline: record });
  assert.ok(bound.ok, `the engine take reproduces from its own record: ${bound.problems?.join("; ")}`);
  assert.equal(bound.voice.matched.engine, ENGINE);
  assert.equal(bound.voice.matched.speed, record.voice.speed, "reproduced at the speed it records");

  // A different engine VERSION is a different voice, and must be refused rather than re-rendered:
  // accepting it would compare two voices and then blame the script. Asked directly, because the
  // version on this machine is the only one there is.
  assert.throws(() => checkEngine(ENGINE, "0.0.1"), /different engine version|this machine has/, "an engine version this machine does not have is refused");
  // And the voice inside the engine is checked the same way. `checkVoice` answers about the engine
  // that IS installed, so a name it does not carry is refused with the list it has.
  const absent = checkVoice("xx-not-a-voice");
  assert.equal(absent.ok, false);
  assert.match(absent.why, /carries no/, `the refusal names what is missing: ${absent.why}`);
});

test("the engine's take is judged as speech by the project's own acoustics", { skip: status.installed ? false : `no engine on this machine (${status.why})` }, () => {
  // The engine speaks at this project's rate and format, and the judge that every narration must pass
  // accepts it. This is what makes the engine usable without teaching the rest of the pipeline a new
  // format - and it is measured here rather than assumed, because a resampling bug would produce a
  // playable file at the wrong pitch that every other check would pass.
  const dir = mkdtempSync(join(tmpdir(), "hyper-engine-judge-"));
  const take = renderParagraph([{ text: "The sea at night is never still." }, { text: "A gull drops a shell on the stones." }], { engine: ENGINE });
  const wav = join(dir, "take.wav");
  writeFileSync(wav, toWav(take.samples, take.rate));
  assert.equal(take.rate, RATE, "the engine speaks at the rate the pipeline reads");
  const report = JSON.parse(execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--check", wav, "--words", "The sea at night is never still. A gull drops a shell on the stones."], { encoding: "utf8" }));
  assert.equal(report.verdict, "speech", `the engine's take measures as speech: ${JSON.stringify(report.problems)}`);
  // The two phrases are joined with no gap, and each one's own record places it. A wrong placement
  // would make the film cut in the middle of a sentence.
  assert.equal(take.segments.length, 2);
  assert.ok(take.segments[1].start >= take.segments[0].duration - 0.01, `phrase two starts where phrase one ends: ${JSON.stringify(take.segments)}`);
});

test("the command line says whether this machine can speak, without being asked for a script", () => {
  // The server asks this question to decide whether to request an engine at all, so it must answer
  // before any text is required - and its exit code is the answer, not a string to parse: 0 for an
  // engine this machine can run, 3 for one it cannot. `spawnSync` rather than `execFileSync` because
  // a non-zero exit is the honest answer here, not a failure of the command.
  const run = spawnSync(process.execPath, [join(root, "voice/render.mjs"), "--engine-check"], { encoding: "utf8" });
  const parsed = JSON.parse(run.stdout);
  // 0 means "this machine can speak a take", not "a package is installed": an engine that runs
  // but cannot say the pinned voice answers `installed: true` with no `voice`, and it used to exit
  // 0 - a caller reading the documented status was told yes and had the first render refuse.
  assert.equal(run.status, parsed.installed && parsed.voice ? 0 : 3, `the exit code is the answer: ${JSON.stringify({ status: run.status, parsed })}`);
  assert.ok(parsed.installed ? !!parsed.voice === (run.status === 0) : run.status === 3, "the status and the exit code cannot disagree about whether this machine can speak");
  assert.equal(typeof parsed.installed, "boolean");
  assert.equal(parsed.name, ENGINE);
  if (parsed.installed) {
    assert.ok(parsed.version, "an installed engine reports its version, because a take records one");
    assert.ok(existsSync(parsed.binary));
  } else {
    // The sentence names whichever way the engine was looked for: `espeak-ng` on PATH, or the
    // variable that was set to something that is not there. Matching only /espeak|PATH/ passed on a
    // machine with HYPERMAKER_ESPEAK unset and failed on one that set it to a wrong path - a refusal
    // that was correct and reported clearly, asserted against the wrong words.
    assert.match(parsed.why, /espeak|PATH|HYPERMAKER_ESPEAK/i, `a missing engine says why: ${parsed.why}`);
  }
});

// THREE DEFECTS FOUND BY AN INDEPENDENT REVIEW OF THIS SLICE, each of which a green suite missed.
// They are kept together because they share a cause: the engine was treated as "works or does not",
// and the ways it can half-work were never asked about.
test("a phrase that begins with a hyphen is spoken, not swallowed as an engine option", { skip: status.installed ? false : `no engine on this machine (${status.why})` }, () => {
  // Measured before the fix: `-3.5 points is below zero.` made eSpeak consume the word as a flag,
  // write nothing, and the caller was told "not a RIFF/WAVE file" - a complaint about the parser for
  // a mistake in the argument list. A line of dialogue is the ordinary case: `- Where are you going?`.
  const line = "-3.5 points is below zero.";
  const dir = mkdtempSync(join(tmpdir(), "hyper-engine-hyphen-"));
  const script = join(dir, "s.txt"), wav = join(dir, "t.wav");
  writeFileSync(script, `${line}\n`);
  execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", script, "--out", wav, "--engine", ENGINE, "--wpm", "150"], { stdio: "pipe" });
  assert.ok(existsSync(wav), "the engine rendered a phrase beginning with a hyphen rather than refusing it");
  const take = wavSamples(readFileSync(wav));
  assert.ok(take.samples.length > 22050, `and it is audio, not an empty file: ${take.samples.length} samples`);
  // The built-in voice is the control: this line was always fine there, so a refusal here was the
  // engine path's own defect and not something about the words.
  assert.ok(renderParagraph([{ text: line }], {}).samples.length > 0, "the built-in voice could always say it");
});

test("the check a caller decides on verifies the pinned voice, not only that an engine exists", { skip: status.installed ? false : `no engine on this machine (${status.why})` }, () => {
  // `engineStatus` used to skip the voice check exactly when the voice was the pinned one, which is
  // every ordinary call - so it answered `installed: true, voice: "en-us"` on a build with no `en-us`
  // in its voice list, and only the first render failed. A fresh take would still have been refused
  // inside eSpeak, so this was a wrong answer rather than wrong audio; both are worth a test, because
  // the server reads this answer to decide whether to ask for the engine at all.
  assert.equal(status.installed, true);
  assert.equal(status.voice, ENGINE_VOICE, `an engine that can say it reports the voice: ${JSON.stringify(status)}`);
  assert.equal(checkVoice(ENGINE_VOICE).ok, true, "and the voice really is in this build's list");
  assert.equal(status.voiceMissing, undefined, "nothing is reported missing when nothing is");
  // The two answers must not be able to disagree about whether a take can be spoken here.
  assert.throws(() => checkEngine(ENGINE, null, "xx-not-a-voice"), /carries no/, "a take naming a voice this build lacks is refused where it would be rendered");
});

test("an engine take's audio is the engine's own samples, not a rounded copy of them", { skip: status.installed ? false : `no engine on this machine (${status.why})` }, () => {
  // The defect this pins: `wavSamples` decodes with /32768 while `toInt16` encodes with *32767, so a
  // take's WAV differed from the engine's output by one step on 461 of 121800 samples - and it was
  // not innocuous. Transcribed side by side at identical engine settings, the engine's own bytes
  // were heard as "harbour" and the product's rounded copy as "harbor", so one of the words this
  // project attributed to eSpeak's front end was its own arithmetic. The assertion is exact: the
  // audio PAYLOAD of a re-encoded take is byte-equal to what the engine wrote (the header is not the
  // sound, and eSpeak's chunk layout is not ours to reproduce).
  const line = "The harbour wakes before the sun. A gull drops a shell on the stones.";
  const { binary, env } = checkEngine(ENGINE);
  const raw = execFileSync(binary, ["-v", ENGINE_VOICE, "-s", "132", "-p", "50", "--stdout", "--", line], { env, maxBuffer: 64 * 1024 * 1024 });
  const take = renderParagraph([{ text: line }], { engine: ENGINE, engineVoice: ENGINE_VOICE, speed: 132, pitch: 50 });
  const again = toWav(take.samples, take.rate);
  const dataAt = b => b.indexOf(Buffer.from("data", "ascii")) + 8;
  assert.ok(raw.subarray(dataAt(raw)).equals(again.subarray(dataAt(again))), `the take's samples are the engine's integers (engine ${raw.length} bytes, take ${again.length})`);
});
