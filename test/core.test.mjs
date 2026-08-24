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
  assert.deepEqual(methodsFor("audio").map(x => x.id).sort(), ["bark.cpp", "tts.cpp"]);
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

test("workspace serialization preserves integer graph records", async () => {
  const { parseWorkspace, serializeWorkspace } = await import("../server/workspace.mjs");
  const value = { 2: { x: 1, y: 2, inputs: [1], type: "text", method: "llm", prompt: "x", quality: "demo", script: null, artifact: null } };
  assert.deepEqual(parseWorkspace(serializeWorkspace(value)), value);
});
