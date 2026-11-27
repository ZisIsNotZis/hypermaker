// A person who tries a take five times must still have everything that was there
// before the first press: the source image they linked, the files they dropped into
// the card's own directory, and the take they already approved. That was not true,
// and the way it failed was not a crash: the agent runs with an open sandbox, so an
// agent that "tidies" can delete or rewrite a file next to the card while the run
// still reports success (probed on 2026-11-27, `.tmp/probe-card-reach.mjs`).
//
// The guard is three layers, and each is tested here against a run that really does
// the damage through the ordinary HTTP entry point - not against a helper in
// isolation:
//
//   1. A run works in `<workdir>/.runs/<card>/<start>`, outside the card, and the
//      card's path is no longer handed over in `HYPERMAKER_CARD_DIR`.
//   2. Before the agent starts, every file the card holds is *copied* into
//      `<run>/.guard` and hashed. Copies, not hardlinks: the commonest way a tool
//      saves is to reopen the existing file and write into it, and a hardlink shares
//      that content, so such a save would change the "saved" copy too and a
//      comparison would find them identical. A supervisor pointed that out before it
//      shipped, and `an in-place save` below is that exact shape.
//   3. After the run - success, Stop or failure - each guarded file is hashed again
//      and put back if it differs or is gone, and the card says so. A crash is the
//      same check at the next startup, with a note beside the card because nobody was
//      watching when it happened.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-keepcard-"));

// An agent whose damage is chosen by env, so each test describes the misbehaviour it
// is about and nothing else. It always produces a valid result, so the only reason a
// run can fail is the state of the card - which is exactly what is being tested.
writeFileSync(join(base, "agent.mjs"), `
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR, out = process.argv[process.argv.indexOf("--output-last-message") + 1];
const asked = readFileSync(join(dir, "prompt.txt"), "utf8");
// The path is in the prompt as text, which is how a real agent would find it. The
// trailing full stop of the sentence is stripped.
const card = (/Node: (\\S+)/.exec(asked)?.[1] ?? "").replace(/[.,;:]+$/, "") || null;
writeFileSync(join(dir, "seen.json"), JSON.stringify({ dir, cardVar: process.env.HYPERMAKER_CARD_DIR ?? null, cardFromPrompt: card }));
const mode = process.env.DAMAGE || "none";
if (mode === "delete") rmSync(join(card, "my-poster.png"), { force: true });
if (mode === "rewrite") writeFileSync(join(card, "my-poster.png"), "REWRITTEN");
// The ordinary save: open the existing file, write into it, same length. The name and
// the size do not change; only the bytes do.
if (mode === "inplace") {
  const fd = openSync(join(card, "my-poster.png"), "r+");
  writeSync(fd, Buffer.from("REWRITTEN BY THE RUN"), 0, 19, 0);
  closeSync(fd);
}
if (mode === "delete-nested") rmSync(join(card, "mine", "notes.txt"), { force: true });
// A clip over the copy limit: deleting it must still be repaired, because the guard
// keeps it by a link.
if (mode === "delete-clip") rmSync(join(card, "my-clip.mp4"), { force: true });
// It writes its own output first, so a run that is failed for damaging the card is
// still a run that produced something.
writeFileSync(join(dir, "note.txt"), "the run's own note for " + (process.env.DAMAGE || "nothing") + "\\n");
// Hanging is its own flag, not a damage mode: the test needs damage *and* a run that
// is still going when Stop is pressed or the server is killed.
if (process.env.HANG === "1") await new Promise(r => setTimeout(r, Number(process.env.HANG_MS || 60000)));
if (process.env.FAIL === "1") { console.error("render died"); process.exit(3); }
writeFileSync(out, JSON.stringify({ prompt: "stand-in", script: null, artifact: "note.txt", type: "text", method: "llm", error: null }));
`);
const bin = join(base, "agent-bin");
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(base, "agent.mjs"))} "$@"\n`);
chmodSync(bin, 0o755);

const apps = [];
function start(port, workdir, extra = {}) {
  const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "0", ...extra } });
  app.stderr.on("data", c => process.stderr.write(c));
  apps.push(app);
  return app;
}
const workspace = port => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
async function settle(port, id) {
  for (let i = 0; i < 200; i++) {
    const n = (await workspace(port)).nodes[id];
    if (n && n.status !== "running") return n;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`node ${id} never settled`);
}

// A card that already has an approved take and two files of the person's own: one at
// the top of its directory, one in a subdirectory they made, so a guard that only
// looked one level down would be caught.
const POSTER = "MY OWN POSTER BYTES, DO NOT DELETE";
function cardWithOwnFiles(workdir) {
  mkdirSync(join(workdir, "1", "mine"), { recursive: true });
  mkdirSync(join(workdir, "1", "versions"), { recursive: true });
  writeFileSync(join(workdir, "1", "my-poster.png"), POSTER);
  writeFileSync(join(workdir, "1", "mine", "notes.txt"), "MY OWN NOTES\n");
  writeFileSync(join(workdir, "1", "versions", "v1-note.txt"), "the take I approved\n");
  writeFileSync(join(workdir, "workspace.yml"), [
    "1:", "  x: 40", "  y: 40", "  inputs: []", "  type: text", "  method: llm",
    '  prompt: "the take I approved"', '  promptUsed: "the take I approved"', "  quality: standard",
    "  artifact: versions/v1-note.txt", "  status: idle", ""
  ].join("\n"));
}
const poster = (workdir) => readFileSync(join(workdir, "1", "my-poster.png"), "utf8");
const notes = (workdir) => readFileSync(join(workdir, "1", "mine", "notes.txt"), "utf8");

after(() => { for (const app of apps) stopServer(app); stopAll(); });

test("a successful run leaves the card's own files alone, and does not hand the agent the card directory", async () => {
  const workdir = join(base, "success-ws");
  cardWithOwnFiles(workdir);
  const port = await freePort();
  start(port, workdir);
  await waitReady(port);
  await post(port, "/api/generate", { id: 1, prompt: "a normal take" });
  const done = await settle(port, 1);
  assert.equal(done.status, "idle", `an ordinary run succeeds, got ${done.error}`);
  assert.match(readFileSync(join(workdir, "1", done.artifact), "utf8"), /the run's own note/, "and its result is what the card shows");

  // The person's files are untouched, at the paths they chose.
  assert.equal(poster(workdir), POSTER);
  assert.equal(notes(workdir), "MY OWN NOTES\n");
  assert.equal(readFileSync(join(workdir, "1", "versions", "v1-note.txt"), "utf8"), "the take I approved\n", "the take that was approved is still there");

  // The guard was real work, and the run said nothing about it because nothing went
  // wrong: no notice, no error.
  assert.equal(done.error, null);

  // The run area is outside the card, and a successful run takes its scratch with it.
  const cardFiles = readdirSync(join(workdir, "1"), { recursive: true });
  assert.ok(!cardFiles.some(f => f.startsWith("attempts") || f.startsWith(".runs")), `nothing of the run is left in the card, got ${cardFiles}`);
  assert.deepEqual(existsSync(join(workdir, ".runs", "1")) ? readdirSync(join(workdir, ".runs", "1")) : [], [], "and the run directory is gone");
});

test("an agent that deletes a file next to the card is caught, the file comes back, and the run does not claim success", async () => {
  const workdir = join(base, "delete-ws");
  cardWithOwnFiles(workdir);
  const port = await freePort();
  start(port, workdir, { DAMAGE: "delete" });
  await waitReady(port);

  // The file answers before the run - the thing the probe measured as 200 then 404.
  const before = await fetch(`http://127.0.0.1:${port}/api/file?path=${encodeURIComponent(join(workdir, "1", "my-poster.png"))}`);
  assert.equal(before.status, 200);

  await post(port, "/api/generate", { id: 1, prompt: "a take" });
  const done = await settle(port, 1);

  assert.equal(poster(workdir), POSTER, "the deleted file is back with its own bytes");
  const after = await fetch(`http://127.0.0.1:${port}/api/file?path=${encodeURIComponent(join(workdir, "1", "my-poster.png"))}`);
  assert.equal(after.status, 200, "and it opens at the path the person knows");
  assert.equal(await after.text(), POSTER);

  // The run is not presented as a clean success: a person told "done" would not know
  // their directory had been touched at all.
  assert.equal(done.status, "error", `a run that damaged the card is not idle, got ${JSON.stringify(done)}`);
  assert.match(done.error, /my-poster\.png/, "the message names the file that was touched");
  assert.match(done.error, /put back|nothing you put there is lost/i, "and says the file was restored");
  // The take that was approved is still the take on the card.
  assert.equal(done.artifact, "versions/v1-note.txt");
});

test("an in-place save is caught: same name, same size, different bytes", async () => {
  // The case a supervisor named before this shipped. A hardlink guard cannot see it,
  // because the guard and the original are one piece of content; a copied guard can,
  // because it holds the older bytes and the comparison is by content.
  const workdir = join(base, "inplace-ws");
  cardWithOwnFiles(workdir);
  const before = readFileSync(join(workdir, "1", "my-poster.png"));
  const port = await freePort();
  start(port, workdir, { DAMAGE: "inplace" });
  await waitReady(port);
  await post(port, "/api/generate", { id: 1, prompt: "a take" });
  const done = await settle(port, 1);

  const after = readFileSync(join(workdir, "1", "my-poster.png"));
  assert.equal(after.length, before.length, "the fixture really did write the same number of bytes, so a size check could not see it");
  assert.equal(after.toString(), POSTER, "the original bytes are back");
  assert.equal(done.status, "error", "and the run says it changed a file rather than reporting a clean success");
  assert.match(done.error, /changed files?|my-poster\.png/);
});

test("a stopped run puts the card back too, and keeps the take that was already approved", async () => {
  const workdir = join(base, "stop-ws");
  cardWithOwnFiles(workdir);
  const port = await freePort();
  start(port, workdir, { DAMAGE: "delete", HANG: "1", HANG_MS: "60000" });
  await waitReady(port);
  await post(port, "/api/generate", { id: 1, prompt: "a take that is stopped" });
  // Wait until the agent has really done its damage and is still running, so the Stop
  // is pressed with the card changed underneath it.
  for (let i = 0; i < 100; i++) {
    if (!existsSync(join(workdir, "1", "my-poster.png"))) break;
    await new Promise(r => setTimeout(r, 50));
  }
  // A successful cancel answers with the workspace view, which carries no error; a
  // refused one answers with `error`. Asking for `error` is what tells them apart.
  const stopped = await post(port, "/api/cancel", { id: 1 });
  assert.equal(stopped.error ?? null, null, JSON.stringify(stopped));
  assert.ok(stopped.nodes?.[1]?.status === "running" || stopped.nodes?.[1]?.status === "cancelled", "the Stop reached a live run");
  const done = await settle(port, 1);
  assert.equal(done.status, "cancelled", `the card reports the run was stopped, got ${JSON.stringify(done)}`);
  assert.equal(poster(workdir), POSTER, "the person's file is back even though the run was stopped mid-damage");
  assert.equal(done.artifact, "versions/v1-note.txt", "and the approved take is still the one on the card");
  // The failure path reports the damage as well - a Stop is not permission to lose it.
  assert.match(done.error, /my-poster\.png/, "the card still says which file had to be put back");
});

test("a failed run puts the card back too", async () => {
  const workdir = join(base, "fail-ws");
  cardWithOwnFiles(workdir);
  const port = await freePort();
  start(port, workdir, { DAMAGE: "delete-nested", FAIL: "1" });
  await waitReady(port);
  await post(port, "/api/generate", { id: 1, prompt: "a take that fails" });
  const done = await settle(port, 1);
  assert.equal(done.status, "error");
  assert.match(done.error, /render died/, "the agent's own reason is still on the card");
  assert.equal(notes(workdir), "MY OWN NOTES\n", "a file three levels down is put back where it was");
  assert.equal(poster(workdir), POSTER);
  assert.equal(done.artifact, "versions/v1-note.txt", "and nothing about the approved take moved");
});

test("a server that dies mid-run restores the card on the next open, and says so beside it", async () => {
  const workdir = join(base, "crash-ws");
  cardWithOwnFiles(workdir);
  const port = await freePort();
  const app = start(port, workdir, { DAMAGE: "delete", HANG: "1", HANG_MS: "60000" });
  await waitReady(port);
  await post(port, "/api/generate", { id: 1, prompt: "a take that is cut off" });
  for (let i = 0; i < 100; i++) {
    if (!existsSync(join(workdir, "1", "my-poster.png"))) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(existsSync(join(workdir, "1", "my-poster.png")), false, "the run really did delete it before the server died");
  // Kill the whole group: no failure branch runs, so only the next startup can recover.
  stopServer(app);
  await new Promise(r => setTimeout(r, 300));

  const q = await freePort();
  start(q, workdir);
  await waitReady(q);
  assert.equal(poster(workdir), POSTER, "the file is back after the restart");
  const note = join(workdir, "1", "KEPT-AFTER-CRASH.txt");
  assert.ok(existsSync(note), "and there is a note beside the card, because nobody was watching when it happened");
  assert.match(readFileSync(note, "utf8"), /my-poster\.png/, "the note names the file that was put back");
  const node = (await workspace(q)).nodes[1];
  assert.equal(node.status, "error", "the interrupted run is still reported as interrupted");
  assert.match(node.error, /interrupted/i);
  assert.equal(node.artifact, "versions/v1-note.txt", "and the approved take is untouched");
});

// The boundary a supervisor found by using the app: a 65 MiB clip is ordinary material,
// and the first version said so only after the run - actually it said nothing at all
// until something went wrong. A large file is now kept by a link (so a deletion is still
// repaired) and the person is told at the press that a rewrite of its contents in place
// is the one thing not covered.
test("a file larger than the copy limit is announced before the run, and is still put back if the run deletes it", async () => {
  const workdir = join(base, "big-ws");
  cardWithOwnFiles(workdir);
  // 65 MiB of material next to the card. Sparse-ish content, but a real file of a real
  // size: the guard's decision is by size, so the size has to be real.
  const clip = join(workdir, "1", "my-clip.mp4");
  writeFileSync(clip, "ftyp");
  appendFileSync(clip, Buffer.alloc(65 * 1024 * 1024));
  const size = statSync(clip).size;
  assert.ok(size > 64 * 1024 * 1024, "the fixture file really is over the copy limit");

  const port = await freePort();
  start(port, workdir, { DAMAGE: "delete-clip" });
  await waitReady(port);

  // The press itself carries the sentence. This is the thing that was missing: the reply
  // must mention the file and say what is and is not covered for it.
  const answer = await post(port, "/api/generate", { id: 1, prompt: "a take with a clip" });
  assert.match(answer.notice || "", /my-clip\.mp4/, `the press names the file outside the copy tier, got ${JSON.stringify(answer.notice)}`);
  assert.match(answer.notice || "", /link/i, "and says how it is kept");
  assert.match(answer.notice || "", /cannot be undone/i, "and names the one change it cannot repair");
  // Stored, not just printed: it is still there for a person who reopens the page, and
  // while the run is going.
  const during = (await workspace(port)).nodes[1];
  assert.match(during.notice || "", /my-clip\.mp4/, "the card keeps the sentence while the run works");

  const done = await settle(port, 1);
  assert.equal(statSync(clip).size, size, "the clip the run deleted is back at its size");
  assert.equal(done.status, "error", "a run that had to repair the card does not report a clean success");
  assert.match(done.error, /my-clip\.mp4/, "and the message names the clip");
  // Small files are still fully covered in the same run.
  assert.equal(poster(workdir), POSTER);
});

test("a small file gets no notice at all, because there is nothing to warn about", async () => {
  const workdir = join(base, "quiet-ws");
  cardWithOwnFiles(workdir);
  const port = await freePort();
  start(port, workdir);
  await waitReady(port);
  const answer = await post(port, "/api/generate", { id: 1, prompt: "an ordinary take" });
  assert.equal(answer.notice ?? null, null, `an ordinary card is not given a warning, got ${JSON.stringify(answer.notice)}`);
  const done = await settle(port, 1);
  assert.equal(done.status, "idle");
  assert.equal(done.notice ?? null, null);
});
