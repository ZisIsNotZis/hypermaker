// A creator who does not get it right first time is the normal case, not the edge
// case. Three things have to be true after every failed, stopped or interrupted
// attempt, and each of them was broken by an earlier version of this code:
//
//   1. The film they approved is still the film on the card, playable, after the
//      process is killed mid-run. Adoption used to delete the old-name file before
//      the card was saved onto the copy, so a server that stopped in that window
//      reopened onto a card pointing at a file that no longer existed.
//   2. Material they put into the card's directory themselves is still readable *at
//      the path they put it at*, after many attempts - not moved somewhere else and
//      not deleted when older attempts are cleaned up. A cleanup rule that deleted
//      or moved "files that appeared during a run" lost a person's material; no
//      timestamp can tell their file from the agent's, so the fix is to keep the
//      two in different directories rather than to guess.
//   3. Abandoned attempts are bounded, so trying fifty times does not fill a disk.
//
// All three are checked by stopping or killing the server the way a machine does,
// then reopening the same workspace - not by inspecting a helper.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-attempts-")), bin = join(base, "agent");
// Slow on purpose: "the run is in flight when the process dies" needs a run that is
// still in flight. It writes its usual filename, like a real agent and like
// fake-film-codex - which is exactly the name an old workspace keeps its film under.
writeFileSync(join(base, "agent.mjs"), `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR;
mkdirSync(dir, { recursive: true });
const asked = readFileSync(join(dir, "prompt.txt"), "utf8").split("# USER PROMPT").pop().trim();
writeFileSync(join(dir, "film.png"), "made from: " + asked);
writeFileSync(join(dir, "render-film.mjs"), "// script for: " + asked);
await new Promise(r => setTimeout(r, 900));
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (asked.includes("fail")) { console.error("render died"); process.exit(3); }
if (out) writeFileSync(out, JSON.stringify({ prompt: asked, script: "render-film.mjs", artifact: "film.png", type: "image", method: "remotion", error: null }));
`);
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(base, "agent.mjs"))} "$@"\n`); chmodSync(bin, 0o755);

const apps = [];
function start(port, workdir, extra = {}) {
  const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "0", ...extra } });
  app.stderr.on("data", c => process.stderr.write(c));
  apps.push(app);
  return app;
}
const workspace = port => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const patch = (port, body) => fetch(`http://127.0.0.1:${port}/api/node`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
async function settle(port, id) {
  for (let i = 0; i < 150; i++) {
    const n = (await workspace(port)).nodes[id];
    if (n && n.status !== "running") return n;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`node ${id} never settled`);
}
// The card's artifact is asked for through the endpoint the canvas plays it from,
// so "playable" means what it means to a person.
async function plays(port, workdir, id) {
  const n = (await workspace(port)).nodes[id];
  const r = await fetch(`http://127.0.0.1:${port}/api/file?path=${encodeURIComponent(join(workdir, String(id), n.artifact))}`);
  return { artifact: n.artifact, status: r.status, body: r.ok ? (await r.text()).slice(0, 60) : null, node: n };
}
// An old workspace: the approved film at the top of the node directory, which is
// the state every existing user is in after upgrading.
function oldWorkspace(workdir) {
  mkdirSync(join(workdir, "1"), { recursive: true });
  writeFileSync(join(workdir, "1", "film.png"), "made from: the film I approved");
  writeFileSync(join(workdir, "workspace.yml"), [
    "1:", "  x: 40", "  y: 40", "  inputs: []", "  type: image", "  method: remotion",
    '  prompt: "the film I approved"', '  promptUsed: "the film I approved"', "  quality: standard",
    '  artifact: film.png', "  status: idle", ""
  ].join("\n"));
}
after(async () => { for (const app of apps) stopServer(app); stopAll(); });

test("the film approved before publishing existed is still playable after a run is cut off by a crash", async () => {
  const workdir = join(base, "crash-ws");
  oldWorkspace(workdir);
  const port = await freePort();
  let app = start(port, workdir); await waitReady(port);

  // It plays before anything is changed: opening an old workspace reads files, it
  // does not move them.
  const opened = await plays(port, workdir, 1);
  assert.equal(opened.status, 200);
  assert.equal(opened.body, "made from: the film I approved");

  // The exact window that matters is inside adoption: the copy under versions/
  // exists, the card has not been saved onto it yet. A test that kills the server at
  // an arbitrary moment never stands in it, and an earlier version of this test was
  // green while adoption deleted the film first. The server is asked to die there.
  stopServer(app); await new Promise(r => setTimeout(r, 200));
  app = start(port, workdir, { HYPERMAKER_CRASH_AFTER_ADOPT: "1" });
  await waitReady(port);
  const crashed = await fetch(`http://127.0.0.1:${port}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1, prompt: "a new take" }) }).then(r => r.text()).then(() => "answered").catch(() => "connection closed");
  assert.equal(crashed, "connection closed", "the server died in the adoption window");
  await new Promise(r => setTimeout(r, 200));

  // What is on disk now is the whole point: whatever workspace.yml names must be a
  // file that is still there.
  const record = readFileSync(join(workdir, "workspace.yml"), "utf8");
  // The file may be the hand-written one (bare scalar) or one the server saved
  // (JSON-quoted), depending on whether the crash landed before or after the save.
  const named = /^\s*artifact:\s*"?([^"\n]+)"?\s*$/m.exec(record)?.[1];
  assert.ok(named, `the card still names an artifact, got ${record}`);
  assert.ok(existsSync(join(workdir, "1", named)), `the file the card names survived the crash: ${named}`);

  app = start(port, workdir); await waitReady(port);
  const reopened = await plays(port, workdir, 1);
  assert.equal(reopened.status, 200, "the film the person approved still plays after the crash");
  assert.equal(reopened.body, "made from: the film I approved", "and it is that film, not the interrupted attempt");
  // The crash landed before the card was marked running, so the honest status is the
  // one it had: nothing started and nothing was lost. What must never happen is a
  // card left claiming a run that the server cannot account for.
  assert.notEqual(reopened.node.status, "running", "after the restart nothing claims to still be running");
  assert.equal(reopened.node.error ?? null, null, "and nothing invents a failure that did not happen");

  // In this window the card still names the old path, because the save never
  // happened - and that is exactly why the old file must still be there. The copy
  // exists too, unreferenced, and is swept on the next open rather than accumulating.
  const files = readdirSync(join(workdir, "1"), { recursive: true });
  assert.ok(files.includes(reopened.artifact), `whatever the card names is on disk, got ${files}`);
  assert.ok(!files.some(f => /^discarded\//.test(f)), `no dead attempt is left under the card's folder, got ${files}`);
});

test("material the creator put in the card's directory stays readable at its own path through many failures and stops", async () => {
  const workdir = join(base, "material-ws");
  oldWorkspace(workdir);
  const port = await freePort();
  start(port, workdir); await waitReady(port);

  // A person has a file of their own and puts it with the card *while a run is
  // working*. That is the only moment worth testing: cleanup only ever sees files
  // that appeared after an attempt started, so a file placed while nothing is
  // running proves nothing. It is not an artifact and nothing points at it.
  const mine = join(workdir, "1", "my-reference-poster.png");

  // Six attempts, failures and stops in succession - past the third, which is where
  // a clean-up that moved or deleted "new" files used to touch a person's.
  for (let round = 0; round < 6; round++) {
    await patch(port, { id: 1, prompt: `fail attempt ${round}` });
    await post(port, "/api/generate", { id: 1 });
    await new Promise(r => setTimeout(r, 250));
    writeFileSync(mine, "MY OWN POSTER, DO NOT DELETE");
    if (round % 2) await post(port, "/api/cancel", { id: 1 });
    const done = await settle(port, 1);
    assert.ok(["error", "cancelled"].includes(done.status), `attempt ${round} ended as ${done.status}`);
    assert.equal(readFileSync(mine, "utf8"), "MY OWN POSTER, DO NOT DELETE", `the creator's own file is untouched after attempt ${round}`);
    // Still where they left it, and still openable through the file endpoint - the
    // thing a person actually does with a file they kept.
    const r = await fetch(`http://127.0.0.1:${port}/api/file?path=${encodeURIComponent(mine)}`);
    assert.equal(r.status, 200, `the creator's own file opens at its original path after attempt ${round}`);
    assert.equal(await r.text(), "MY OWN POSTER, DO NOT DELETE");
  }
  assert.ok(existsSync(mine), "and it is still at the path the person knows");
  assert.equal((await plays(port, workdir, 1)).body, "made from: the film I approved", "with the approved film still on the card all along");
});

test("abandoned attempts are bounded, and a successful take leaves nothing behind", async () => {
  const workdir = join(base, "growth-ws");
  oldWorkspace(workdir);
  const port = await freePort();
  start(port, workdir); await waitReady(port);
  await post(port, "/api/generate", { id: 1, prompt: "first try" });
  await settle(port, 1);

  // A successful take: its working directory is scratch and is gone. What the card
  // records is the published film and the script, both under versions/.
  const afterSuccess = readdirSync(join(workdir, "1"), { recursive: true });
  assert.ok(afterSuccess.some(f => /^versions\/v\d+-film\.png$/.test(f)), `the film is published, got ${afterSuccess}`);
  assert.ok(afterSuccess.some(f => /^versions\/v\d+-render-film\.mjs$/.test(f)), `the script outlives the attempt it was written in, got ${afterSuccess}`);
  // Nothing of the run is left *in the card*: not its scratch, not its frozen copies.
  // The run worked in `.runs/` at the top of the workspace, and a successful one takes
  // its directory with it.
  assert.ok(!afterSuccess.some(f => f.startsWith("attempts/") || f.startsWith(".runs")), `a successful attempt's scratch is gone, got ${afterSuccess}`);
  assert.deepEqual(existsSync(join(workdir, ".runs", "1")) ? readdirSync(join(workdir, ".runs", "1")) : [], [], "and its run directory is gone from the workspace too");

  // Many failed attempts: the history is kept for inspection but bounded by count.
  const counts = [];
  for (let attempt = 0; attempt < 9; attempt++) {
    await patch(port, { id: 1, prompt: `fail attempt ${attempt}` });
    await post(port, "/api/generate", { id: 1 });
    await settle(port, 1);
    counts.push(readdirSync(join(workdir, ".runs", "1")).length);
  }
  assert.ok(Math.max(...counts) <= 5, `abandoned attempts are bounded, got ${counts}`);
  assert.equal(counts.at(-1), 5, `and the bound is reached rather than growing without limit, got ${counts}`);
  assert.match((await plays(port, workdir, 1)).body, /made from: first try/, "the successful film is untouched by nine failed attempts");
});

// The sweep that bounds `versions/` has to know what is reachable, and the published
// prompt of a take is reachable by a name derived from the take's number rather than
// written into the record. The first version of the sweep deleted it on the very next
// run, so a card showed two takes and only the latest still said what it was asked
// for - the one thing a person needs to tell two takes apart.
test("each take keeps the instruction that produced it, and loses it only when the take goes", async () => {
  const workdir = join(base, "prompt-ws");
  oldWorkspace(workdir);
  const port = await freePort();
  start(port, workdir); await waitReady(port);
  await post(port, "/api/generate", { id: 1, prompt: "the take I approved" });
  await settle(port, 1);
  await patch(port, { id: 1, prompt: "a second take" });
  await post(port, "/api/generate", { id: 1 });
  const two = await settle(port, 1);

  // The film in this fixture is the *legacy* one: opening a card before publishing
  // existed adopts it as v1, and nothing recorded what it was asked. The generated
  // takes are v2 and v3, so the instruction to keep is theirs.
  const listed = readdirSync(join(workdir, "1", "versions"));
  const takeNo = file => /^versions\/v(\d+)-/.exec(String(file || ""))?.[1];
  const second = takeNo(two.artifact);
  assert.ok(second, `the card names a take, got ${two.artifact}`);
  assert.ok(listed.includes(`v${second}-prompt.txt`), `the take on the card keeps its own instruction, got ${listed}`);
  assert.match(readFileSync(join(workdir, "1", "versions", `v${second}-prompt.txt`), "utf8"), /a second take/);
  assert.match(readFileSync(join(workdir, "1", "prompt.txt"), "utf8"), /a second take/, "the latest prompt describes the take on the card");

  // A third take, then a restore: the record still names two takes, and the prompts
  // that belong to them are still there rather than swept as unreferenced.
  await patch(port, { id: 1, prompt: "a third take" });
  await post(port, "/api/generate", { id: 1 });
  const three = await settle(port, 1);
  assert.ok(three.versions.length >= 2, `there are takes to choose between, got ${JSON.stringify(three.versions)}`);
  const after = readdirSync(join(workdir, "1", "versions"));
  const reachable = three.versions.map(v => takeNo(v.file)).filter(Boolean);
  // Every generated take the card can still be pointed at says what it was asked;
  // the adopted legacy film has no recorded instruction and is not expected to.
  for (const n of reachable.filter(n => n !== "1")) {
    assert.ok(after.includes(`v${n}-prompt.txt`), `take v${n} is reachable and still says what it was asked, got ${after}`);
  }
  // And the card still plays the take it says it does.
  assert.match((await plays(port, workdir, 1)).body, /made from: a third take/);
  void two;
});
