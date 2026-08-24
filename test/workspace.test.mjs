import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseWorkspace, readWorkspace, serializeWorkspace, writeWorkspace, workspacePath } from "../server/workspace.mjs";

test("workspace round trips exact node fields and integer input IDs", () => {
  const nodes = { 2: { x: 3, y: 4, inputs: [1], type: "text", method: "llm", prompt: "say hi", quality: "demo", script: null, artifact: "hello.txt" } };
  assert.deepEqual(parseWorkspace(serializeWorkspace(nodes)), nodes);
});

test("workspace reads empty and writes atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "hypermaker-workspace-"));
  assert.deepEqual(readWorkspace(dir), {});
  writeWorkspace(dir, { 1: { x: 0, y: 0, inputs: [], type: "text", method: "llm", prompt: "", quality: "standard", script: null, artifact: null } });
  assert.match(readFileSync(join(dir, "workspace.yml"), "utf8"), /^1:/);
  assert.equal(readWorkspace(dir)[1].type, "text");
});

test("node files resolve only inside node workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "hypermaker-workspace-path-"));
  assert.equal(workspacePath(dir, 4, "result.txt"), join(dir, "4", "result.txt"));
  assert.throws(() => workspacePath(dir, 4, "../../outside.txt"), /outside/);
});
