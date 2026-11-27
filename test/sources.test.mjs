import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";
import { readWorkspace } from "../server/workspace.mjs";

// How an artifact's provenance must behave, and two ways it must NOT:
//
//   * It is the set of materials the run was *given*, frozen at start. A film
//     takes minutes; a person may rewire the canvas while watching it, and
//     reading the links at completion would label the film with materials it
//     never saw.
//   * A link added during a run is the person's preparation for the *next* run,
//     so the run must not undo it when it finishes.
//   * If a re-run fails or is stopped, the card still shows the previous
//     artifact - so it must also still show the previous artifact's provenance,
//     not the inputs of the attempt that failed.
//
// The agent here is a slow stand-in, so the mid-run window is wide enough to
// change the canvas in.
const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-sources-")), bin = join(base, "agent");
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(root, "test/fake-agent.mjs"))} "$@"\n`); chmodSync(bin, 0o755);

let app, port, workdir;
before(async () => {
  port = await freePort();
  workdir = join(base, "ws");
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1", AGENT_MODE: process.env.AGENT_MODE || "slow", AGENT_DELAY: "1200" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
});
after(async () => { stopServer(app); stopAll(); });

const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const workspace = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
const patch = (body) => fetch(`http://127.0.0.1:${port}/api/node`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());

async function material(type, artifact) {
  const id = Number(Object.keys((await post("/api/node", { x: 0, y: 0, type, method: type === "text" ? "llm" : "synth", prompt: type })).nodes).at(-1));
  mkdirSync(join(workdir, String(id)), { recursive: true });
  writeFileSync(join(workdir, String(id), artifact), artifact.endsWith(".png") ? Buffer.from([0x89, 0x50, 0x4e, 0x47]) : "content");
  await patch({ id, artifact });
  return id;
}

async function card(type = "text") {
  return Number(Object.keys((await post("/api/node", { x: 300, y: 0, type, method: type === "text" ? "llm" : "synth", prompt: "target" })).nodes).at(-1));
}

async function settled(id, tries = 300) {
  let node;
  for (let i = 0; i < tries; i++) {
    node = (await workspace()).nodes[id];
    if (node && node.status !== "running") return node;
    await new Promise(r => setTimeout(r, 100));
  }
  return node;
}

test("a finished artifact names the materials it was started with, and a mid-run link is kept", async () => {
  const poster = await material("image", "poster.png");
  const tone = await material("audio", "tone.wav");
  const later = await material("text", "later.txt");

  const filmId = await card();
  await post("/api/link", { source: poster, target: filmId });
  await post("/api/link", { source: tone, target: filmId });
  await post("/api/generate", { id: filmId });

  await new Promise(r => setTimeout(r, 300));
  assert.equal((await workspace()).nodes[filmId].status, "running", "the run is live while the canvas is rewired");
  await post("/api/unlink", { source: tone, target: filmId });
  await post("/api/link", { source: later, target: filmId });

  const node = await settled(filmId);
  assert.equal(node.status, "idle", `the run finished, got ${node.error}`);
  assert.deepEqual(node.sources.map(s => s.id), [poster, tone], "the artifact reports the inputs frozen when the run began");
  assert.ok(!node.sources.some(s => s.id === later), "the card linked during the run is not claimed as a source");
  // The link is the person's edit, so it survives the run that was already going.
  assert.deepEqual(node.inputs, [poster, later], "the canvas keeps the links the person made during the run");

  // The on-disk record tells the same story to the next server process.
  const fromDisk = readWorkspace(workdir)[String(filmId)];
  assert.deepEqual(fromDisk.sources.map(s => s.id), [poster, tone], "the persisted record keeps the same provenance");
  assert.deepEqual(fromDisk.inputs, [poster, later], "the persisted record keeps the person's links");
});

test("a workspace read back from disk still names its sources by id", async () => {
  // Every other test creates its cards through POST, so each node object carries
  // its own `id`. A node loaded from workspace.yml does not: the map key is the
  // id, and the record has no such field. Reading `s.id` therefore wrote `null`
  // for every source, so the card said "made from #null image" on the real chain -
  // which is the ordinary case, since a film is usually made after a restart.
  const poster = await material("image", "disk.png");
  const target = await card();
  await post("/api/link", { source: poster, target });

  // Restart the server so the graph is genuinely reloaded from disk.
  stopServer(app);
  await new Promise(r => setTimeout(r, 400));
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "0", AGENT_MODE: "ok" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);

  const loaded = (await workspace()).nodes[target];
  assert.deepEqual(loaded.inputs, [poster], "the link survived the reload");
  await post("/api/generate", { id: target });
  const node = await settled(target);
  assert.equal(node.status, "idle", `the run finished, got ${node.error}`);
  assert.ok(node.sources.every(s => Number.isInteger(s.id)), `every source has a real id, got ${JSON.stringify(node.sources)}`);
  assert.deepEqual(node.sources.map(s => s.id), [poster]);
});

test("a re-run that fails leaves the previous artifact's provenance alone", async () => {
  // The card already holds a good artifact made from one material.
  const poster = await material("image", "poster2.png");
  const extra = await material("text", "extra.txt");
  const target = await card();
  await post("/api/link", { source: poster, target });
  await post("/api/generate", { id: target });
  const good = await settled(target);
  assert.equal(good.status, "idle", `the first run succeeded, got ${good.error}`);
  assert.deepEqual(good.sources.map(s => s.id), [poster]);

  // Now rewire it and stop the next attempt mid-flight. The artifact on the card
  // is still the old one, so its provenance must still be the old one.
  await post("/api/link", { source: extra, target });
  await post("/api/generate", { id: target });
  await new Promise(r => setTimeout(r, 300));
  await post("/api/cancel", { id: target });
  const stopped = await settled(target);
  assert.equal(stopped.status, "cancelled", `the second run was stopped, got ${stopped.status}`);
  assert.equal(stopped.artifact, good.artifact, "the old artifact is still the one on the card");
  assert.deepEqual(stopped.sources.map(s => s.id), [poster], "the shown artifact keeps the provenance it was made with");
  assert.deepEqual(stopped.inputs, [poster, extra], "the links for the next attempt are kept");
});
