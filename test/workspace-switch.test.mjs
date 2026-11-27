import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort, modesNotEnforced, startServer, stopAll, stopServer, waitReady } from "./server.mjs";
import { readWorkspace, writeWorkspace } from "../server/workspace.mjs";

// Two workspaces open in turn while a run is still going. Node ids are per workspace,
// so "card 1" is a different card in each of them. Three things were wrong on the
// previous commit and all three are the same mistake - treating a live run as a
// property of the process and of a bare node id rather than of its own workspace:
//
//   1. A run finishing while another workspace was open wrote its artifact, prompt and
//      sources into the *other* workspace's card with the same id. Found by the
//      canvas-protection test on that commit (the new, empty card inherited a 65 MiB
//      notice and then the other workspace's outcome), and reproduced by a supervisor
//      as "A's result landed in B".
//   2. Opening B made B's card 1 look like it was generating, because `running` was
//      keyed by the id alone: B's Generate was refused with "already generating".
//   3. Coming back to A mid-run then made A's own live card look interrupted - the
//      record on disk says `running`, and the open path took that to mean the process
//      had died.
//
// The stand-in agent blocks until *its own* release file exists, and each test gets a
// fresh one. A single shared release file made the first version of this file pass
// against the old server: writing it at the top of a test let the previous test's
// blocked agent finish early, so the two runs never actually overlapped. Every
// assertion below therefore depends on a real overlap, not on being fast enough.
const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-ws-switch-")), bin = join(base, "codex");
const started = join(base, "started");
const alpha = join(base, "alpha"), beta = join(base, "beta");
const SLOW = "Slow workspace Alpha", FAST = "Fast workspace Beta";

// Written as an explicit line list: an earlier revision of this idea used nested
// template literals, where every backslash had two layers of escaping to get wrong.
writeFileSync(join(base, "agent.mjs"), [
  'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'const dir = process.env.HYPERMAKER_NODE_DIR;',
  'const prompt = readFileSync(join(dir, "prompt.txt"), "utf8");',
  `const slow = prompt.includes(${JSON.stringify(SLOW)});`,
  '// The gate is named by a hash of this run\'s own instruction, so two tests can',
  '// never release each other\'s agent: a single shared gate file made the third test',
  '// below silently stop blocking after the second one released its run.',
  '// Keyed by the instruction, which is what a test has in hand: the whole assembled',
  '// prompt includes paths and quality text, so hashing all of it never matched the',
  '// name a test computed and the gate silently stayed shut.',
  'const asked = prompt.slice(prompt.lastIndexOf("# USER PROMPT") + 13).trim().split("\\n")[0];',
  'const gate = process.env.HYPERMAKER_TEST_RELEASE_DIR + "/release-" + [...asked].reduce((a, c) => a + c.charCodeAt(0), 0) + ".txt";',
  `if (slow) { writeFileSync(${JSON.stringify(started)}, "started");`,
  '  for (let i = 0; i < 600 && !existsSync(gate); i++) await new Promise(r => setTimeout(r, 50)); }',
  `writeFileSync(join(dir, "result.txt"), slow ? ${JSON.stringify(SLOW)} : ${JSON.stringify(FAST)});`,
  'const out = process.argv[process.argv.indexOf("--output-last-message") + 1];',
  'writeFileSync(out, JSON.stringify({ prompt: slow ? "slow" : "fast", script: null, artifact: "result.txt", type: "text", method: "llm", error: null }));',
  ''
].join("\n"));
writeFileSync(bin, `#!/bin/sh\nHYPERMAKER_TEST_RELEASE_DIR=${JSON.stringify(base)} exec node ${JSON.stringify(join(base, "agent.mjs"))} "$@"\n`);
chmodSync(bin, 0o755);
// The same name the stand-in agent computes, so a test releases exactly the run it
// means to and nothing else.
const gate = prompt => join(base, `release-${[...prompt].reduce((a, c) => a + c.charCodeAt(0), 0)}.txt`);

let app, port;
before(async () => {
  port = await freePort();
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: beta, HYPERMAKER_RESET_WORKSPACE: "1" } });
  const chunks = [];
  app.stdout.on("data", c => chunks.push(c.toString()));
  app.stderr.on("data", chunk => chunks.push(chunk.toString()));
  app.log = () => chunks.join("");
  await waitReady(port);
});
after(async () => { for (const prompt of [SLOW, `${SLOW} again`]) writeFileSync(gate(prompt), "release"); stopServer(app); stopAll(); });

const call = (path, body) => fetch(`http://127.0.0.1:${port}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const open = async workdir => { const r = await call("workspace", { workdir }); assert.equal(r.status, 200, `opened ${workdir}`); return r.body; };
const card = async prompt => {
  const before = new Set(Object.keys((await call("workspace")).body.nodes).map(Number));
  const r = await call("node", { x: 70, y: 60, type: "text", method: "llm", prompt });
  return Object.keys(r.body.nodes).map(Number).find(id => !before.has(id));
};
const state = async () => (await call("workspace")).body.nodes[1];
async function until(fn, what, tries = 400) {
  for (let i = 0; i < tries; i++) { const r = await fn(); if (r) return r; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`waited for ${what} and never saw it`);
}
const publishedIn = (workdir, file = "v1-result.txt") => existsSync(join(workdir, "1", "versions", file));

// The ordinary way anyone starts this app: `npm start` against a workspace that already
// has cards in it. The live-run tables are keyed by workspace and card, and that key was
// first declared further down the module than the module-load `adopt()` that uses it -
// so a workspace with cards threw `Cannot access 'slot' before initialization` and the
// server exited, while an empty workspace skipped the loop and started fine. Every test
// that opened a workspace from scratch was exactly the case that could not catch it.
// This one is a separate process pointed at cards that already exist.
test("the server starts against a workspace that already has cards", async () => {
  const existing = join(base, "existing");
  mkdirSync(join(existing, "1", "versions"), { recursive: true });
  writeFileSync(join(existing, "1", "versions", "v1-note.txt"), "a take made earlier\n");
  writeFileSync(join(existing, "workspace.yml"), [
    "1:", "  x: 40", "  y: 40", "  inputs: []", "  type: text", "  method: llm",
    '  prompt: "a take"', "  quality: standard", '  artifact: versions/v1-note.txt', "  status: idle", ""
  ].join("\n"));
  const existingPort = await freePort();
  const existingApp = startServer({ cwd: root, port: existingPort, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: existing, HYPERMAKER_RESET_WORKSPACE: "0" } });
  const log = [];
  existingApp.stdout.on("data", c => log.push(c.toString()));
  existingApp.stderr.on("data", c => log.push(c.toString()));
  try {
    await waitReady(existingPort);
    const opened = await fetch(`http://127.0.0.1:${existingPort}/api/workspace`).then(r => r.json());
    assert.equal(opened.nodes["1"].artifact, "versions/v1-note.txt", "the card and the take it points at are there");
    assert.equal(opened.nodes["1"].status, "idle");
    // The file is served, not just recorded: a reopen is only useful if the take plays.
    const file = await fetch(`http://127.0.0.1:${existingPort}/api/file?path=${encodeURIComponent(join(existing, "1", "versions", "v1-note.txt"))}`);
    assert.equal(file.status, 200);
    assert.match(await file.text(), /a take made earlier/);
  } catch (error) {
    throw new Error(`${error.message}\nserver said: ${log.join("")}`);
  } finally {
    stopServer(existingApp);
  }
});

// A person mistyping a path - a file where a folder was meant - must not cost a
// restart. Opening a workspace was serialised through one stored promise, and the
// rejected promise stayed stored, so every later open failed without even looking at
// its path. Reproduced by a supervisor: the wrong path answered 400 (correct), the
// current workspace was still intact (correct), and the corrected path also failed
// until the server was restarted (wrong).
//
// It runs on a server of its own: the tests below depend on which card ids exist in
// the shared workspace, and a test that adds a card would renumber them.
test("a failed open leaves the current workspace intact and the next open still works", async () => {
  const workspaceA = join(base, "retry-a"), elsewhere = join(base, "retry-b");
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(workspaceA, "workspace.yml"), [
    "1:", "  x: 40", "  y: 40", "  inputs: []", "  type: text", "  method: llm",
    '  prompt: "a card in A"', "  quality: standard", "  status: draft", ""
  ].join("\n"));
  const retryPort = await freePort();
  const retryApp = startServer({ cwd: root, port: retryPort, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workspaceA, HYPERMAKER_RESET_WORKSPACE: "0" } });
  const log = [];
  retryApp.stderr.on("data", c => log.push(c.toString()));
  const api = (path, body) => fetch(`http://127.0.0.1:${retryPort}/api/${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  try {
    await waitReady(retryPort);
    assert.equal((await api("workspace")).body.nodes["1"].prompt, "a card in A", "A is open before the mistake");
    const note = join(base, "retry-note.txt");
    writeFileSync(note, "this is a file, not a workspace");
    const wrong = await api("workspace", { workdir: note });
    assert.equal(wrong.status, 400, "a file where a workspace was meant is refused");
    const after = await api("workspace");
    assert.equal(after.body.workdir, workspaceA, "the workspace that was open is still the open one");
    assert.equal(after.body.nodes["1"].prompt, "a card in A", "and its card is untouched");
    const corrected = await api("workspace", { workdir: elsewhere });
    assert.equal(corrected.status, 200, `the corrected path opens without restarting the server, got ${corrected.status}: ${corrected.body.error || ""}`);
    assert.equal(corrected.body.workdir, elsewhere);
    // The failure must not leave the chain poisoned either: a second wrong path still
    // fails, and a second right one still works.
    assert.equal((await api("workspace", { workdir: note })).status, 400);
    assert.equal((await api("workspace", { workdir: workspaceA })).status, 200);
  } catch (error) {
    throw new Error(`${error.message}\nserver said: ${log.join("")}`);
  } finally {
    stopServer(retryApp);
  }
});

// Opening a directory that cannot be written must fail without disturbing the canvas
// that is open. A person who picks a folder they cannot write should be told, and should
// still be looking at the cards they had - not at a canvas labelled with a workspace it
// never opened.
//
// Like the retry test above, it runs on a server of its own: the shared workspace's card
// ids are what the tests below navigate by.
test("a workspace that cannot be written is refused and the open canvas is untouched", async t => {
  // Root ignores the mode; a filesystem that ignores chmod looks identical from here and
  // used to fail this test on code that was right. See `modesNotEnforced` in server.mjs.
  if (process.getuid && process.getuid() === 0) return t.skip("running as root, which ignores the mode");
  const unchecked = modesNotEnforced();
  if (unchecked) return t.skip(unchecked);
  const here = join(base, "readonly-here"), readonly = join(base, "readonly-target");
  mkdirSync(here, { recursive: true });
  mkdirSync(readonly, { recursive: true });
  writeFileSync(join(here, "workspace.yml"), [
    "1:", "  x: 40", "  y: 40", "  inputs: []", "  type: text", "  method: llm",
    '  prompt: "a card I already have"', "  quality: standard", "  status: draft", ""
  ].join("\n"));
  chmodSync(readonly, 0o500); // read and enter, no write
  const roPort = await freePort();
  const roApp = startServer({ cwd: root, port: roPort, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: here, HYPERMAKER_RESET_WORKSPACE: "0" } });
  const api = (path, body) => fetch(`http://127.0.0.1:${roPort}/api/${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  try {
    await waitReady(roPort);
    const before = await api("workspace");
    assert.equal(before.body.nodes["1"].prompt, "a card I already have");
    const refused = await api("workspace", { workdir: readonly });
    assert.equal(refused.status, 400, `a directory that cannot be written is refused, got ${refused.status}`);
    const after = await api("workspace");
    assert.equal(after.body.workdir, here, "the workspace that was open is still the open one");
    assert.equal(after.body.nodes["1"].prompt, "a card I already have", "and it still holds the card it had");
  } finally {
    chmodSync(readonly, 0o700);
    stopServer(roApp);
  }
});

// A run can finish while its workspace is being opened - recovery is real work. The
// supervisor's case: B had one run still going and one interrupted run to recover, so
// the open took long enough for the live one to finish. The bytes were on disk and
// neither the canvas nor the saved record said so: the opener had read the graph before
// the outcome existed and then saved that snapshot over it. Now every write to a
// workspace's file is queued, and an open waits for the writes already queued for it, so
// its reply is the finished state.
test("a run that finishes while its workspace is being opened is visible afterwards", async () => {
  const holding = join(base, "holding");
  mkdirSync(holding, { recursive: true });
  const live = join(base, "live-ws"), slowBin = join(base, "slow-codex");
  // This agent blocks until its gate appears, so the test decides when it finishes.
  const gateFile = join(base, "live-gate.txt");
  writeFileSync(join(base, "slow-agent.mjs"), [
    'import { existsSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const dir = process.env.HYPERMAKER_NODE_DIR;',
    `for (let i = 0; i < 1200 && !existsSync(${JSON.stringify(gateFile)}); i++) await new Promise(r => setTimeout(r, 4));`,
    'writeFileSync(join(dir, "result.txt"), "finished during the open");',
    'const out = process.argv[process.argv.indexOf("--output-last-message") + 1];',
    'writeFileSync(out, JSON.stringify({ prompt: "live", script: null, artifact: "result.txt", type: "text", method: "llm", error: null }));',
    ''
  ].join("\n"));
  writeFileSync(slowBin, `#!/bin/sh\nexec node ${JSON.stringify(join(base, "slow-agent.mjs"))} "$@"\n`);
  chmodSync(slowBin, 0o755);
  const livePort = await freePort();
  const liveApp = startServer({ cwd: root, port: livePort, env: { CODEX_BIN: slowBin, HYPERMAKER_WORKDIR: live, HYPERMAKER_RESET_WORKSPACE: "1" } });
  const log = [];
  liveApp.stderr.on("data", c => log.push(c.toString()));
  const api = (path, body) => fetch(`http://127.0.0.1:${livePort}/api/${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  try {
    await waitReady(livePort);
    await api("node", { x: 40, y: 40, type: "text", method: "llm", prompt: "live" });
    assert.equal((await api("generate", { id: 1 })).status, 202);
    // Leave this workspace, so the finishing run is writing into a workspace that is not
    // the open one - that is the path where the open's own save used to overwrite it.
    await api("workspace", { workdir: holding });
    // Give the second card a lot to restore, so opening the workspace takes real time.
    mkdirSync(join(live, "2"), { recursive: true });
    writeFileSync(join(live, "2", "material.bin"), Buffer.alloc(48 * 1024 * 1024, 3));
    writeFileSync(join(live, "2", "versions"), "");
    rmSync(join(live, "2", "versions"), { force: true });
    writeFileSync(join(live, "workspace.yml"), readFileSync(join(live, "workspace.yml"), "utf8") + ["2:", "  x: 300", "  y: 40", "  inputs: []", "  type: text", "  method: llm", '  prompt: "to recover"', "  quality: standard", "  status: running", ""].join("\n"));
    const { beginRun, guardCard, guardName, runMarker } = await import("../server/runs.mjs");
    const attempt = beginRun(live, 2);
    await guardCard(join(live, "2"), join(attempt, guardName));
    assert.ok(existsSync(join(live, "2", runMarker)), "the second card looks like an interrupted run");

    // Start the open, then let the live run finish inside its window.
    const opening = api("workspace", { workdir: live });
    await new Promise(r => setTimeout(r, 60));
    writeFileSync(gateFile, "go");
    const opened = await opening;
    assert.equal(opened.status, 200, `the open completed, got ${opened.status}: ${opened.body.error || ""}`);
    const onDisk = readWorkspace(live)["1"];
    // The open's own reply, the saved record and the canvas must all agree with the file
    // that is on disk - that is the whole claim of this test.
    assert.equal(onDisk.artifact, "versions/v1-result.txt", "the finished take is in the saved record");
    assert.equal(onDisk.status, "idle", "and the card is no longer marked running");
    assert.equal(opened.body.nodes["1"].artifact, "versions/v1-result.txt", "the open's reply shows the finished take");
    const now = await api("workspace");
    assert.equal(now.body.nodes["1"].artifact, "versions/v1-result.txt", "and so does the canvas afterwards");
    assert.equal(readFileSync(join(live, "1", "versions", "v1-result.txt"), "utf8"), "finished during the open");
  } catch (error) {
    throw new Error(`${error.message}\nserver said: ${log.join("")}`);
  } finally {
    writeFileSync(gateFile, "go");
    stopServer(liveApp);
  }
});

test("a run belongs to its own workspace: another workspace's card neither inherits it nor blocks it", async () => {
  // B first, so B has a card of its own before anything else.
  assert.equal(await card(FAST), 1, "B's first card is #1, the id A's card will also have");
  await open(alpha);
  assert.equal(await card(SLOW), 1, "A's first card is #1 too");

  const press = await call("generate", { id: 1 });
  assert.equal(press.status, 202, `A's press was accepted, got ${press.status}: ${press.body.error || ""}`);
  await until(() => existsSync(started), "A's agent to start");
  // A's run is genuinely blocked here: nothing released it, and its take does not exist.
  assert.equal(publishedIn(alpha), false, "A's run is still in flight while B is opened");

  await open(beta);
  assert.equal((await state()).status, "draft", "opening B does not show A's run on B's card");
  const bPress = await call("generate", { id: 1 });
  assert.equal(bPress.status, 202, `B's own card can generate while A is running, got ${bPress.status}: ${bPress.body.error || ""}`);
  const bDone = await until(async () => { const n = await state(); return n.artifact ? n : null; }, "B's card to finish");
  assert.equal(bDone.artifact, "versions/v1-result.txt");
  assert.equal(readFileSync(join(beta, "1", "versions", "v1-result.txt"), "utf8"), FAST, "B's take is made from B's card");
  // B's own card is not carrying A's run: no version was made for it from A's material.
  assert.equal(bDone.prompt, FAST);
});

test("a run that finishes while another workspace is open lands in its own workspace, not on the open canvas", async () => {
  // B is open and A's run is still blocked. Release it and let it finish.
  await open(beta);
  writeFileSync(gate(SLOW), "release");
  await until(() => publishedIn(alpha), "A's take to be published in A's workspace", 600);
  await new Promise(r => setTimeout(r, 300));
  const stillOpen = await state();
  assert.equal(stillOpen.prompt, FAST, "the open canvas still holds B's card");
  assert.equal(readFileSync(join(beta, "1", "versions", "v1-result.txt"), "utf8"), FAST, "and B's published take is still B's");
  assert.equal(readFileSync(join(alpha, "1", "versions", "v1-result.txt"), "utf8"), SLOW, "while A's take exists in A, made from A's card");

  await open(alpha);
  const back = await state();
  assert.equal(back.status, "idle", `A's card settled rather than being reported interrupted, got ${back.status}${back.error ? `: ${back.error}` : ""}`);
  assert.equal(back.artifact, "versions/v1-result.txt");
  assert.equal(back.prompt, SLOW, "A's card is still A's");
  assert.equal(back.error, null, "and no failure was invented for it");
});

// Opening a workspace runs recovery first: a card whose run died mid-flight has its files
// put back, which for a card holding tens of MiB is seconds. That work used to happen
// after `workdir` had already moved, so anything asking in the meantime got the *new*
// path with the *old* cards - a canvas would show A's cards labelled as B and could edit
// or generate into them. A supervisor reproduced exactly that by opening a workspace
// with an interrupted run. The window is real work, not a race: this test holds it open
// by giving the recovering card a file large enough that copying it back takes time.
test("a workspace being opened is never half-visible: the path and the cards change together", async () => {
  const withRun = join(base, "recovery");
  mkdirSync(join(withRun, "1", "versions"), { recursive: true });
  // Big enough that restoring it is measurable, small enough to stay well inside the
  // copy tier (over 64 MiB would be hardlinked and nothing would be copied back).
  writeFileSync(join(withRun, "1", "material.bin"), Buffer.alloc(48 * 1024 * 1024, 7));
  writeFileSync(join(withRun, "1", "versions", "v1-note.txt"), "B's take\n");
  writeFileSync(join(withRun, "workspace.yml"), [
    "1:", "  x: 40", "  y: 40", "  inputs: []", "  type: text", "  method: llm",
    '  prompt: "B card"', "  quality: standard", '  artifact: versions/v1-note.txt', "  status: idle", ""
  ].join("\n"));
  // A run that died mid-flight: the marker and the guard are on disk, so opening this
  // workspace has to put the card back before it can be shown. The harness's own
  // functions are used so this is the real recovery path, not a stand-in for it.
  const { beginRun, guardCard, guardName, runMarker } = await import("../server/runs.mjs");
  const attempt = beginRun(withRun, 1);
  await guardCard(join(withRun, "1"), join(attempt, guardName));
  const graph = readWorkspace(withRun);
  graph["1"].status = "running";
  writeWorkspace(withRun, graph);
  assert.ok(existsSync(join(withRun, "1", runMarker)), "there is an interrupted run to recover");

  // A is the open workspace, and it has a card with a different prompt at the same id.
  await open(alpha);
  assert.equal((await state()).prompt, SLOW, "A is open before the switch");

  // Ask for B, and while that request is still being answered, keep reading the
  // workspace from a second connection - exactly what a page with a live canvas does.
  const opening = call("workspace", { workdir: withRun });
  const seen = [];
  for (let i = 0; i < 200; i++) {
    const r = await call("workspace");
    seen.push({ workdir: r.body.workdir, prompt: r.body.nodes["1"]?.prompt });
    if (!existsSync(join(withRun, "1", runMarker))) break;
    await new Promise(r => setTimeout(r, 2));
  }
  const opened = await opening;
  assert.equal(opened.status, 200, "the switch completed");
  // Every reply in the middle must have been internally consistent: B's path with B's
  // cards, or A's path with A's cards, never the two mixed.
  const mixed = seen.filter(s => s.workdir === withRun ? s.prompt !== "B card" : s.prompt !== SLOW);
  assert.deepEqual(mixed, [], `no reply mixed one workspace's path with another's cards, got ${JSON.stringify(seen.slice(0, 5))}`);
  assert.equal(opened.body.nodes["1"].prompt, "B card", "after the switch B's cards are B's");
  assert.equal(opened.body.nodes["1"].status, "error", "and the interrupted run is reported as interrupted, not as running");
  assert.equal(readFileSync(join(withRun, "1", "material.bin")).length, 48 * 1024 * 1024, "the recovering card's own file is back");
});

test("coming back to a workspace whose run is still going can still stop that run", async () => {
  // The test above ends with its own workspace open, so start where this one is about.
  await open(alpha);
  // A second run in A, blocked again, and this time the person returns mid-run.
  // The gate stays closed: this run has to still be going when the person
  // comes back to it. `after()` opens it, so a failure here cannot leave an
  // agent waiting forever.
  const second = await call("generate", { id: 1, prompt: `${SLOW} again` });
  assert.equal(second.status, 202, `the second press started, got ${second.status}: ${second.body.error || ""}`);
  await until(async () => (await call("workspace")).body.nodes[1].status === "running", "the run to be live");
  await open(beta);
  await open(alpha);
  const live = await state();
  assert.equal(live.status, "running", "the run really is still going when the person comes back to it");
  // The card says running, so Stop has to have a target: a card that offers Stop and
  // then answers "not generating" is the failure this checks.
  const refused = await call("generate", { id: 1, prompt: `${SLOW} again` });
  assert.equal(refused.status, 409, `a second press on the live card is refused, got ${refused.status}`);
  assert.match(refused.body.error, /already generating/i);
  const stopped = await call("cancel", { id: 1 });
  assert.equal(stopped.status, 200, `Stop reaches the run this workspace started, got ${stopped.status}: ${stopped.body.error || ""}`);
  const settled = await until(async () => { const n = await state(); return n.status === "running" ? null : n; }, "the stopped card");
  assert.equal(settled.status, "cancelled", `stopped card reports cancelled, got ${settled.status}`);
  assert.equal(settled.artifact, "versions/v1-result.txt", "and the take already approved is still on the card");
});
