import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { browserPath } from "./browser.mjs";
import { verifyFilm } from "../server/film.mjs";
import { firstCut } from "../server/offline.mjs";
import { wavSamples } from "../voice/wav.mjs";

// Every part of a narration must be heard, and an ordinary pause must not be mistaken for a hole.
//
// Two defects are pinned here, both found by walking the real entry rather than by reading the code,
// and both about the same question: is the film carrying *this* narration?
//
//   1. The check took a fixed 0.25 s window from the *middle* of the take. A two-line script whose
//      first sentence ends near halfway has a pause there, both signals are nearly zero, and every
//      lag scores noise - so a correct film was refused at the entry with "playing something else"
//      and 0.44. Where a pause falls is a property of the script, not of the audio being wrong.
//   2. Fixing that by probing only the *loud* windows opened a worse hole, which a supervisor found
//      with one of the accepted films: keep the first 3.23 s of a 5.57 s narration and replace the
//      rest with silence, and the film still passed with 0.999. Every window the check looked at
//      happened to be one of the kept ones. A check that samples the parts most likely to be right
//      cannot fail.
//
// So the controls below are one good film and five changes to it, each made from the same real
// render. The good one must pass *and* report the worst window, not the best; each bad one must be
// refused, and the refusal has to name where the sound stops being the narration, because that is
// the only part a person can act on.
const root = process.cwd();
const chrome = browserPath();
const skip = existsSync(chrome) ? null : `no browser for Remotion (set HYPERMAKER_CHROME); looked at ${chrome}`;
const ff = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");

test("the film check hears every part of the narration, and still lets a pause between lines pass", async t => {
  if (skip) return t.skip(skip);
  const dir = mkdtempSync(join(tmpdir(), "hypermaker-alignment-"));
  const script = join(dir, "script.txt"), narration = join(dir, "narration.wav");
  // Three lines of ordinary prose, long enough that the take has pauses inside it and that a 0.6 s
  // hole lands in the middle of speech rather than in a gap.
  writeFileSync(script, "The harbour lights come on one by one across the water.\nA gull complains about the weather and then gives up.\nThe last boat turns for home before the rain.");
  execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", script, "--out", narration, "--timeline", join(dir, "timeline.json"), "--wpm", "150"], { stdio: "pipe" });
  const raw = readFileSync(narration);
  const { rate, samples } = wavSamples(raw);
  const seconds = samples.length / rate;
  assert.ok(seconds > 6, `the take should be long enough to have an inside: ${seconds.toFixed(2)}s`);

  // The data chunk's body, found rather than assumed: this writer emits a 44-byte header today, and
  // a test that hard-codes the offset would silently edit the wrong bytes the day it changes.
  let at = 12, dataAt = -1;
  while (at + 8 <= raw.length) {
    const id = raw.subarray(at, at + 4).toString("latin1"), size = raw.readUInt32LE(at + 4);
    if (id === "data") { dataAt = at + 8; break; }
    at += 8 + size + (size & 1);
  }
  assert.ok(dataAt > 0, "the narration has a data chunk");
  const header = raw.subarray(0, dataAt), pcm = raw.subarray(dataAt);
  // Each variant keeps the narration's length and header and changes only the samples, so the only
  // thing a refusal can be about is the sound.
  const variant = (name, edit) => {
    const body = Buffer.from(pcm);
    edit(body);
    const file = join(dir, name);
    writeFileSync(file, Buffer.concat([Buffer.from(header), body]));
    return file;
  };
  const zeroSpan = (body, fromSeconds, lengthSeconds) => {
    const from = Math.round(fromSeconds * rate) * 2, to = Math.min(body.length, Math.round((fromSeconds + lengthSeconds) * rate) * 2);
    for (let i = from; i < to; i++) body[i] = 0;
  };

  const made = await firstCut({ attemptDir: dir, sources: [{ id: 1, type: "audio", artifact: "narration.wav", frozen: narration }], cancelRef: {} });
  const remux = (name, audio) => {
    const file = join(dir, name);
    execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", made.artifact, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", file]);
    return file;
  };

  // The good film. `correlation` must be the *worst* speaking window, so a take with one bad moment
  // cannot report a perfect score; and the number of windows compared must cover the whole take,
  // not a sample of it.
  const good = verifyFilm({ file: made.artifact, soundtrackFile: narration, projectRoot: root });
  assert.equal(good.ok, true, `a correctly narrated film must pass: ${good.problems.join("; ")}`);
  assert.ok(good.evidence.correlation > 0.95, `and say how well it agreed, got ${good.evidence.correlation}`);
  assert.ok(good.evidence.windows >= 4 * Math.floor(seconds), `every tenth of a second is measured, got ${good.evidence.windows} windows for ${seconds.toFixed(1)}s`);
  assert.ok(good.evidence.spokenWindows < good.evidence.windows, "and the pauses between the lines are not counted as speech that must match");

  // 1. The supervisor's case: keep the first 3.23 s, silence the rest. Everything after the cut is a
  //    hole where the narration speaks, and it must be refused and located.
  const tailSilent = verifyFilm({ file: remux("tail.mp4", variant("tail.wav", body => zeroSpan(body, 3.23, seconds))), soundtrackFile: narration, projectRoot: root });
  assert.equal(tailSilent.ok, false, "a film that stops speaking at 3.23 s must be refused");
  assert.match(tailSilent.problems.join(" "), /plays nothing where its narration is speaking/, `the refusal should say the take is missing part of itself: ${tailSilent.problems.join("; ")}`);
  assert.match(tailSilent.problems.join(" "), /from 3\.\d\ds/, `and where it stops: ${tailSilent.problems.join("; ")}`);
  assert.equal(tailSilent.problems.length, 1, `one defect should read as one sentence, got ${tailSilent.problems.length}: ${tailSilent.problems.join("; ")}`);
  assert.doesNotMatch(tailSilent.problems.join(" "), /playing something else/, "a silence must not also be reported as the wrong voice");
  assert.ok(tailSilent.evidence.correlation < 0.5, `a refused film must not report a good score beside its refusal, got ${tailSilent.evidence.correlation}`);

  // 2. A hole in the middle of speech, with the sound before and after it intact. This is what a
  //    check that only looks at loud windows cannot see, and what the old whole-film average hid.
  const holeAt = seconds * 0.42;
  const hole = verifyFilm({ file: remux("hole.mp4", variant("hole.wav", body => zeroSpan(body, holeAt, 0.6))), soundtrackFile: narration, projectRoot: root });
  assert.equal(hole.ok, false, "a 0.6 s hole in the middle must be refused");
  assert.match(hole.problems.join(" "), /plays nothing where its narration is speaking/, `the hole should be named as a hole: ${hole.problems.join("; ")}`);
  const named = Number(/from ([\d.]+)s/.exec(hole.problems.join(" "))?.[1]);
  assert.ok(Math.abs(named - holeAt) <= 0.3, `the refusal should point at the hole (about ${holeAt.toFixed(1)}s), got ${named}`);

  // 3. Another take's voice, at its own length: not this narration at all.
  const other = join(dir, "other.wav");
  execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--text", "Nothing about this recording is the narration that was asked for.", "--out", other, "--timeline", join(dir, "other.json")], { stdio: "pipe" });
  const stranger = verifyFilm({ file: remux("other.mp4", other), soundtrackFile: narration, projectRoot: root });
  assert.equal(stranger.ok, false, "another take's voice must be refused");
  assert.match(stranger.problems.join(" "), /not (the narration|this take)|different and much shorter recording/, `the refusal should say the sound is not this take's: ${stranger.problems.join("; ")}`);

  // 4. The picture stops before the narration does.
  const short = join(dir, "short.mp4");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", made.artifact, "-t", "1.5", "-c:v", "copy", "-c:a", "aac", short]);
  const cut = verifyFilm({ file: short, soundtrackFile: narration, projectRoot: root });
  assert.equal(cut.ok, false, "a truncated film must be refused");
  assert.match(cut.problems.join(" "), /cut off/, `the refusal should say the end is cut off: ${cut.problems.join("; ")}`);

  // 5. Every sample zero: the failure that started this check.
  const mute = verifyFilm({ file: remux("mute.mp4", variant("mute.wav", body => body.fill(0))), soundtrackFile: narration, projectRoot: root });
  assert.equal(mute.ok, false, "a silent film must be refused");
  assert.match(mute.problems.join(" "), /every sample is zero|plays in silence/, `the refusal should name the silence: ${mute.problems.join("; ")}`);

  // Checking a 12 s film costs a fraction of a second, so a person never waits on it and a build
  // that made it expensive would be noticed here rather than by a creator.
  const started = process.hrtime.bigint();
  verifyFilm({ file: made.artifact, soundtrackFile: narration, projectRoot: root });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 5000, `the whole-narration check must stay cheap, took ${ms.toFixed(0)}ms`);
});
