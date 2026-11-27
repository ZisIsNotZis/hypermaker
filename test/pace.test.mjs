import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RATE, renderParagraph, paceOf, rateForWpm } from "../voice/synth.mjs";
import { bindTake } from "../voice/bind.mjs";
import { wavSamples } from "../voice/wav.mjs";

// Controlling the pace of a narration.
//
// A person asked whether they could control the pace of a film's voice, and the answer used
// to be "only by passing a setting whose name says the opposite of what it does". Measured
// before this: the same 9-word line took 2.9 s at `--rate 0.8`, 3.6 s at `--rate 1`, and
// 4.7 s at `--rate 1.3`, while the code comment and the tool's own usage text both called
// 1.3 the brisk one. That is not a taste problem; a writer following the documentation
// produced the wrong take, and nothing in the pipeline caught it because every pace in the
// allowed range measures as speech.
//
// So the setting a person asks for is words per minute - a number with a meaning outside
// this program - and these tests hold three things down:
//   1. the pace asked for is the pace the bytes have, measured from the samples;
//   2. both numbers are recorded, so a card can say "you asked for 150, this reads at 148";
//   3. the old multiplier still means what it always meant, so every published take keeps
//      reproducing from its own record.
//
// The measurements come from the WAV, not from the record, because the record is what is
// being checked. A tool that printed the pace it was asked for and rendered something else
// would pass any check that read the timeline back.
const root = process.cwd();
const script = "The tide comes in at six. The boat waits. Nobody on the pier counts the waves.";
const words = script.split(/\s+/).filter(Boolean).length;
const dir = mkdtempSync(join(tmpdir(), "hypermaker-pace-"));

function render(name, args) {
  const out = join(dir, `${name}.wav`), timeline = join(dir, `${name}.json`);
  execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", join(dir, `${name}.txt`), "--out", out, "--timeline", timeline, ...args], { stdio: "pipe" });
  const { samples } = wavSamples(out);
  const record = JSON.parse(readFileSync(timeline, "utf8"));
  return { out, record, seconds: samples.length / RATE, wpm: words / (samples.length / RATE) * 60 };
}
for (const name of ["a", "b", "c"]) {
  const file = join(dir, `${name}.txt`);
  if (!existsSync(file)) execFileSync(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(script)})`]);
}

test("a narration can be asked for at a pace, and the bytes are at that pace", () => {
  const slow = render("a", ["--wpm", "110"]);
  const plain = render("b", ["--wpm", "150"]);
  const brisk = render("c", ["--wpm", "200"]);

  // The three takes are genuinely different lengths, in the direction asked for.
  assert.ok(slow.seconds > plain.seconds && plain.seconds > brisk.seconds,
    `110/150/200 wpm produced ${slow.seconds.toFixed(2)}/${plain.seconds.toFixed(2)}/${brisk.seconds.toFixed(2)} s, which is not slow > plain > brisk`);

  // And each lands within 2% of the request, measured from the published samples rather
  // than from the number the tool wrote down.
  for (const [take, asked] of [[slow, 110], [plain, 150], [brisk, 200]]) {
    assert.ok(Math.abs(take.wpm - asked) / asked < 0.02,
      `asked for ${asked} wpm and the audio measures ${take.wpm.toFixed(1)} wpm (${take.seconds.toFixed(2)} s for ${words} words)`);
    // Both numbers travel with the take: what the writer asked for, and what it reached.
    assert.equal(take.record.pace.askedWpm, asked, "the record keeps the pace that was asked for");
    assert.ok(Math.abs(take.record.pace.wpm - take.wpm) < 1.5,
      `the record says ${take.record.pace.wpm} wpm and the bytes measure ${take.wpm.toFixed(1)}`);
    assert.equal(take.record.pace.words, words, "the record counts the words it spoke");
  }
  // The direction is not merely monotonic but is what the name says: a higher wpm is faster.
  assert.ok(brisk.wpm > slow.wpm * 1.5, "200 wpm is not appreciably faster than 110 wpm");
});

test("the pace setting is met by measuring the render, and the multiplier it writes is the one that made the bytes", () => {
  // The bridge between the two names. `rateForWpm` is derived from a real render because the
  // share of a take that is speech versus gap depends on the script; a fixed constant would
  // land near the target for one script and miss for another.
  const at = renderParagraph([{ text: script }], { rate: 1 });
  const pace = paceOf(at.segments);
  assert.equal(pace.words, words);
  const rate = rateForWpm(at.segments, 200);
  const rendered = renderParagraph([{ text: script }], { rate });
  const got = paceOf(rendered.segments);
  assert.ok(Math.abs(got.wpm - 200) / 200 < 0.02, `rateForWpm(200) rendered ${got.wpm.toFixed(1)} wpm`);

  // A take written with `--wpm` records the multiplier its samples were made with, so a
  // published narration still verifies against its own script - the same check the server
  // refuses a bad take with. If the record had stored the words per minute instead of the
  // multiplier, every take made this way would fail its own verification, which is the one
  // failure mode this project treats as unacceptable.
  const take = render("a", ["--wpm", "110"]);
  assert.ok(take.record.voice.rate > 1, `110 wpm is slower than this voice's default pace, so its duration multiplier must be above 1; recorded ${take.record.voice.rate}`);
  const check = bindTake({ file: take.out, timeline: take.record });
  assert.equal(check.ok, true, `a take made with --wpm does not verify against its own record: ${(check.problems || []).join("; ")}`);
  assert.ok(check.correlation >= 0.99, `the re-render agrees at ${check.correlation}`);
});

test("the old multiplier keeps its own meaning, and the refusal names the limit", () => {
  // Published takes record this number. Flipping its meaning to match its name would have
  // made every one of them re-render to different audio and fail its own verification, so it
  // is the *documentation* that was wrong, not the arithmetic. Measured here so the decision
  // cannot silently drift back.
  const fast = renderParagraph([{ text: script }], { rate: 0.8 });
  const slow = renderParagraph([{ text: script }], { rate: 1.3 });
  assert.ok(fast.samples.length < slow.samples.length,
    "rate 0.8 must still be faster than 1.3, or every published take stops reproducing");

  // And the size of the change, because the documents state percentages and a reviewer caught
  // them stated as reciprocals: 0.8 is 20% less *time*, which is 25% more words per minute,
  // and 1.3 is 30% more time, which is 23% fewer. Both sides are asserted so a doc sentence
  // quoting one as the other has something to disagree with.
  const base = renderParagraph([{ text: script }], { rate: 1 });
  const timeRatio = slow.samples.length / base.samples.length;
  assert.ok(Math.abs(timeRatio - 1.3) < 0.01, `rate 1.3 made the take ${(timeRatio * 100).toFixed(1)}% of its length, not 130%`);
  // The pace the slower take speaks at, as a fraction of the base pace: 1/1.3, i.e. 23% fewer
  // words per minute. Written this way round on purpose - `base/slow` is 1.3 and would read as
  // "1.3 times the pace" for a take that is slower.
  const paceKept = paceOf(slow.segments).wpm / paceOf(base.segments).wpm;
  assert.ok(Math.abs(paceKept - 1 / 1.3) < 0.01, `rate 1.3 kept ${paceKept.toFixed(3)} of the pace, not 1/1.3`);
  const fastRatio = base.samples.length / fast.samples.length;
  assert.ok(Math.abs(fastRatio - 1 / 0.8) < 0.01, `rate 0.8 raised the pace by ${((fastRatio - 1) * 100).toFixed(1)}%, not 25%`);

  // A pace the voice cannot reach is refused with the limit and the pace it can manage,
  // rather than silently clamped to something nobody asked for.
  const impossible = join(dir, "impossible.wav");
  let failed = null;
  try {
    execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", join(dir, "a.txt"), "--out", impossible, "--wpm", "600"], { stdio: "pipe", encoding: "utf8" });
  } catch (error) { failed = String(error.stderr || ""); }
  assert.ok(failed, "600 words per minute was accepted");
  assert.match(failed, /outside what this voice can do/, `the refusal does not say the pace is out of range: ${failed}`);
  assert.match(failed, /words per minute/i, "the refusal does not name the pace it read this script at");
  assert.equal(existsSync(impossible), false, "a refused pace still wrote a file");
});
