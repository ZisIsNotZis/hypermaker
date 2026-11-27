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
  assert.match(node.artifact, /note\.txt$/, JSON.stringify(node));
  // The agent works in an attempt directory of its own, which is dropped after a
  // successful run - so the record of what was invoked is kept with the card. It is
  // the file a person reads when a result is not what they expected.
  const recorded = JSON.parse(readFileSync(join(workdir, String(id), "codex-command.json"), "utf8"));
  const argv = recorded.args;
  assert.deepEqual(argv.slice(0, 4), ["exec", "--json", "--output-last-message", join(workdir, String(id), "codex-final.json")],
    `a real codex CLI is invoked as \`codex exec --json ...\`, got ${JSON.stringify(argv.slice(0, 4))}`);
  assert.ok(argv.includes("--ephemeral") && argv.includes("--skip-git-repo-check"), "the flags the real CLI documents are passed");
  assert.equal(argv[argv.indexOf("--model") + 1], "gpt-5.6-luna");
  // The prompt is the CLI's last argument in reality; it is excluded from the record
  // on purpose (it is long and lives in prompt.txt), so the assembled instruction is
  // checked where it is actually stored.
  assert.ok(argv.length >= 10, `the recorded arguments are the real ones, got ${JSON.stringify(argv)}`);
  assert.match(readFileSync(join(workdir, String(id), "prompt.txt"), "utf8"), /# USER PROMPT/, "the instruction the run was given is on disk next to the card");
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
  const startedAt = () => (async () => { const n = (await workspace(p)).nodes[id]; return n.attempt ? join(n.attempt, "argv.json") : null; })();
  let started = null;
  for (let i = 0; i < 60; i++) { const candidate = await startedAt(); if (candidate && existsSync(candidate)) { started = candidate; break; } await new Promise(r => setTimeout(r, 50)); }
  assert.ok(started, "the first run is really in progress");
  const second = await post(p, "/api/generate", { id });
  assert.equal(second.status, 409, "the second request is refused");
  assert.match(second.error, /already generating/i);
  const node = await until(p, id, n => n.artifact || n.error);
  assert.match(node.artifact, /note\.txt$/);
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
  // Starting a run adopts a card from before publishing existed onto a name the
  // agent cannot write over (`versions/v1-note.txt`), and moves the card there. So
  // the earlier film is asked for by whatever the card now says, not by the old
  // path: `note.txt` is the name the stand-in agent writes, and a stopped run must
  // not be able to take the film the person was looking at.
  const onCard = (await workspace(p)).nodes[id].artifact;
  assert.match(onCard, /note\.txt$/, "the earlier artifact is on the card before the new run starts");
  await post(p, "/api/generate", { id });
  assert.equal((await workspace(p)).nodes[id].status, "running");
  // Wait until the agent has really started and its grandchild is alive. An
  // immediate Stop killed the process before it spawned anything, so the orphan
  // check below had nothing to find and passed without proving anything.
  // The agent works in the attempt directory the card reports, not in the card's own
  // directory: that separation is what keeps a creator's files out of its reach.
  let marker = null;
  for (let i = 0; i < 60; i++) {
    const n = (await workspace(p)).nodes[id];
    if (n.attempt && existsSync(join(n.attempt, "grandchild.txt"))) { marker = join(n.attempt, "grandchild.txt"); break; }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(marker, "the stand-in agent and its grandchild are running before Stop is pressed");
  const stopped = await post(p, "/api/cancel", { id });
  assert.equal(stopped.status, 200, JSON.stringify(stopped));
  const node = await until(p, id, n => n.status !== "running", 40);
  assert.equal(node.status, "cancelled", `stopped card reports cancelled, got ${JSON.stringify(node)}`);
  assert.match(node.error, /stopped/i);
  assert.match(node.artifact, /note\.txt$/, "the artifact from the earlier run is still the card's artifact");
  assert.match(node.artifact, /^versions\//, "and it lives where the agent renders nothing");
  assert.equal(readFileSync(join(workdir, String(id), node.artifact), "utf8"), "first run\n", "the bytes on the card are still the earlier run's, not the stopped attempt's");
  assert.equal(existsSync(join(workdir, String(id), "note.txt")), false, "and the stopped attempt left nothing at the name the next run will use");
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
  let started = null;
  for (let i = 0; i < 60; i++) { const n = (await workspace(p)).nodes[id]; const candidate = n.attempt && join(n.attempt, "argv.json"); if (candidate && existsSync(candidate)) { started = candidate; break; } await new Promise(r => setTimeout(r, 50)); }
  assert.ok(started, "the run is in progress when the server dies");
  stopServer(app); await new Promise(r => setTimeout(r, 300));
  const q = await nextPort();
  start(q, workdir, {}); await ready(q);
  const node = (await workspace(q)).nodes[id];
  assert.equal(node.status, "error", `an interrupted run must not come back as idle, got ${JSON.stringify(node)}`);
  assert.match(node.error, /interrupted/i);
  assert.equal(node.artifact, null);
});

test("an agent that could not finish reaches the card with its own reason", async () => {
  // A real run answered with a null artifact and the sentence "no browser
  // executable is installed". The card said "final output is not artifact JSON",
  // which hides the one message a person can act on.
  const workdir = fresh(), p = await nextPort();
  start(p, workdir, { AGENT_MODE: "cannot" }); await ready(p);
  const id = Object.keys((await post(p, "/api/node", { x: 0, y: 0, type: "text", method: "llm", prompt: "hi" })).nodes).at(-1);
  await post(p, "/api/generate", { id });
  const node = await until(p, id, n => n.status !== "running");
  assert.equal(node.status, "error", `an agent that produced nothing did not succeed, got ${JSON.stringify(node)}`);
  assert.match(node.error, /no browser executable is installed/, `the agent's own reason is on the card, got ${node.error}`);
  assert.doesNotMatch(node.error, /not artifact JSON/, "and it is not replaced by a parser complaint");
  assert.equal(node.artifact, null, "no artifact is claimed");
});
