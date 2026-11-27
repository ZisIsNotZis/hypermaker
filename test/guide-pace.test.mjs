import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemblePrompt } from "../server/index.mjs";
import { methodFor } from "../server/registry.mjs";

// Whether an agent *obeys* the pace instruction is a question about a model, and this repo
// cannot answer it without one. What it can answer, and what this pins, is that the
// instruction is actually in the text the agent is given: a guide that says the right thing
// in a file nothing reads is worse than one that is silent, because it reads as covered.
//
// The failure this is written against is concrete. `--rate` is a duration multiplier and its
// own comment called 1.3 the brisk setting when 1.3 is in fact 30% slower; a writer following
// the documentation produced the wrong take, and every pace in the allowed range measures as
// speech, so no check downstream noticed. The correction is only worth anything if it reaches
// the prompt.

const root = process.cwd();

// The prompt as the narration method would receive it, assembled by the server's own code.
function promptFor(prompt) {
  const node = { id: 7, type: "audio", method: "narration", quality: "standard", inputs: [], prompt };
  return assemblePrompt({ node, workspace: { workdir: join(root, ".tmp", "guide-pace"), nodes: {} } });
}

test("the prompt for a narration card tells the agent how to set the pace, and which setting not to use", () => {
  const prompt = promptFor("Read this at a brisk pace.");
  const method = methodFor("audio", "narration");
  assert.ok(method, "the narration method is in the registry");
  assert.ok(prompt.includes(method.guide), "the method guide is in the assembled prompt");

  // The setting to use, with numbers that mean something outside this program.
  assert.match(prompt, /--wpm N/, "the guide names the setting a writer should pass");
  assert.match(prompt, /150 is ordinary/, "the guide says what an ordinary pace is");
  assert.match(prompt, /200 is brisk/, "the guide says what a brisk pace is");
  assert.match(prompt, /110 is deliberate/, "the guide says what a slow pace is");

  // The setting to avoid for pace, and the true direction of it.
  assert.match(prompt, /Do NOT pass `--rate` to change pace/, "the guide warns off the multiplier");
  assert.match(prompt, /a larger number speaks slower/, "the guide states the multiplier's real direction");

  // How a line becomes a phrase, because "add a blank line for a pause" reads as obvious and
  // is wrong: blank lines are skipped and a pause comes only from ending a line.
  assert.match(prompt, /A sentence is a line/, "the guide says how a line becomes a phrase");
  assert.match(prompt, /blank line does not make a longer pause/, "the guide refuses the plausible wrong move");

  // And it stays in the section the agent is asked to follow, not somewhere incidental.
  const section = prompt.slice(prompt.indexOf("# GENERATION METHOD"), prompt.indexOf("# QUALITY"));
  assert.ok(section.includes("--wpm N"), "the pace instruction is inside the generation-method section");
});

test("the guide's own claim about the tool is true: a pace asked for is a pace reached", () => {
  // The guide promises "within about 1%". A promise in a prompt is a claim about this
  // repository's behaviour, so it is checked here rather than trusted: if the renderer's
  // correction ever stops landing, the guide would be telling agents something false.
  const dir = mkdtempSync(join(tmpdir(), "hyper-guide-pace-"));
  const script = join(dir, "s.txt"), out = join(dir, "s.wav"), timeline = join(dir, "s.json");
  writeFileSync(script, "The tide comes in at six. The boat waits.");
  execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", script, "--out", out, "--timeline", timeline, "--wpm", "200"], { stdio: "pipe" });
  const record = JSON.parse(readFileSync(timeline, "utf8"));
  assert.ok(Math.abs(record.pace.wpm - 200) / 200 <= 0.01,
    `the guide says within about 1%, and 200 wpm rendered ${record.pace.wpm}`);
});
