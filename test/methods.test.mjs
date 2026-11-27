// The audio card was the one card a person cannot use out of the box, and the canvas
// hid why. Three defects, all found by walking the documented path in a real browser:
//
//   1. Switching a card's type left the previous type's method list in the dropdown.
//      `fillMethods` ran only when a card was built, so a text card switched to audio
//      still showed `llm` - and the offline `synth` method the README recommends could
//      not be chosen at all.
//   2. The server, meanwhile, defaulted a new audio card to `bark.cpp`, because the
//      method list is alphabetical and `bark.cpp` sorts first. That method needs a
//      binary under `~/bark.cpp` that is not on this machine, so the default choice was
//      the single one that cannot work.
//   3. Pressing Generate on such a card made an attempt directory and a run marker, then
//      failed with the agent's own message about a missing file - a failure about a
//      binary, reported as if it were about the render.
//
// A method now declares the tool it needs, the registry says whether that tool is
// installed, and the list puts what works first. The tests below pin the parts a person
// would otherwise only find out by trying.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { methodFor, methodRegistry, methodsFor } from "../server/registry.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

// The same expansion the registry uses, written out so the assertion cannot agree with
// the implementation merely by sharing its helper.
const expand = path => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
const fileExists = path => { try { return statSync(expand(path)).isFile(); } catch { return false; } };

test("a method whose tool is missing is marked, and never sorts ahead of one that works", () => {
  const audio = methodsFor("audio");
  const synth = audio.find(m => m.id === "synth"), bark = audio.find(m => m.id === "bark.cpp"), tts = audio.find(m => m.id === "tts.cpp");
  assert.ok(synth && bark && tts, "all three audio methods are registered");
  assert.equal(synth.available, true, "the offline method needs nothing, so it is always available");
  // The real claim: availability is a fact about the declared binary, not a guess. On a
  // machine that does have the binary this stays true and the method becomes selectable
  // as a default, which is the correct behaviour there.
  for (const [method, binary] of [[bark, "~/bark.cpp/build/examples/main/main"], [tts, "~/tts.cpp/build/bin/tts-cli"]]) {
    assert.deepEqual(method.requires, [binary], `${method.id} declares the binary it needs`);
    assert.equal(method.available, fileExists(binary), `${method.id}'s availability matches whether ${binary} exists`);
  }
  assert.equal(audio[0].available, true, `the first method offered is one that works here; got ${audio.map(m => `${m.id}:${m.available}`).join(", ")}`);
  // `methodFor` is what the server and the canvas both use, so it has to agree.
  assert.equal(methodFor("audio", bark.id).available, bark.available);
  assert.equal(methodFor("audio", "no-such-method"), null, "an unknown method is reported rather than invented");
});

test("a card whose method needs a missing tool refuses before creating anything, and names the one that works", async () => {
  const base = mkdtempSync(join(tmpdir(), "hypermaker-method-")), bin = join(base, "agent"), started = join(base, "started.log");
  // An agent whose only job is to record that it ran: the log existing is proof that the
  // refusal did not happen before the run started.
  writeFileSync(bin, `#!/bin/sh\necho started >> ${JSON.stringify(started)}\nexit 1\n`); chmodSync(bin, 0o755);
  const port = await freePort(), workdir = join(base, "ws");
  const app = startServer({ cwd: process.cwd(), port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  try {
    await waitReady(port);
    const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
    // Only meaningful while the machine really lacks the binary. On a machine that has it
    // the refusal is correctly absent, so there is nothing to test rather than a failure.
    const missing = methodsFor("audio").find(m => m.available === false);
    if (!missing) return;
    const created = await post("/api/node", { x: 10, y: 10, type: "audio", method: missing.id, quality: "demo", prompt: "speak" });
    const id = Number(Object.keys(created.nodes).at(-1));
    const answer = await post("/api/generate", { id });
    assert.match(answer.error || "", new RegExp(missing.id.replace(/\./g, "\\.")), "the refusal names the method that cannot run");
    assert.match(answer.error, /needs /, "and says what is missing");
    assert.match(answer.error, /synth/, "and points at the method that works with nothing installed");
    assert.equal(answer.nodes[id].status, "draft", "the card was not marked running");
    let made = [];
    try { made = readdirSync(join(workdir, String(id)), { recursive: true }); } catch {}
    assert.deepEqual(made.filter(f => String(f).startsWith("attempts")), [], `no attempt directory was made, got ${made}`);
    assert.ok(!made.includes("run.json"), "no run marker was left behind");
    assert.equal(existsSync(started), false, "and no agent was spawned");
  } finally { stopServer(app); stopAll(); }
});

test("a card that can run is not refused, and its own method is what starts", async () => {
  // The other direction: the refusal must not become a blanket one. `synth` works with
  // nothing installed, so the ordinary press has to go through.
  // A `.mjs` CODEX_BIN is run with the current Node; a shell script would be given the
  // CLI's own arguments instead, which is why the first version of this fixture failed.
  const base = mkdtempSync(join(tmpdir(), "hypermaker-method-ok-")), bin = join(base, "agent.mjs");
  writeFileSync(bin, `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR;
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "tone.wav"), "not really a wav, but this test is about routing");
writeFileSync(join(dir, "make.mjs"), "// tone");
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (out) writeFileSync(out, JSON.stringify({ prompt: "speak", script: "make.mjs", artifact: "tone.wav", type: "audio", method: "synth", error: null }));
`);
  const port = await freePort(), workdir = join(base, "ws");
  const app = startServer({ cwd: process.cwd(), port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  try {
    await waitReady(port);
    const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
    const created = await post("/api/node", { x: 10, y: 10, type: "audio", method: "synth", quality: "demo", prompt: "speak" });
    const id = Number(Object.keys(created.nodes).at(-1));
    const answer = await post("/api/generate", { id });
    assert.ok(!answer.error, `a method that works is not refused: ${answer.error}`);
    for (let i = 0; i < 100; i++) { const n = answer.nodes[id]; if (n.status !== "running") break; await new Promise(r => setTimeout(r, 100)); }
    const final = await fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
    assert.equal(final.nodes[id].status, "idle", `the run finished, got ${final.nodes[id].status} ${final.nodes[id].error || ""}`);
    assert.ok(final.nodes[id].artifact, "with an artifact on the card");
  } finally { stopServer(app); stopAll(); }
});

test("every registered method states its guide and tools, so a new one cannot be added silently", () => {
  for (const [key, method] of methodRegistry) {
    assert.equal(typeof method.guide, "string", `${key} has a guide`);
    assert.ok(method.guide.length > 40, `${key}'s guide actually says something`);
    assert.ok(Array.isArray(method.tools) && method.tools.length, `${key} lists its tools`);
    if (method.requires) {
      assert.ok(Array.isArray(method.requires), `${key}'s requires is a list of paths`);
      // A declared requirement must also be a tool the guide names, or the agent is asked
      // for something the method never mentions.
      for (const path of method.requires) assert.ok(method.tools.includes(path), `${key} lists its requirement ${path} among its tools`);
    }
  }
});
