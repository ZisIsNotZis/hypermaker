import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { method } from "../types/text/methods/two-act.mjs";
import { generate } from "../server/codex.mjs";
import { methodRegistry, methodsFor } from "../server/registry.mjs";

const pictures = (root) => [
  { id: 1, type: "image", artifact: "dawn.png", frozen: join(root, "1", "frozen", "1-dawn.png") },
  { id: 2, type: "image", artifact: "night.png", frozen: join(root, "1", "frozen", "2-night.png") }
];

test("two-act is registered as one text method, and its two-line shape is the whole script", () => {
  assert.equal(methodRegistry.get("text/two-act"), method, "the registry loads the method from types/text/methods");
  assert.ok(methodsFor("text").some(m => m.id === "two-act" && m.available !== false), "it is offered among text methods");
  assert.equal(method.imageReply("The harbour wakes under a red sky.\nA small boat turns for home.\n"), "The harbour wakes under a red sky.\nA small boat turns for home.\n");
  for (const reply of ["one line only.", "A first line.\n\nA second line.\n", "A first line.\nThe boat is on screen at 00:04 and the camera pans slowly.\n", "Line one!\nLine two.\nAn extra act."]) {
    assert.throws(() => method.imageReply(reply), /two short English sentences/, `a reply is refused unless it is exactly two acts: ${JSON.stringify(reply)}`);
  }
});

test("two-act refuses to start a model without two supplied pictures and an intent", () => {
  const root = mkdtempSync(join(tmpdir(), "two-act-inputs-"));
  const [first, second] = pictures(root);
  assert.match(method.imageInputs([first], "a quiet homecoming"), /exactly two/);
  assert.match(method.imageInputs([first, second], "  "), /creative intent/);
  assert.match(method.imageInputs([first, { ...second, type: "audio", artifact: "voice.wav" }], "a quiet homecoming"), /PNG or JPEG/);
  assert.equal(method.imageInputs([first, second], "a quiet homecoming"), null);
});

test("a simulated Codex receives both frozen pictures in order, and its reply becomes a staged text artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "two-act-run-"));
  const workdir = join(root, "workspace"), attemptDir = join(root, "attempt");
  for (const dir of [join(workdir, "1"), join(workdir, "2"), attemptDir]) mkdirSync(dir, { recursive: true });
  for (const file of ["1/dawn.png", "2/night.png"]) writeFileSync(join(workdir, file), Buffer.from([137, 80, 78, 71]));
  const [first, second] = pictures(root).map((p, i) => ({ ...p, frozen: join(attemptDir, `f${i + 1}.png`) }));
  for (const p of [first, second]) writeFileSync(p.frozen, readFileSync(join(workdir, String(p.id), p.artifact)));
  const called = join(root, "called.json");
  const bin = join(root, "fixture.mjs");
  writeFileSync(bin, `
    import { writeFileSync } from "node:fs";
    const args = process.argv.slice(2);
    console.error('failed to refresh available models: private-route-marker');
    console.log(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 48, output_tokens: 18, profile: 'private-route-marker'}}));
    writeFileSync(${JSON.stringify(called)}, JSON.stringify({ args, cwd: process.cwd() }));
    writeFileSync(args[args.indexOf("--output-last-message") + 1], "The harbour wakes under a red sky.\\nA small boat turns for home.\\n");
  `);
  process.env.CODEX_BIN = bin;
  try {
    const result = await generate({
      node: { id: 3, type: "text", method: "two-act", prompt: "a quiet homecoming", inputs: [1, 2] },
      workspace: { workdir, projectCwd: root, nodes: { 1: first, 2: second } },
      attemptDir, method
    });
    const call = JSON.parse(readFileSync(called, "utf8"));
    assert.ok(!call.args.includes("--model"), "the configured Codex model is not overridden");
    assert.ok(!call.args.includes("-c"), "the configured Codex effort is not overridden");
    const imageIndexes = call.args.flatMap((a, i) => a === "--image" ? [i] : []);
    assert.deepEqual(imageIndexes.map(i => call.args[i + 1]), [first.frozen, second.frozen], "the fixture is handed the frozen picture copies, first act first");
    assert.equal(call.args[imageIndexes[1] + 2], "--", "the prompt follows --, so a prompt beginning with a hyphen is not an option");
    assert.equal(call.args[imageIndexes[0] - 1], "--ephemeral", "the image arguments follow regular flags");
    assert.equal(call.args[call.args.indexOf("--sandbox") + 1], "read-only", "a two-act draft has no reason to write in the workspace");
    assert.equal(call.cwd, attemptDir, "the fixture runs in this run's own directory");
    assert.equal(join(workdir, "3", result.artifact), join(attemptDir, "script.txt"));
    assert.equal(readFileSync(join(attemptDir, "script.txt"), "utf8"), "The harbour wakes under a red sky.\nA small boat turns for home.\n");
    const receipt = JSON.parse(readFileSync(join(workdir, "3", "codex.jsonl"), "utf8"));
    assert.deepEqual(Object.keys(receipt).filter(k => /route|elapsedMs|exit/.test(k)).sort(), ["elapsedMs", "exit", "route"], "the record names the simulated route and its duration");
    assert.equal(receipt.route, "simulated-cli");
    assert.equal(receipt.outcome, "drafted", "a model-refresh warning must not discard a successful script");
    assert.equal(receipt.discoveryIssue, true);
    assert.deepEqual(receipt.usage, {input_tokens: 48, output_tokens: 18}, "only numeric usage fields are retained");
    assert.doesNotMatch(JSON.stringify(receipt), /private-route-marker/);
  } finally {
    delete process.env.CODEX_BIN;
  }
});

test("a script that is not two lines is refused instead of returning an artifact to publish", async () => {
  const root = mkdtempSync(join(tmpdir(), "two-act-bad-"));
  const workdir = join(root, "workspace"), attemptDir = join(root, "attempt");
  for (const dir of [join(workdir, "1"), join(workdir, "2"), attemptDir]) mkdirSync(dir, { recursive: true });
  const [first, second] = pictures(root).map((p, i) => ({ ...p, frozen: join(attemptDir, `f${i + 1}.png`) }));
  for (const p of [first, second]) writeFileSync(p.frozen, "picture");
  const bin = join(root, "fixture.mjs");
  writeFileSync(bin, `
    import { writeFileSync } from "node:fs";
    const args = process.argv.slice(2);
    writeFileSync(args[args.indexOf("--output-last-message") + 1], "Only one act.\\n");
  `);
  process.env.CODEX_BIN = bin;
  try {
    await assert.rejects(generate({
      node: { id: 3, type: "text", method: "two-act", prompt: "a quiet homecoming", inputs: [1, 2] },
      workspace: { workdir, projectCwd: root, nodes: { 1: first, 2: second } },
      attemptDir, method
    }), /two short English sentences/);
    assert.equal(readFileSync(join(workdir, "3", "codex.jsonl"), "utf8").trim().split("\n").length, 1, "the refusal is recorded once");
  } finally { delete process.env.CODEX_BIN; }
});
