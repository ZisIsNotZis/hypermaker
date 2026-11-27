// Re-verifying a take a person already has, after the voice changed underneath them.
//
// The supervisor's finding, on a real workspace with two takes and the first one restored: the
// command verified **v2** while the canvas was showing **v1**, and naming v1's WAV outright
// reported "no timeline" while `v1-narration.timeline.json` sat beside it. Both are worse than
// having no command: one answers confidently about a recording the person is not looking at,
// and the other says an honest take records nothing. Each check below is one of those failures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { renderParagraph, toWav } from "../voice/synth.mjs";
import { serializeWorkspace } from "../server/workspace.mjs";

const root = process.cwd();
const base = mkdtempSync(join(tmpdir(), "hypermaker-verify-"));

// A card directory exactly as the server leaves one: takes under `versions/`, each with its own
// timeline named after it, and a workspace record beside the card saying which take is showing.
function card({ selected, takes }) {
  const workdir = mkdtempSync(join(base, "ws-"));
  const node = join(workdir, "1");
  mkdirSync(join(node, "versions"), { recursive: true });
  const versions = [];
  takes.forEach((text, i) => {
    const n = i + 1;
    const r = renderParagraph([{ text }]);
    writeFileSync(join(node, "versions", `v${n}-narration.wav`), toWav(r.samples, r.rate));
    writeFileSync(join(node, "versions", `v${n}-narration.timeline.json`), JSON.stringify({ phrases: r.segments.map(s => ({ text: s.text, start: s.start, duration: s.duration })), voice: r.voice }));
    versions.push({ id: n, file: `versions/v${n}-narration.wav`, sources: [] });
  });
  const record = { x: 0, y: 0, inputs: [], type: "audio", method: "narration", prompt: "", quality: "demo", artifact: selected, versions };
  writeFileSync(join(workdir, "workspace.yml"), serializeWorkspace({ 1: record }));
  return { workdir, node };
}

const run = nodeDir => {
  try { return { status: 0, out: execFileSync(process.execPath, [join(root, "voice/verify-take.mjs"), nodeDir], { encoding: "utf8" }) }; }
  catch (error) { return { status: error.status, out: `${error.stdout || ""}${error.stderr || ""}` }; }
};

const TAKE_A = "Science can change the way a machine works.";
const TAKE_B = "The sea at night is never still.";

test("a card is verified as the take the canvas is showing, not the newest file on disk", () => {
  // v1 is older and is the one restored on the canvas; v2 is newer and sits beside it. Sorting
  // filenames picks v2, which is the supervisor's case.
  const { node } = card({ selected: "versions/v1-narration.wav", takes: [TAKE_A, TAKE_B] });
  const result = run(node);
  assert.equal(result.status, 0, `the selected take did not verify: ${result.out}`);
  assert.match(result.out, /verifies: .*v1-narration\.wav/, `it checked the take on the card, got: ${result.out}`);
  assert.match(result.out, new RegExp(TAKE_A.replace(/\./g, "\\.")), "and reports that take's words, not the newer take's");
  assert.match(result.out, /this is the take the card is showing/, "and says which take it read, because on a two-version card that is the reader's first question");

  // The other selection works too, so this is not just "prefer v1".
  const { node: other } = card({ selected: "versions/v2-narration.wav", takes: [TAKE_A, TAKE_B] });
  const second = run(other);
  assert.match(second.out, /verifies: .*v2-narration\.wav/, `a card showing v2 verifies v2, got: ${second.out}`);
  assert.match(second.out, /The sea at night is never still/, "and reports v2's words");
});

test("a named WAV is checked against its own timeline, not against a name guessed from a run directory", () => {
  const { node } = card({ selected: "versions/v1-narration.wav", takes: [TAKE_A, TAKE_B] });
  // This is the second half of the supervisor's report: the record is right there, and the
  // command said there was none because it looked for `narration.timeline.json`.
  const explicit = run(join(node, "versions", "v1-narration.wav"));
  assert.equal(explicit.status, 0, `a named take did not find its own record: ${explicit.out}`);
  assert.match(explicit.out, /v1-narration\.wav/, "it read the file it was given");
  assert.match(explicit.out, /Science can change the way a machine works/, "and that file's own words");
  // Naming the other take checks the other take, whatever the card is showing.
  const other = run(join(node, "versions", "v2-narration.wav"));
  assert.match(other.out, /v2-narration\.wav/, "a named file is not overridden by the card's selection");
  assert.match(other.out, /The sea at night is never still/);
});

test("when the card's record cannot be read, the command says it guessed instead of implying it knew", () => {
  const { node } = card({ selected: "versions/v1-narration.wav", takes: [TAKE_A, TAKE_B] });
  // Remove the record: the files are still all there, so something can be checked - but the
  // command cannot know which take is on the canvas and must not pretend otherwise.
  writeFileSync(join(node, "..", "workspace.yml"), "");
  const result = run(node);
  assert.match(result.out, /NOT the take the card is showing/, `it must not present a guess as the selected take, got: ${result.out}`);
  assert.match(result.out, /could not be read|not on disk/, "and says why it could not tell");
});

test("a record that names no reading table is described by what the audio proves, and old audio is not called current", () => {
  // A timeline written before `voice.readings` existed. The table is *recovered* from the bytes,
  // so the report must state that rather than claim the record named it - and must not let a
  // person believe an older recording is the voice they have now.
  const dir = mkdtempSync(join(base, "old-record-"));
  const r = renderParagraph([{ text: TAKE_A }], { readings: "cmudict-1" });
  writeFileSync(join(dir, "narration.wav"), toWav(r.samples, r.rate));
  const timeline = { phrases: r.segments.map(s => ({ text: s.text, start: s.start, duration: s.duration })) };
  delete timeline.voice;
  writeFileSync(join(dir, "timeline.json"), JSON.stringify(timeline));
  const result = run(dir);
  assert.equal(result.status, 0, `an honest old take must verify: ${result.out}`);
  assert.match(result.out, /predates the field/, "it says the record predates the field rather than accusing it");
  assert.match(result.out, /cmudict-1/, "it names the table the audio really was made with");
  assert.match(result.out, /older recording/, "and warns that regenerating would not sound the same");
  // The honest limit: it does not claim the record *said* cmudict-1.
  assert.doesNotMatch(result.out, /timeline says cmudict-1/);
});
