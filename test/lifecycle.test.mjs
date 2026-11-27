// The generation lifecycle as a person experiences it: one run at a time, a Stop
// that really stops, and a card that never pretends a failed or interrupted run
// produced what is still on screen. No model is called; the stand-in agent
// (test/fake-agent.mjs) is slow, fails, or leaves a grandchild behind on purpose.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort, startServer, stopServer, stopAll, waitReady } from "./server.mjs";

const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-lifecycle-"));
const bin = join(base, "agent");
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(root, "test/fake-agent.mjs"))} "$@"\n`); chmodSync(bin, 0o755);

// Ports come from the OS and servers are torn down by process group, so a test
// that dies mid-run cannot leave a server that answers the next one.
const apps = [];
function start(port, workdir, env = {}) {
  const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "0", ...env } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  apps.push(app);
  return app;
}
const ready = waitReady;
const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
const workspace = port => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
// POST /api/node creates a node, PATCH /api/node edits one; the canvas uses the
// same split, so the test keeps it explicit instead of guessing from the body.
const patch = (port, body) => fetch(`http://127.0.0.1:${port}/api/node`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
async function until(port, id, done, tries = 100) {
  let node;
  for (let i = 0; i < tries; i++) { node = (await workspace(port)).nodes[id]; if (done(node)) return node; await new Promise(r => setTimeout(r, 100)); }
  return node;
}
after(async () => { for (const app of apps) stopServer(app); stopAll(); });

const nextPort = freePort;
const fresh = () => mkdtempSync(join(base, "ws-"));

test("the adapter speaks the codex exec contract the real CLI accepts", async () => {
  const workdir = fresh(), p = await nextPort();
  start(p, workdir, { AGENT_MODE: "ok", AGENT_DELAY: "10" }); await ready(p);
  const created = await post(p, "/api/node", { x: 0, y: 0, type: "text", method: "llm", prompt: "hi" });
  const id = Object.keys(created.nodes).at(-1);
  await post(p, "/api/generate", { id, model: "gpt-5.6-luna", effort: "low" });
  const node = await until(p, id, n => n.artifact || n.error);
  assert.equal(node.artifact, "note.txt", JSON.stringify(node));
  const argv = JSON.parse(readFileSync(join(workdir, String(id), "argv.json"), "utf8"));
  assert.deepEqual(argv.slice(0, 4), ["exec", "--json", "--output-last-message", join(workdir, String(id), "codex-final.json")],
    `a real codex CLI is invoked as \`codex exec --json ...\`, got ${JSON.stringify(argv.slice(0, 4))}`);
  assert.ok(argv.includes("--ephemeral") && argv.includes("--skip-git-repo-check"), "the flags the real CLI documents are passed");
  assert.equal(argv[argv.indexOf("--model") + 1], "gpt-5.6-luna");
  assert.equal(argv.at(-1).includes("# USER PROMPT"), true, "the assembled prompt is the last argument");
});

test("a second Generate on a running card is refused instead of starting a second process", async () => {
  const workdir = fresh(), p = await nextPort();
  start(p, workdir, { AGENT_MODE: "slow", AGENT_DELAY: "1500" }); await ready(p);
  const id = Object.keys((await post(p, "/api/node", { x: 0, y: 0, type: "text", method: "llm", prompt: "hi" })).nodes).at(-1);
  const first = await post(p, "/api/generate", { id });
  assert.equal(first.status, 202);
  assert.equal((await workspace(p)).nodes[id].status, "running");
  // The agent records its argv the moment it starts; waiting for that file makes
  // "a second Generate while the first is running" a real overlap, not a race
  // where the first run might already have finished.
  const started = join(workdir, String(id), "argv.json");
  for (let i = 0; i < 60 && !existsSync(started); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(existsSync(started), true, "the first run is really in progress");
  const second = await post(p, "/api/generate", { id });
  assert.equal(second.status, 409, "the second request is refused");
  assert.match(second.error, /already generating/i);
  const node = await until(p, id, n => n.artifact || n.error);
  assert.equal(node.artifact, "note.txt");
  assert.equal(node.error, null);
});

test("Stop ends the run, kills its whole process tree, and keeps the previous artifact", async () => {
  const workdir = fresh(), p = await nextPort();
  start(p, workdir, { AGENT_MODE: "tree", AGENT_DELAY: "5000" }); await ready(p);
  const id = Object.keys((await post(p, "/api/node", { x: 0, y: 0, type: "text", method: "llm", prompt: "hi" })).nodes).at(-1);
  // A previous good artifact, so "keeps the previous artifact" is a real question.
  mkdirSync(join(workdir, String(id)), { recursive: true });
  writeFileSync(join(workdir, String(id), "note.txt"), "first run\n");
  await patch(p, { id, artifact: "note.txt" });
  assert.equal((await workspace(p)).nodes[id].artifact, "note.txt", "the earlier artifact is on the card before the new run starts");
  await post(p, "/api/generate", { id });
  assert.equal((await workspace(p)).nodes[id].status, "running");
  // Wait until the agent has really started and its grandchild is alive. An
  // immediate Stop killed the process before it spawned anything, so the orphan
  // check below had nothing to find and passed without proving anything.
  const marker = join(workdir, String(id), "grandchild.txt");
  for (let i = 0; i < 60 && !existsSync(marker); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(existsSync(marker), true, "the stand-in agent and its grandchild are running before Stop is pressed");
  const stopped = await post(p, "/api/cancel", { id });
  assert.equal(stopped.status, 200, JSON.stringify(stopped));
  const node = await until(p, id, n => n.status !== "running", 40);
  assert.equal(node.status, "cancelled", `stopped card reports cancelled, got ${JSON.stringify(node)}`);
  assert.match(node.error, /stopped/i);
  assert.equal(node.artifact, "note.txt", "the artifact from the earlier run is still the card's artifact");
  assert.equal(readFileSync(join(workdir, String(id), "note.txt"), "utf8"), "first run\n", "and it was not overwritten");
  // The grandchild lives in the agent's process group and keeps rewriting its
  // marker. Clearing the marker after the Stop and looking again is the honest
  // question: did anything survive to write it back?
  await rmSync(marker, { force: true });
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(existsSync(marker), false, "no orphaned agent process kept working after Stop");
  // A stopped card can be generated again, and that run can be stopped again.
  assert.equal((await post(p, "/api/generate", { id })).status, 202);
  assert.equal((await post(p, "/api/cancel", { id })).status, 200);
});

test("a failed run is reported, is not mistaken for a result, and survives reopening", async () => {
  const workdir = fresh(), p = await nextPort();
  const app = start(p, workdir, { AGENT_MODE: "fail" }); await ready(p);
  const id = Object.keys((await post(p, "/api/node", { x: 0, y: 0, type: "text", method: "llm", prompt: "hi" })).nodes).at(-1);
  await post(p, "/api/generate", { id });
  const node = await until(p, id, n => n.status !== "running");
  assert.equal(node.status, "error");
  // The exit code alone does not tell a person what to fix; the CLI's own last
  // error message is right there in codex.jsonl and is what they need to see.
  assert.match(node.error, /exited with code 3/);
  assert.match(node.error, /the agent could not finish/, "the agent's own last error is quoted on the card");
  assert.equal(node.artifact, null, "no artifact is claimed");
  assert.match(readFileSync(join(workdir, "workspace.yml"), "utf8"), /error: "Codex exited with code 3: the agent could not finish"/, "the failure and its reason are on disk, not only in memory");
  // Reopen: the same way a person restarts the app and looks at the card again.
  stopServer(app); await new Promise(r => setTimeout(r, 200));
  const q = await nextPort();
  start(q, workdir, { AGENT_MODE: "fail" }); await ready(q);
  const reopened = (await workspace(q)).nodes[id];
  assert.equal(reopened.status, "error", `after restart the card still shows the failure, got ${JSON.stringify(reopened)}`);
  assert.match(reopened.error, /exited with code 3: the agent could not finish/);
});

test("editing a card cannot rewrite its run outcome, and a clone starts clean", async () => {
  const workdir = fresh(), p = await nextPort();
  start(p, workdir, { AGENT_MODE: "fail" }); await ready(p);
  const id = Object.keys((await post(p, "/api/node", { x: 0, y: 0, type: "text", method: "llm", prompt: "hi" })).nodes).at(-1);
  await post(p, "/api/generate", { id });
  await until(p, id, n => n.status !== "running");
  // A prompt edit that also claims a status must not be believed.
  await patch(p, { id, prompt: "edited", status: "idle", error: null });
  const node = (await workspace(p)).nodes[id];
  assert.equal(node.prompt, "edited", "the edit itself is applied");
  assert.equal(node.status, "error", "the recorded outcome is not the client's to overwrite");
  assert.match(node.error, /exited with code 3/);
  // A clone is a new card with nothing run yet, even if the source failed.
  const clone = Object.keys((await post(p, "/api/clone", { id })).nodes).at(-1);
  assert.equal((await workspace(p)).nodes[clone].status, "draft", "a cloned card starts as a draft, not as the source's failure");
  assert.equal((await workspace(p)).nodes[clone].error, null);
  assert.equal((await workspace(p)).nodes[clone].artifact, null);
});

test("a missing Codex CLI is reported as something a person can act on", async () => {
  // The most likely first run: the app is installed, the agent is not. `spawn
  // codex ENOENT` says nothing useful, so the card must name the missing binary
  // and the one setting that points at it.
  const workdir = fresh(), p = await nextPort();
  start(p, workdir, { CODEX_BIN: join(base, "definitely-not-installed") }); await ready(p);
  const id = Object.keys((await post(p, "/api/node", { x: 0, y: 0, type: "text", method: "llm", prompt: "hi" })).nodes).at(-1);
  await post(p, "/api/generate", { id });
  const node = await until(p, id, n => n.status !== "running");
  assert.equal(node.status, "error");
  assert.match(node.error, /Codex CLI/i, `the message names what is missing, got ${node.error}`);
  assert.match(node.error, /CODEX_BIN/, "and names the setting that points at it");
  assert.doesNotMatch(node.error, /ENOENT/, "a bare errno is not an answer for a person");
});

test("a run interrupted by the server shutting down is not left looking idle", async () => {
  const workdir = fresh(), p = await nextPort();
  const app = start(p, workdir, { AGENT_MODE: "slow", AGENT_DELAY: "6000" }); await ready(p);
  const id = Object.keys((await post(p, "/api/node", { x: 0, y: 0, type: "text", method: "llm", prompt: "hi" })).nodes).at(-1);
  await post(p, "/api/generate", { id });
  assert.equal((await workspace(p)).nodes[id].status, "running");
  const started = join(workdir, String(id), "argv.json");
  for (let i = 0; i < 60 && !existsSync(started); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(existsSync(started), true, "the run is in progress when the server dies");
  stopServer(app); await new Promise(r => setTimeout(r, 300));
  const q = await nextPort();
  start(q, workdir, {}); await ready(q);
  const node = (await workspace(q)).nodes[id];
  assert.equal(node.status, "error", `an interrupted run must not come back as idle, got ${JSON.stringify(node)}`);
  assert.match(node.error, /interrupted/i);
  assert.equal(node.artifact, null);
});
