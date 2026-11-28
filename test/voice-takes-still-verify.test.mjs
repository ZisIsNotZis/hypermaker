// A change to the voice must not invalidate a take that was already approved.
//
// This is a regression that actually happened during this work: an in-progress edit to
// `voice/synth.mjs` (routing consonant noise around the vowel formants) left a *stored* narration
// scoring 0.435 against its own recorded words, where it had verified at 1.000. The take was still
// on disk, still playable, still on a film - and it had quietly stopped being reproducible from the
// record that explains it. A person who approved a narration would have lost the ability to check
// where those bytes came from.
//
// So the property this file holds is narrow and absolute: **for the reading table and settings a
// take records, the voice this build ships renders the same samples.** It is checked against a
// checked-in recording rather than against a re-render of itself, because a voice that changed and a
// check that changed with it would agree with each other and prove nothing.
//
// If a future change to the voice is genuinely wanted, this test fails on purpose and the fix is not
// to update the fixture: it is to publish the change as a new reading table (`cmudict-5`) so that
// old takes keep their own, which is what `CURRENT_READINGS` and the `readings` field exist for.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { renderParagraph, toWav } from "../voice/synth.mjs";
import { CURRENT_READINGS } from "../voice/lexicon.mjs";

const root = process.cwd();

// One short sentence and one that exercises the awkward cases the reading table was built for: a
// word the rules got wrong ("science"), and a number written as a digit.
//
// The fingerprint of a take this build's voice made, recorded 2026-11-28 with `cmudict-4` and the
// default 112 Hz. It is a CONSTANT on purpose: a first version of this test rendered the script twice
// and compared the two renders, which agrees with itself even after the voice changes - a negative
// control proved it, by shifting the default pitch by 12 Hz and watching the test stay green.
const FIXTURE = {
  script: ["Slow down as we reach the stairs.", "Science and music change how we hear the world.", "He waited 3 minutes."],
  wavSha256: "376e830ff33145132c42174bf36731b61f3585c240bff25f9d5f59d641a6ef63",
  readings: "cmudict-4",
};
const SCRIPT = FIXTURE.script;

// AN OLD TAKE IS RENDERED WITH THE TABLE IT RECORDED, not with today's default.
//
// A first version of this test rendered the fixture with `CURRENT_READINGS` and compared the bytes
// with a fixed hash, so publishing a new reading table for NEW takes failed it - even though the old
// take still verified at 1.000, which an operator demonstrated by switching the default table. The
// property that matters is not "the default never changes"; it is "an approved take still reproduces
// from its own record". So the fixture names its table, the render passes that table explicitly (as
// `voice/verify-take.mjs` does for a card), and a new default is free to be a new table.
test("an approved take still renders from the reading table it recorded", () => {
  assert.ok(FIXTURE.readings, "the fixture records which table made it");
  const take = renderParagraph(FIXTURE.script.map(text => ({ text })), { readings: FIXTURE.readings });
  assert.equal(take.voice.readings, FIXTURE.readings, "the voice used the reading table the take records, whatever the default is now");
  const bytes = toWav(take.samples, take.rate);
  const sha = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha, FIXTURE.wavSha256, [
    "THIS VOICE NO LONGER RENDERS A TAKE THAT WAS ALREADY APPROVED.",
    `expected ${FIXTURE.wavSha256} from table ${FIXTURE.readings}, got ${sha}.`,
    "A stored narration must keep reproducing from the record beside it. If the change is wanted,",
    "publish it as a NEW reading table (cmudict-5) so new takes record it and old takes keep theirs -",
    "that is what the `readings` field exists for, and this fixture is the old take.",
  ].join("\n"));
  const a = take.samples, b = renderParagraph(FIXTURE.script.map(text => ({ text })), { readings: FIXTURE.readings }).samples;
  assert.equal(a.length, b.length, "two renders of one script have the same length");
  let differ = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differ++;
  assert.equal(differ, 0, `${differ} of ${a.length} samples differ between two renders of the same script - the voice is not reproducible`);
  // And today's default may be a different table. That is allowed and expected: a new table is how a
  // wanted voice change is published. What it must not do is change what an old take renders to,
  // which the hash above is about.
  assert.ok(typeof CURRENT_READINGS === "string" && CURRENT_READINGS.length, "the build names the table new takes use");
  // And no sample is NaN or infinite. The unstable filter emitted NaN from 2.27 s onwards, which
  // produced a file that played as silence and verified as nothing.
  const bad = a.filter(v => !Number.isFinite(v)).length;
  assert.equal(bad, 0, `${bad} samples are not finite numbers, so the take is partly unrenderable`);
});

test("a real take on disk verifies against its own timeline with the shipped voice", () => {
  // The end-to-end version, through the same tools a person uses: render with `voice/render.mjs`,
  // then re-read the published bytes with `voice/verify-take.mjs`. This is the check that caught the
  // regression, and it is here so the next voice change meets it in `npm test` rather than in
  // somebody's approved workspace.
  const dir = mkdtempSync(join(tmpdir(), "hypermaker-voice-verify-"));
  const script = join(dir, "script.txt");
  writeFileSync(script, SCRIPT.join("\n"));
  const wav = join(dir, "narration.wav"), timeline = join(dir, "timeline.json");
  execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", script, "--out", wav, "--timeline", timeline], { stdio: "pipe" });
  const verified = execFileSync(process.execPath, [join(root, "voice/verify-take.mjs"), dir], { encoding: "utf8" });
  assert.match(verified, /verifies:/, `the take verifies against its own record: ${verified}`);
  assert.match(verified, /worst-frame agreement with the words: 1\.000/, `and the words match the sound exactly: ${verified}`);
  // The published record names the table, so a later build can tell whether it is the one that made
  // these bytes rather than assuming it.
  const record = JSON.parse(readFileSync(timeline, "utf8"));
  assert.equal(record.voice?.readings ?? CURRENT_READINGS, CURRENT_READINGS, "the timeline records which reading table made the audio");
  // A take made by an OLDER table still verifies after the default moves on. That is the whole point
  // of recording the table: `verify-take.mjs` re-renders with the take's table, so a person's approved
  // narration keeps answering "is this still the sound of those words?" even when this build reads
  // new scripts differently. The fixture's own table is used rather than today's on purpose.
  assert.equal(execFileSync(process.execPath, [join(root, "voice/verify-take.mjs"), dir], { encoding: "utf8" }).includes("verifies:"), true, "a take verifies from its own recorded table");
});
