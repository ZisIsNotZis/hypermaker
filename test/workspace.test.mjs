import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nodeRecord, parseWorkspace, readWorkspace, serializeWorkspace, writeWorkspace, workspacePath } from "../server/workspace.mjs";

test("workspace round trips exact node fields and integer input IDs", () => {
  // `wpm` is written on every card, including the cards that never asked for a pace: a field that
  // is sometimes absent and sometimes null reads as two different facts when it is one.
  const nodes = { 2: { x: 3, y: 4, inputs: [1], type: "text", method: "llm", prompt: "say hi", promptUsed: "say hi", wpm: null, quality: "demo", script: null, artifact: "hello.txt", status: null, error: null } };
  assert.deepEqual(parseWorkspace(serializeWorkspace(nodes)), nodes);
});

// A pace set before the first read, and a film's own measurements, are facts about the artifact on
// the card: a restart that lost them would turn "asked 110, reads at 110" into "reads at 110" - a
// request silently downgraded to a result - and would leave a film unable to say what it measured.
test("a chosen pace and a film's measurements survive a restart", () => {
  const nodes = { 4: { x: 0, y: 0, inputs: [], type: "audio", method: "readaloud", prompt: "read this", wpm: 110, quality: "standard", script: null, artifact: "versions/v1-narration.wav", status: "idle", error: null },
    5: { x: 0, y: 0, inputs: [4], type: "video", method: "firstcut", prompt: "", quality: "standard", script: "versions/v1-first-cut-source.jsx", artifact: "versions/v1-film.mp4", status: "idle", error: null, film: { seconds: 5.25, width: 1280, height: 720, videoCodec: "h264", audioCodec: "aac", correlation: 0.998 } } };
  const back = parseWorkspace(serializeWorkspace(nodes));
  assert.equal(back[4].wpm, 110, "the pace the person chose is still on the card after a restart");
  assert.equal(back[5].film.correlation, 0.998, "and the film still says what its soundtrack measured");
  assert.equal(back[5].film.videoCodec, "h264");
  // A card that never asked for a pace and has no film is normalised by `nodeRecord`, which is
  // what every reader of the file goes through: the optional fields are simply absent from the
  // text, and come back as null rather than as undefined on one path and null on another.
  const plain = nodeRecord(6, parseWorkspace(serializeWorkspace({ 6: { x: 0, y: 0, inputs: [], type: "audio", method: "readaloud", prompt: "", quality: "standard", script: null, artifact: null } }))[6]);
  assert.equal(plain.wpm, null);
  assert.equal(plain.film, null);
  assert.equal(parseWorkspace(serializeWorkspace({ 6: { x: 0, y: 0, inputs: [], type: "audio", method: "readaloud", prompt: "", quality: "standard", script: null, artifact: null } }))[6].film, undefined, "an unset film is not written to the file at all");
});

// The prompt that produced a kept version has to survive a restart for the same
// reason its material copy does: after reopening, the only way to tell two takes
// apart is what each one recorded about itself.
test("a kept version remembers the prompt that made it, and a card remembers its own", () => {
  const nodes = { 3: { x: 0, y: 0, inputs: [], type: "video", method: "remotion", prompt: "a sea film, take two", promptUsed: "a sea film", quality: "standard", script: null, artifact: "versions/v2-film.mp4", status: "idle", error: null, sources: [], versions: [{ id: 2, artifact: "versions/v1-film.mp4", file: "versions/v1-film.mp4", sources: [], prompt: "a sea film" }] } };
  const file = serializeWorkspace(nodes);
  const back = parseWorkspace(file);
  assert.equal(back[3].promptUsed, "a sea film", "the box may hold the next take without changing what this artifact was asked for");
  assert.equal(back[3].versions[0].prompt, "a sea film");
  // A version kept before prompts were recorded has none, and must read back as
  // unknown rather than as the card's current prompt.
  const legacy = parseWorkspace("3:\n  prompt: today's words\n  artifact: versions/v1-film.mp4\n  versions: [{\"id\":2,\"artifact\":\"versions/v0-film.mp4\",\"file\":\"versions/v0-film.mp4\",\"sources\":[]}]\n");
  assert.equal(legacy[3].versions[0].prompt, undefined, "an old version does not inherit today's prompt");
});

test("a run outcome survives a round trip, so a restart cannot hide a failure", () => {
  const nodes = { 1: { x: 0, y: 0, inputs: [], type: "text", method: "llm", prompt: "p", quality: "standard", script: null, artifact: "old.txt", status: "error", error: "Codex exited with code 3" } };
  const back = parseWorkspace(serializeWorkspace(nodes));
  assert.equal(back[1].status, "error");
  assert.equal(back[1].error, "Codex exited with code 3");
  assert.equal(back[1].artifact, "old.txt", "the earlier artifact is kept alongside the failure");
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

test("prompt files exist outside JavaScript source", async () => {
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(join(process.cwd(), "prompts", "shared.txt")), true);
  assert.equal(existsSync(join(process.cwd(), "prompts", "output-text.txt")), true);
});
