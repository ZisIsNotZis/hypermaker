import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { typeForFile, methodsFor } from "../server/registry.mjs";
import { assemblePrompt } from "../server/prompt.mjs";

test("registry maps MIME extensions and exposes only filesystem methods", () => {
  assert.equal(typeForFile("picture.PNG"), "image");
  assert.deepEqual(methodsFor("text").map(x => x.id), ["llm"]);
  // Two methods work with nothing installed: `narration` speaks text with the voice that
  // ships in `voice/`, and `synth` makes tones. The two other speech methods name binaries
  // (~/tts.cpp, ~/bark.cpp) that a machine may not have, so an audio card needs paths that
  // are not blocked on them.
  assert.deepEqual(methodsFor("audio").map(x => x.id).sort(), ["bark.cpp", "narration", "synth", "tts.cpp"]);
  // The default for a brand-new audio card is the first available method, and it has to be
  // the one that reads a card out loud rather than the one that makes a tone: the reason a
  // person reaches for an audio card next to a text card is narration.
  assert.equal(methodsFor("audio")[0].id, "narration", `the audio default is narration, got ${methodsFor("audio").map(x => x.id).join(", ")}`);
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
  const value = { 2: { x: 1, y: 2, inputs: [1], type: "text", method: "llm", prompt: "x", quality: "demo", script: null, artifact: null, status: null, error: null } };
  assert.deepEqual(parseWorkspace(serializeWorkspace(value)), value);
  // `sources` is what a finished artifact was made from. It has to survive a round
  // trip or a restart silently forgets how a film was built.
  const withSources = { 3: { ...value[2], inputs: [1, 2], sources: [{ id: 1, type: "image", artifact: "p.png" }, { id: 2, type: "audio", artifact: "t.wav" }] } };
  assert.deepEqual(parseWorkspace(serializeWorkspace(withSources)), withSources);
  assert.equal(serializeWorkspace({ 3: { ...value[2], sources: [] } }).includes("sources:"), false, "an empty provenance adds no clutter");
});
