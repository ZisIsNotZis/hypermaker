import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultMethodFor, methodFor, typeForFile, methodsFor } from "../server/registry.mjs";
import { assemblePrompt } from "../server/prompt.mjs";

test("registry maps MIME extensions and exposes only filesystem methods", () => {
  assert.equal(typeForFile("picture.PNG"), "image");
  // Text starts on the offline, user-authored method; both model paths are opt-in.
  assert.deepEqual(methodsFor("text").map(x => x.id).sort(), ["llm", "plain", "two-act"]);
  // Three methods work with nothing installed: `readaloud` and `narration` both speak text with
  // the voice that ships in `voice/` (`readaloud` runs here, `narration` hands the job to an
  // agent), and `synth` makes tones. The two remaining speech methods name binaries
  // (~/tts.cpp, ~/bark.cpp) that a machine may not have.
  assert.deepEqual(methodsFor("audio").map(x => x.id).sort(), ["bark.cpp", "narration", "readaloud", "synth", "tts.cpp"]);
  // The starting method for a brand-new audio card has to be one the server can run itself: it is
  // the one that reads a card out loud (not the one that makes a tone) and it needs no account,
  // so a first take is possible on a machine whose model route does not answer.
  assert.equal(defaultMethodFor("audio"), "readaloud", `the audio default is readaloud, got ${defaultMethodFor("audio")}`);
  assert.equal(defaultMethodFor("text"), "plain", "a text card starts on the method that needs no model");
  assert.equal(defaultMethodFor("video"), "firstcut", "a video card starts on the method that needs no model");
  assert.equal(methodFor("audio", "readaloud").builtin, "readaloud", "and the registry says the server runs it");
  const synth = methodsFor("audio").find(x => x.id === "synth");
  assert.ok(!/tts\.cpp|bark\.cpp/.test(synth.tools.join(" ")), "the offline method must not depend on either speech binary");
  assert.match(synth.guide, /not spoken words/, "the guide says what it cannot do");
});

test("prompt uses required sections and direct input metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "hypermaker-prompt-"));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, "1"));
  writeFileSync(join(root, "1", "1.txt"), "source text");
  const prompt = assemblePrompt({
    node: { id: 2, type: "text", method: "llm", quality: "standard", prompt: "make result", inputs: [1] },
    workspace: { workdir: root, projectCwd: "/project", nodes: { 1: { type: "text", artifact: "1.txt", script: null, inputs: [] } } },
    context: { test: true }
  });
  const headings = [...prompt.matchAll(/^# .+$/gm)].map(x => x[0]);
  assert.deepEqual(headings, ["# SHARED PROMPT", "# OUTPUT TYPE", "# GENERATION METHOD", "# QUALITY", "# AGENTS", "# INPUTS", "# CONTEXT", "# USER PROMPT"]);
  assert.match(prompt, /source text/);
  assert.match(prompt, /make result/);
});

test("a linked input with no artifact yet is stated as such, not passed off as nothing", async () => {
  // A person building a chain top-down links a card before generating it. The
  // agent used to receive `artifact: (none)` and nothing else, so a real run
  // failed with no way to tell that the material simply was not there yet.
  const root = mkdtempSync(join(tmpdir(), "hypermaker-empty-input-"));
  const prompt = assemblePrompt({
    node: { id: 2, type: "video", method: "remotion", quality: "standard", prompt: "use it", inputs: [1] },
    workspace: { workdir: root, projectCwd: "/project", nodes: { 1: { type: "audio", artifact: null, script: null, inputs: [] } } },
    context: {}
  });
  assert.match(prompt, /artifact: \(none\)/);
  assert.match(prompt, /has not been generated yet/, "the prompt says the input is empty on purpose");
  assert.match(prompt, /needs to be generated first/, "and tells the agent what a person has to do");
});

test("workspace serialization preserves integer graph records and provenance", async () => {
  const { parseWorkspace, serializeWorkspace } = await import("../server/workspace.mjs");
  const value = { 2: { x: 1, y: 2, inputs: [1], type: "text", method: "llm", prompt: "x", wpm: null, quality: "demo", script: null, artifact: null, status: null, error: null } };
  assert.deepEqual(parseWorkspace(serializeWorkspace(value)), value);
  // `sources` is what a finished artifact was made from. It has to survive a round
  // trip or a restart silently forgets how a film was built.
  const withSources = { 3: { ...value[2], inputs: [1, 2], sources: [{ id: 1, type: "image", artifact: "p.png" }, { id: 2, type: "audio", artifact: "t.wav" }] } };
  assert.deepEqual(parseWorkspace(serializeWorkspace(withSources)), withSources);
  assert.equal(serializeWorkspace({ 3: { ...value[2], sources: [] } }).includes("sources:"), false, "an empty provenance adds no clutter");
});
