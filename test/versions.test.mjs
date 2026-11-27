import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

// The need: a person changes the material upstream, presses Generate again, and
// wants to compare the new result with the one they already approved - not lose it.
//
// Two failures this is written against, both reproduced by hand before the fix:
//
//   1. The agent writes its usual filename and *then* fails. The card kept the old
//      film's name and provenance but played the failed attempt's bytes, because
//      the agent had written over the file the card was pointing at.
//   2. A film reads its material, then takes minutes. A person replaces the poster
//      meanwhile. The film was made from the old poster, but the saved material
//      copy was taken at the end and held the new one - so the version claimed
//      provenance it never had.
//
// Both are the same root cause, and both are fixed by the same rule: what a run is
// given is frozen before it starts, and what it produces is published under a name
// nothing can write to. The checks below make the rule observable from outside.
const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-versions-")), bin = join(base, "codex");
// The stand-in agent answers with the same filename every time, like a real one.
// The film's bytes are a copy of the material it was given, so "which material went
// into which version" can be read from the files rather than trusted from the
// metadata this test is checking.
writeFileSync(join(base, "agent.mjs"), `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR;
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
const prompt = readFileSync(join(dir, "prompt.txt"), "utf8");
const given = (prompt.match(/artifact path: (\\S+)/) || [])[1];
// Read the material before waiting, so a swap during the wait cannot change what
// this run saw - that is exactly what a real renderer does.
const material = given && existsSync(given) ? readFileSync(given, "utf8") : "no material";
if (prompt.includes("slow")) { const { execFileSync } = await import("node:child_process"); execFileSync("sleep", ["2"]); }
const artifact = join(dir, "film.png");
// A failing run still writes a partial file first, which is the case that used to
// destroy the approved film.
writeFileSync(artifact, "made from " + material + (prompt.includes("please fail") ? " (unfinished)" : ""));
if (prompt.includes("please fail")) { console.error("the agent could not finish"); process.exit(3); }
if (out) writeFileSync(out, JSON.stringify({ prompt: "p", script: null, artifact, type: "image", method: "remotion", error: null }));
`);
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(base, "agent.mjs"))} "$@"\n`);
chmodSync(bin, 0o755);

let app, port, workdir;
before(async () => {
  port = await freePort();
  workdir = join(base, "ws");
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
});
after(() => { stopServer(app); stopAll(); });

const call = (method, path, payload) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
const workspace = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
async function settle(id, tries = 400) {
  for (let i = 0; i < tries; i++) {
    const node = (await workspace()).nodes[id];
    if (node && node.status !== "running") return node;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`node ${id} never settled`);
}
const bytesOf = (id, file) => readFileSync(join(workdir, String(id), file), "utf8").trim();

// One film card and one material card, so both tests can share a workspace without
// depending on each other's numbering.
let materialId, filmId;
async function setUp() {
  const created = await call("POST", "/api/node", { x: 0, y: 0, type: "image", method: "remotion", prompt: "material" });
  materialId = Number(Object.keys(created.nodes).at(-1));
  mkdirSync(join(workdir, String(materialId)), { recursive: true });
  filmId = Number(Object.keys((await call("POST", "/api/node", { x: 300, y: 0, type: "image", method: "remotion", prompt: "first take" })).nodes).at(-1));
  await call("POST", "/api/link", { source: materialId, target: filmId });
}
const setMaterial = text => { writeFileSync(join(workdir, String(materialId), "poster.png"), text); };
async function paint(text) {
  // The card has to be told the material exists; that is what a person's generated
  // poster looks like from the server's side.
  setMaterial(text);
  await call("PATCH", "/api/node", { id: materialId, artifact: "poster.png" });
}

test("a failed attempt cannot take the film the person is looking at, nor relabel it", async () => {
  await setUp();
  await paint("A");
  await call("POST", "/api/generate", { id: filmId });
  const first = await settle(filmId);
  assert.equal(first.error, null, `the first film rendered, got ${first.error}`);
  assert.equal(bytesOf(filmId, first.artifact), "made from A");

  // The upstream material changes, the person tries again, and this time the agent
  // writes its usual filename and then dies.
  await paint("B");
  await call("PATCH", "/api/node", { id: filmId, prompt: "please fail" });
  await call("POST", "/api/generate", { id: filmId });
  const failed = await settle(filmId);

  assert.equal(failed.status, "error");
  assert.equal(bytesOf(filmId, failed.artifact), "made from A", "the card still plays the film that worked");
  assert.equal(failed.sources.length, 1);
  assert.equal(bytesOf(filmId, failed.sources[0].file), "A", "and its provenance still names the material it was really made from");
  assert.deepEqual(failed.versions || [], [], "a failed first attempt leaves nothing to compare");

  // The partial file the agent wrote is scratch and must not be what anyone sees.
  assert.notEqual(bytesOf(filmId, failed.artifact), "made from B (unfinished)");
});

test("a second version keeps the first one playable, its own bytes and its own material", async () => {
  await call("PATCH", "/api/node", { id: filmId, prompt: "second take" });
  await call("POST", "/api/generate", { id: filmId });
  const second = await settle(filmId);
  assert.equal(second.error, null, `the second film rendered, got ${second.error}`);
  assert.equal(bytesOf(filmId, second.artifact), "made from B", "the card shows the new film");
  assert.equal(second.versions.length, 1, "the film it replaced is still listed");
  const kept = second.versions[0];
  assert.equal(bytesOf(filmId, kept.file), "made from A", "and its bytes are the ones that were approved");
  assert.equal(bytesOf(filmId, kept.sources[0].file), "A", "with the material that film saw, not today's");
  assert.equal(bytesOf(filmId, second.sources[0].file), "B", "and the new film records its own material");
  assert.notEqual(second.artifact, kept.file, "two versions cannot share one file");

  // Going back is not a one-way door: the film being replaced becomes the alternative.
  const restored = (await call("POST", "/api/restore", { id: filmId, version: kept.id })).nodes[filmId];
  assert.equal(bytesOf(filmId, restored.artifact), "made from A", "going back really restores the earlier film");
  assert.equal(bytesOf(filmId, restored.sources[0].file), "A", "with the material that film was made from");
  assert.equal(restored.versions.length, 1);
  assert.equal(bytesOf(filmId, restored.versions[0].file), "made from B", "and the film you left is the alternative");
});

test("a material swapped mid-render does not change what the film is made from, or what it records", async () => {
  await call("PATCH", "/api/node", { id: filmId, prompt: "slow take" });
  await call("POST", "/api/generate", { id: filmId });
  for (let i = 0; i < 60 && (await workspace()).nodes[filmId].status !== "running"; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await workspace()).nodes[filmId].status, "running", "the film is really rendering while the material is swapped");
  // The person replaces the poster's file while the film is being made.
  setMaterial("C");
  const done = await settle(filmId);
  assert.equal(done.error, null, `the film finished, got ${done.error}`);
  assert.equal(bytesOf(filmId, done.artifact), "made from B", "the film used the material it started with");
  assert.equal(bytesOf(filmId, done.sources[0].file), "B", "and the material it recorded is the same bytes");
  assert.equal(bytesOf(materialId, "poster.png"), "C", "while the card upstream now holds the new material");
});

test("an agent that hands back the previous render fails instead of publishing it again", async () => {
  // A real run did this: two different posters, two "versions", byte-identical video,
  // because the agent named the film it had already rendered. "The file exists" was
  // treated as "this run made it", so the card showed a second version made from
  // material the film never saw. A creator needs to see a failure they can retry,
  // with the approved version still playable.
  const reuseBin = join(base, "reuse-codex");
  // fake-agent.mjs is the one that can leave a file behind and name it again; the
  // film stand-in above always renders a fresh PNG.
  writeFileSync(reuseBin, `#!/bin/sh\nAGENT_MODE=reuse exec node ${JSON.stringify(join(root, "test/fake-agent.mjs"))} "$@"\n`);
  chmodSync(reuseBin, 0o755);
  const reusePort = await freePort(), reuseWorkdir = join(base, "reuse-ws");
  const reuse = startServer({ cwd: root, port: reusePort, env: { CODEX_BIN: reuseBin, HYPERMAKER_WORKDIR: reuseWorkdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  reuse.stderr.on("data", c => process.stderr.write(c));
  await waitReady(reusePort);
  const api = (method, path, payload) => fetch(`http://127.0.0.1:${reusePort}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
  const ws = () => fetch(`http://127.0.0.1:${reusePort}/api/workspace`).then(r => r.json());
  const wait = async id => { for (let i = 0; i < 200; i++) { const n = (await ws()).nodes[id]; if (n.status !== "running") return n; await new Promise(r => setTimeout(r, 100)); } };

  try {
    const card = Number(Object.keys((await api("POST", "/api/node", { x: 0, y: 0, type: "text", method: "llm", prompt: "first" })).nodes).at(-1));
    await api("POST", "/api/generate", { id: card });
    const first = await wait(card);
    assert.equal(first.error, null, `the first run produced output, got ${first.error}`);
    const approved = first.artifact;

    // The second attempt names the same file without rewriting it. Deliberately back
    // to back, with no pause: an earlier version of this check allowed a second of
    // clock slack for timestamps, so two runs closer together than that let the old
    // file through and published it as a new version. Waiting 1.5s first hid exactly
    // the case a person hits - change the prompt and press Generate again.
    await api("PATCH", "/api/node", { id: card, prompt: "second" });
    await api("POST", "/api/generate", { id: card });
    const second = await wait(card);

    assert.equal(second.status, "error", "handing back an old file is a failure, not a new version");
    assert.match(second.error, /without rewriting it/, `the card says what happened, got ${second.error}`);
    assert.equal(second.artifact, approved, "the approved artifact is still the one on the card");
    assert.deepEqual(second.versions || [], [], "and no duplicate version was published");
    const approvedBytes = readFileSync(join(reuseWorkdir, String(card), approved), "utf8").trim();
    assert.match(approvedBytes, /made by an earlier run/, "the approved bytes are untouched");
  } finally {
    stopServer(reuse);
  }
});

test("kept versions survive a restart, and a card that is generating refuses to be rewound", async () => {
  const before = (await workspace()).nodes[filmId];
  assert.ok(before.versions?.length, "there is a version to check");

  stopServer(app);
  await new Promise(r => setTimeout(r, 300));
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "0" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);

  const reopened = (await workspace()).nodes[filmId];
  assert.equal(reopened.versions.length, before.versions.length, "the alternative versions are still there after reopening");
  for (const version of reopened.versions) {
    assert.ok(version.file && existsSync(join(workdir, String(filmId), version.file)), `version ${version.id} still has its file`);
    assert.ok(version.sources[0].file, `version ${version.id} still names its material copy`);
  }

  // A run in flight must not be rewound underneath itself: it would publish a
  // result the person had just navigated away from.
  await call("PATCH", "/api/node", { id: filmId, prompt: "slow again" });
  await call("POST", "/api/generate", { id: filmId });
  for (let i = 0; i < 60 && (await workspace()).nodes[filmId].status !== "running"; i++) await new Promise(r => setTimeout(r, 100));
  const refused = await fetch(`http://127.0.0.1:${port}/api/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: filmId, version: reopened.versions[0].id }) });
  assert.equal(refused.status, 409, "a card that is generating is not rewound underneath the agent");
  assert.match((await refused.json()).error, /generating/i, "the refusal says why, rather than silently doing nothing");
  const finished = await settle(filmId);
  assert.equal(finished.status, "idle");
  assert.ok(finished.versions.length >= reopened.versions.length + 1, "the finished run kept the film it replaced");
});

// The other side of the same rule. A deterministic renderer - same poster, same
// text, fixed frame count - really can produce identical bytes twice. That is a
// second result, not a stale file, and refusing it would make the canvas look
// broken to anyone whose output reproduces exactly. So the rule is "was this file
// written", not "did its bytes change"; this test fails if the check ever drifts
// back to comparing content.
test("a run that really renders again is accepted even when the bytes are identical", async () => {
  const echoAgent = join(base, "echo-agent.mjs");
  const echoBin = join(base, "echo-codex");
  writeFileSync(echoAgent, `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR;
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
writeFileSync(join(dir, "still.png"), "a deterministic frame");
if (out) writeFileSync(out, JSON.stringify({ prompt: "p", script: null, artifact: "still.png", type: "image", method: "remotion", error: null }));
`);
  writeFileSync(echoBin, `#!/bin/sh\nexec node ${JSON.stringify(echoAgent)} "$@"\n`);
  chmodSync(echoBin, 0o755);
  const echoPort = await freePort(), echoWorkdir = join(base, "echo-ws");
  const echo = startServer({ cwd: root, port: echoPort, env: { CODEX_BIN: echoBin, HYPERMAKER_WORKDIR: echoWorkdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  echo.stderr.on("data", c => process.stderr.write(c));
  await waitReady(echoPort);
  const api = (method, path, payload) => fetch(`http://127.0.0.1:${echoPort}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
  const ws = () => fetch(`http://127.0.0.1:${echoPort}/api/workspace`).then(r => r.json());
  const wait = async id => { for (let i = 0; i < 200; i++) { const n = (await ws()).nodes[id]; if (n.status !== "running") return n; await new Promise(r => setTimeout(r, 100)); } };

  try {
    const card = Number(Object.keys((await api("POST", "/api/node", { x: 0, y: 0, type: "image", method: "remotion", prompt: "first" })).nodes).at(-1));
    await api("POST", "/api/generate", { id: card });
    const first = await wait(card);
    assert.equal(first.error, null, `the first run rendered, got ${first.error}`);

    // No pause, and the same bytes by construction.
    await api("POST", "/api/generate", { id: card });
    const second = await wait(card);
    assert.equal(second.status, "idle", `a real second render is a result, got ${second.error}`);
    assert.equal(second.versions.length, 1, "and the render it replaced is kept");
    assert.notEqual(second.artifact, second.versions[0].file, "the two renders have separate files");
    assert.equal(readFileSync(join(echoWorkdir, String(card), second.artifact), "utf8"), readFileSync(join(echoWorkdir, String(card), second.versions[0].file), "utf8"), "with identical bytes, which is why content cannot decide this");
  } finally {
    stopServer(echo);
  }
});
