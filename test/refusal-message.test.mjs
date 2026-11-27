// A refusal is only useful if the person holding the script can read it.
//
// The real entry walk found this: a text card holding `The price is ¥500.` linked to an audio
// card produced **no take** (correct) and the message `Codex exited with code 1 and did not
// write its final message (codex-final.json is missing): the run's directory was modified
// during the run.` That sentence is untrue and points at the wrong thing - the directory was
// fine, and the renderer had said exactly what was wrong. A writer with a ¥ in their line would
// chase a bug in the harness.
//
// The cause: a narration agent that hits a refused script exits before writing its final JSON,
// and the server's explanation for "no final message" only ever considered a tidied directory.
// The renderer's own words are on the agent's stderr, so they are carried through instead -
// preferring the line that says what to change (`¥ is a currency this voice does not name`)
// over Node's stack noise, and never inventing a story about the directory when there is a
// real one to tell.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

const root = process.cwd();
const base = mkdtempSync(join(tmpdir(), "hypermaker-refusal-"));

const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const workspace = port => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
async function settle(port, id, tries = 400) {
  let node;
  for (let i = 0; i < tries; i++) {
    node = (await workspace(port)).nodes[id];
    if (node?.artifact || node?.error) return node;
    await new Promise(r => setTimeout(r, 100));
  }
  return node;
}

// One stand-in for both card types: the text agent writes its file, the audio agent runs the
// real renderer against the real material. That is the same pair the narration test uses, and
// it is what makes the refusal real rather than a simulated exit code.
const bin = join(base, "codex");
writeFileSync(bin, `#!/bin/sh
case "$HYPERMAKER_NODE_TYPE" in
  text) exec node ${JSON.stringify(join(root, "test/fake-narration-text-codex.mjs"))} "$@" ;;
  *) exec node ${JSON.stringify(join(root, "test/fake-narration-codex.mjs"))} "$@" ;;
esac
`);
chmodSync(bin, 0o755);

test("a script the voice refuses says which symbol, and never blames the directory", async t => {
  const port = await freePort(), workdir = join(base, "ws");
  const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1", HYPERMAKER_PROJECT: root } });
  try {
    await waitReady(port);
    const made = await post(port, "/api/node", { x: 10, y: 10, type: "text", method: "llm", prompt: "The price is \u00a5500.", quality: "demo" });
    const textId = Number(Object.keys(made.nodes).at(-1));
    await post(port, "/api/generate", { id: textId });
    const textNode = await settle(port, textId);
    assert.match(textNode.artifact || "", /lines\.txt$/, `the material was written, got ${textNode.artifact} / ${textNode.error}`);

    const audio = await post(port, "/api/node", { x: 300, y: 10, type: "audio", prompt: "read it", quality: "demo" });
    const audioId = Number(Object.keys(audio.nodes).at(-1));
    // A link, not `inputs` in the create call: card creation sets `inputs: []`, and passing it
    // here gave the agent nothing to read - the first version of this walk asked for a yen line
    // and got a narration of the phrase "read it".
    await post(port, "/api/link", { source: textId, target: audioId });
    await post(port, "/api/generate", { id: audioId });
    const node = await settle(port, audioId);

    assert.equal(node.artifact, null, "no take is published for a script the voice cannot say");
    assert.equal(node.narration, null, "and no evidence is recorded for one");
    assert.match(node.error || "", /currency this voice does not name/, `the card says what is wrong with the symbol, got ${node.error}`);
    assert.match(node.error, /\u00a5/, `and names it, got ${node.error}`);
    // The message that was there before this fix, and was about the wrong thing entirely.
    assert.doesNotMatch(node.error || "", /directory was modified/, "the refusal does not blame the run directory");
    assert.doesNotMatch(node.error || "", /codex-final\.json is missing/, "nor a missing harness file");
  } finally { stopServer(app); stopAll(); }
});
