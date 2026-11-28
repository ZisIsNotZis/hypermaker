// What the transcription check SAYS about a reading, tested by running the check.
//
// The first version of this test re-implemented the alignment in the test file and asserted against
// that copy. An operator replaced the tool's verdict with the known-wrong rule ("total edits equal to
// word count means nothing was heard") and the test still passed, because the test was checking
// itself. So these run `voice/asr-check.mjs` as a program, with `--stub` supplying the transcript a
// recognizer might have produced, and assert on its OUTPUT and EXIT CODE. The wrong rule now fails
// here.
//
// The cases are the operator's, including both orders of the failure: extra words with every script
// word in place, and no script word at all.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTranscript, verdict } from "../voice/transcript.mjs";

const root = process.cwd();
const base = mkdtempSync(join(tmpdir(), "hypermaker-asr-reading-"));

// Run the tool with a fixed transcript. It prints its reading and exits non-zero when the voice
// would not be understood.
function check(script, { text, segments = 1 }) {
  const file = join(base, `script-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(file, script);
  const run = spawnSync(process.execPath, [join(root, "voice/asr-check.mjs"), "--stub", JSON.stringify({ text, segments }), "--script", file], { encoding: "utf8" });
  return { status: run.status, out: run.stdout + run.stderr };
}

test("extra words are reported as extra, not as nothing heard", () => {
  // The operator's two cases, through the tool.
  const two = check("Hello world.", { text: "Hello there world again." });
  assert.match(two.out, /2 of 2 words recovered/, `both script words are recovered: ${two.out}`);
  assert.match(two.out, /2 extra/, "and the two extras are named as extras");
  assert.doesNotMatch(two.out, /not one word/, "an insertion is not a miss");

  const three = check("Hello small world.", { text: "Hello very small world." });
  assert.match(three.out, /3 of 3 words recovered/);
  assert.match(three.out, /1 extra/);
  assert.doesNotMatch(three.out, /not one word|only 3 of 3/);
});

test("a recognizer that invents speech has recovered nothing, and says so", () => {
  const invented = check("The harbour wakes before the sun.", { text: "Oh, oh, yeah. Oh, oh, oh." });
  assert.match(invented.out, /0 of 6 words recovered/, invented.out);
  assert.match(invented.out, /not one word of the script was heard/);
  assert.equal(invented.status, 2, "the tool exits non-zero for the worst failure");
});

test("a high rate with every word recovered is called a noisy reading, not lost speech", () => {
  // This is the sentence the operator caught as nonsense: at 25%+ WER with 3 of 3 words in place,
  // the old tool said "only 3 of 3". The kind matters, because one means the voice failed and the
  // other means the recognizer did.
  const noisy = check("one two three", { text: "one extra two three and more" });
  assert.match(noisy.out, /every script word was recovered/i, noisy.out);
  assert.match(noisy.out, /noisy reading/i);
  assert.doesNotMatch(noisy.out, /only 3 of 3/, "no self-contradicting sentence");
});

// The reading module itself, so the numbers are pinned as well as the sentences.
test("the reading separates substitutions, insertions and deletions", () => {
  assert.deepEqual(readTranscript("Hello world.", "Hello there world again."),
    { words: 2, edits: 2, substitutions: 0, insertions: 2, deletions: 0, recovered: 2, wer: 1 });
  assert.deepEqual(readTranscript("Hello small world.", "Hello very small world."),
    { words: 3, edits: 1, substitutions: 0, insertions: 1, deletions: 0, recovered: 3, wer: 0.333 });
  // A word dropped is a deletion and IS a loss; a word replaced is a substitution and is too.
  assert.equal(readTranscript("one two three", "one three").deletions, 1);
  assert.equal(readTranscript("one two three", "one three").recovered, 2);
  assert.equal(readTranscript("one two three", "one too three").substitutions, 1);
  // And the verdict kinds are distinct, which is what a reader acts on.
  assert.equal(verdict(readTranscript("one two three", "")).kind, "no-words");
  // One word wrong of three is WER 0.33, above the 0.25 bar, and one word WAS lost - so the honest
  // kind is lost-words, not understood. A reading is understood when nearly all of it came back.
  assert.equal(verdict(readTranscript("one two three", "one x three")).kind, "lost-words");
  assert.equal(verdict(readTranscript("one two three four five six seven eight", "one two three four five six seven eight")).kind, "understood");
  assert.equal(verdict(readTranscript("one two three", "a b c d e f")).kind, "no-words");
  assert.equal(verdict(readTranscript("one two three", "one extra two three")).kind, "noisy-reading");
  // The bar is 0.25 regardless of the reference: the reference only says what is achievable.
  assert.equal(verdict(readTranscript("one x three four five six seven eight", "one y three four five six seven eight")).ok, true);
});
