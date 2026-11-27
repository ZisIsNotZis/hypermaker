import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkspace, writeWorkspace, nodeRecord } from "./workspace.mjs";
import { methodFor, methodsFor, registryInfo, typeForFile } from "./registry.mjs";
import { assemblePrompt, materialText } from "./prompt.mjs";
import { generate as runCodex } from "./codex.mjs";
import { verifyNarration } from "./narration.mjs";
import { beginRun, damageReason, endRun, guardCard, guardName, guardNotice, keepCard, pruneRuns, recoverRun, runsRoot } from "./runs.mjs";

const root = resolve(new URL("..", import.meta.url).pathname), publicDir = join(root, "public"), defaultWorkdir = join(root, ".hypermaker");
let workdir = resolve(process.env.HYPERMAKER_WORKDIR || defaultWorkdir), nodes = readWorkspace(workdir), idCounter = Math.max(0, ...Object.keys(nodes).map(Number));
if (process.env.NODE_ENV === "test" || process.env.HYPERMAKER_RESET_WORKSPACE === "1") nodes = {}, idCounter = 0;
// A run cannot survive the process that spawned it. Any node still marked running
// when the workspace is opened was cut off, and saying so is the honest answer:
// the alternative is a card that silently claims it never started.
//
// It is also the only moment the dead attempt can be cleaned up after: its failure
// branch never ran, so its half-render, its frozen material copies and its scratch
// are still on disk. A creator who closes the laptop mid-render and comes back
// should find the card exactly as it was plus one honest error, not a directory
// that grows with every interruption.
async function adopt(graph, dir = workdir) {
  for (const [id, node] of Object.entries(graph)) {
    // "Running" on disk means cut off only when this process is not running it. The
    // record is written at the press, so opening another workspace and coming back to
    // this one while the run is still alive used to rewrite its own live card as
    // "Run interrupted" - the run then finished onto a card that already claimed it had
    // died, and the person saw an error followed by a result.
    const live = running.get(slot(dir, Number(id)));
    if (node.status === "running" && live) continue;
    if (node.status === "running") { await recover(dir, id, node); graph[id] = { ...node, status: "error", error: "Run interrupted: the server stopped before the agent finished" }; }
    else await recover(dir, id, node);
  }
  return graph;
}
// A run is the only thing in this server that outlives one request, so it is kept
// in one place: `running` maps a node id to the agent promise (whose cancel()
// stops the whole process group). Nothing else may start a second run for the
// same node while it is there.
const clients = new Set(), running = new Map();
// Both live-run tables are keyed by workspace *and* card. Node ids are per workspace, so
// a run in one workspace and a card in another share an id; keying by the id alone let
// the second workspace's card take the first one's live run - it looked busy, its
// Generate was refused, and its attempt directory pointed into the other workspace.
//
// Declared here, above `adopt`, because opening a workspace runs `adopt` during module
// load: with the key defined further down, a `const` in its temporal dead zone threw
// `Cannot access 'slot' before initialization` and the server exited - but only for a
// workspace that already had cards, since an empty one never enters the loop. The empty
// workspaces the tests create were exactly the case that did not hit it.
const slot = (dir, id) => `${dir}\u0000${id}`;
// Where each live run is working. Useful to a person looking at a slow card ("what is
// it doing?") and the honest way for a test to wait for an agent to be really alive.
const attemptDirs = new Map();
const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
const body = req => new Promise((ok, no) => { let data = ""; req.on("data", x => data += x); req.on("end", () => { try { ok(data ? JSON.parse(data) : {}); } catch (e) { no(e); } }); });
const nextId = () => ++idCounter;
// Every finished run is published under a name no later run can write to. The card
// then points at that published file, so two things fall out of one mechanism:
//
//   * an agent that reuses its usual filename (they all do) writes over scratch in
//     the node directory, never over what the person is watching or listening to;
//   * a run that fails after writing half an output leaves the published file
//     untouched, because nothing ever wrote to it.
//
// Copying the previous artifact somewhere at the start of a run - the first
// attempt - could not do this: the agent's bytes had already been written over the
// live file by the time the run failed.
// `from` is where the bytes being published are, when that is not the card's own
// directory: a finished run leaves its output in its attempt directory, and only
// the copy under versions/ outlives it.
function publish(workdir, id, artifact, from = join(workdir, String(id))) {
  if (!artifact) return null;
  const dir = join(workdir, String(id)), source = join(from, basename(artifact));
  if (!existsSync(source)) return null;
  const name = basename(artifact).replace(/^v\d+-/, "");
  mkdirSync(join(dir, "versions"), { recursive: true });
  // The number is "which publish this is for this card", counted from the files in
  // versions/ rather than from the version list - restoring a version empties a slot
  // there, so the next run used to pick a number that already named the artifact on
  // the card and wrote straight over the film the person was watching.
  //
  // Counting per filename was the next mistake, and a quieter one: our own video
  // guide tells the agent to render to a fresh path every time, so two takes became
  // `v1-shot-a.mp4` and `v1-shot-b.mp4` and the card read "v1" for both. A person
  // comparing two takes has only that number to go by.
  const taken = readdirSync(join(dir, "versions")).map(f => /^v(\d+)-/.exec(f)?.[1]).filter(Boolean).map(Number);
  let n = Math.max(0, ...taken) + 1, rel;
  do { rel = join("versions", `v${n++}-${name}`); } while (existsSync(join(dir, rel)));
  copyFileSync(source, join(dir, rel));
  return rel;
}
// The script is what a person reads to see what the agent actually ran, so it has to
// survive the attempt directory. It goes under the same published number as the film
// it produced, which is also how a person finds it from the card.
function publishScript(workdir, id, script, published, from = join(workdir, String(id))) {
  const dir = join(workdir, String(id)), source = join(from, basename(script));
  if (!published || !existsSync(source)) return null;
  // Same number as the take, so `v2-film.png` and `v2-render.mjs` are obviously one
  // result: the number is the card's publish ordinal, not a name this function invents.
  const ordinal = /^v(\d+)-/.exec(basename(published))?.[1];
  const rel = join("versions", `${ordinal ? `v${ordinal}-` : ""}${basename(script).replace(/^v\d+-/, "")}`);
  copyFileSync(source, join(dir, rel));
  return rel;
}
// An artifact from before this change lives at the top of its node directory. It
// is still perfectly good bytes, so it is adopted into `versions/` once, on first
// use, rather than left as the one file a new run is allowed to overwrite.
//
// The caller has to move the card onto the returned name, and do it *before* the
// agent starts. Copying the bytes aside while the card kept pointing at the old
// name was not enough: `film.png` is the name every agent reuses, so a retry that
// failed (or was stopped) left the card playing the half-finished attempt while the
// approved film sat in versions/ with nothing pointing at it. A person who tried
// three times lost the take they had approved, which is the opposite of what
// keeping versions is for.
// The order matters and it is not negotiable: copy, save the card onto the copy,
// *then* let go of the old name. Deleting first - the obvious way to avoid a
// leftover - leaves a window where the card in workspace.yml names a file that is
// already gone, and a server that stops in that window reopens onto a card that
// cannot play the film the person had approved. A file left behind for one moment
// is recoverable; a deleted one is not.
function adoptLegacy(workdir, id, artifact) {
  if (!artifact || artifact.startsWith("versions/")) return { file: artifact, retire: null };
  const dir = join(workdir, String(id)), source = join(dir, artifact);
  if (!existsSync(source)) return { file: artifact, retire: null };
  const adopted = publish(workdir, id, artifact);
  return adopted ? { file: adopted, retire: artifact } : { file: artifact, retire: null };
}
// What keeps `versions/` from growing without bound: a copy there that no card and
// no kept version points at is left over from a run that was cut off mid-publish,
// or from an adoption whose save never happened. `versions/` is harness-owned (the
// agent is told so), so this is the one place where deleting the unreferenced is a
// fact rather than a guess.
function sweepVersions(workdir, id, node) {
  const dir = join(workdir, String(id), "versions");
  if (!existsSync(dir)) return;
  const live = new Set();
  // `artifact` as well as `file`: a node record points at its live film through
  // `artifact`, and versions point at their bytes through `file`. Looking only at
  // `file` deleted the card's own artifact on the next restart - the probe showed a
  // 404 for the film that was on screen before the process was killed.
  // The script counts too: it is published next to the take it produced and the card
  // records it, so a sweep that only looked at artifacts deleted the one record of
  // what the agent actually ran.
  const referenced = v => { for (const f of [v?.file, v?.artifact, v?.script]) if (f) live.add(String(f).replace(/^versions\//, "")); for (const s of v?.sources || []) if (s?.file) live.add(String(s.file).replace(/^versions\//, "")); };
  if (node) referenced(node);
  for (const version of node?.versions || []) referenced(version);
  // The published prompt of a take (`v2-prompt.txt`) is live exactly as long as take
  // v2 is: its name is derived from the artifact's number rather than stored in the
  // record, so it would otherwise be deleted as unreferenced. Derived from the live
  // set - computed here, after it is filled - a take that is no longer reachable
  // takes its prompt with it instead of prompts accumulating one per take forever.
  const liveTakes = new Set([...live].map(f => /^v(\d+)-/.exec(f)?.[1]).filter(Boolean));
  const keepPrompt = rel => { const n = /^v(\d+)-prompt\.txt$/.exec(rel)?.[1]; return !!n && liveTakes.has(n); };
  // A take's own `timeline.json` is live for exactly as long as that take is, and for the same
  // reason as the prompt: its name is derived from the artifact's number, not stored in the
  // record. Without this line the sweep deleted it moments after `publish` wrote it - the copy
  // existed, was named correctly, and was gone by the time anyone asked, which is why
  // `voice/verify-take.mjs` could not re-verify a published card. Found by running it on a real
  // workspace rather than by reading the code.
  const keepTimeline = rel => { const n = /^v(\d+)-.*\.timeline\.json$/.exec(rel)?.[1]; return !!n && liveTakes.has(n); };
  for (const rel of readdirSync(dir)) {
    const file = join(dir, rel);
    try { if (!statSync(file).isFile()) continue; } catch { continue; }
    if (live.has(rel) || keepPrompt(rel) || keepTimeline(rel)) continue;
    rmSync(file, { force: true });
  }
}
// What is on disk, so a run that is thrown away can be told from everything that was
// already there. Agents render, copy material into their own public/, and leave
// scratch files: a creator who tries five times should not pay for five dead renders.
function listing(dir) {
  const files = new Set();
  try { for (const rel of readdirSync(dir, { recursive: true })) { try { if (statSync(join(dir, rel)).isFile()) files.add(rel); } catch {} } } catch {}
  return files;
}
// Where a run works, and what is done if it damages the card anyway, live in
// `runs.mjs`: a run's own directory outside the card, a snapshot of the card taken
// before the agent starts, and the rule that puts back anything the agent deletes or
// changes. This file only decides *when* those happen - which is
// the lifecycle below, and it is the same three moments as before: before the
// agent starts, after it finishes (whatever way), and when a process that died
// mid-run is opened again.
//
// What is in the card's directory is therefore only what a person put there and
// the takes published into `versions/`: never a run's scratch, never its frozen
// copies, and never a directory that a person did not make.
//
// A crash leaves the card marked running and its run directory behind. The marker
// names that directory, so recovery finds the guard without guessing, puts the card
// back, drops the run - and then everything the ordinary open does: a take that a
// dead run published without saving is adopted into versions/ (it is bytes somebody
// may want, and the same rule as any earlier artifact), unreferenced copies are
// swept, and attempts directories that older builds left *inside* cards are moved
// out to the run area rather than deleted, because a person may have kept a file in
// one.
// One run's directory, gone. Anything worth keeping was already copied out of it by
// `publish` (or holds a failed run a person may still want to look at, which is why
// the failure path does not call this).
function dropAttempt(dir) {
  if (dir) rmSync(dir, { recursive: true, force: true });
}
function legacyAttempts(workdir, id) {
  const stale = join(workdir, String(id), "attempts");
  if (!existsSync(stale)) return;
  const moved = join(workdir, runsRoot, String(id));
  mkdirSync(moved, { recursive: true });
  for (const name of readdirSync(stale)) {
    let target = join(moved, name);
    for (let n = 1; existsSync(target); n++) target = join(moved, `${name}-kept-${n}`);
    try { renameSync(join(stale, name), target); } catch {}
  }
  try { if (!readdirSync(stale).length) rmSync(stale, { recursive: true, force: true }); } catch {}
  writeFileSync(join(moved, "MOVED-HERE.txt"), [
    "Earlier versions of this harness ran an agent inside the card's own directory, under",
    "attempts/. Anything you kept in one of those folders was moved here, unchanged and",
    "with its own name, rather than deleted: this area is where interrupted and abandoned",
    "runs live now, and it is outside the card.",
    ""
  ].join("\n"), "utf8");
}
async function recover(workdir, id, node) {
  const { report } = await recoverRun(workdir, id);
  if (report) {
    legacyAttempts(workdir, id);
    // A take published by the dead run is on disk with nothing pointing at it. It is
    // still bytes somebody may want, so it becomes a version - and because the card
    // kept to its published take throughout, `versions/` also holds the take on
    // screen, which the sweep below must not take for a leftover.
    const adopted = node?.artifact ? adoptLegacy(workdir, id, node.artifact) : null;
    if (adopted && node) { node.artifact = adopted.file; if (adopted.retire) rmSync(join(workdir, String(id), adopted.retire), { force: true }); }
  }
  sweepVersions(workdir, id, node);
}
// Opening a workspace is where a run that the process did not outlive becomes visible.
// It is awaited at module load (this file is a module, so top-level await is available)
// because everything below - `view()`, the first request - must see the recovered card
// and never a card still claiming to be running.
const cut = Object.values(nodes).some(n => n.status === "running");
nodes = await adopt(nodes, workdir);
if (cut) writeWorkspace(workdir, nodes);
function pruneEmpty(dir) {
  const dirs = [];
  const walk = d => { try { for (const entry of readdirSync(d, { withFileTypes: true })) { if (!entry.isDirectory()) continue; const p = join(d, entry.name); walk(p); dirs.push(p); } } catch {} };
  walk(dir);
  for (const p of dirs) { try { if (!readdirSync(p).length) rmSync(p, { recursive: true, force: true }); } catch {} }
}
// A version's provenance has to be as durable as its bytes. Upstream files are
// rewritten by the next run (the material card keeps one artifact name), so a
// version that only remembered `poster.png` described whatever the poster holds
// *today*, not what this render saw. Copy the material bytes alongside the
// version and point the recorded source at that copy.
function freezeSources(workdir, id, sources = []) {
  if (!sources.length) return [];
  const dir = join(workdir, String(id));
  // A number that is free, not a number derived from the version list: an earlier
  // run's snapshot must never be written over, because the version that names it
  // still exists. This is the same collision that let a publish overwrite the
  // artifact on the card.
  mkdirSync(join(dir, "versions"), { recursive: true });
  const used = readdirSync(join(dir, "versions")).map(f => /^s(\d+)-/.exec(f)?.[1]).filter(Boolean).map(Number);
  const stamp = Math.max(0, ...used) + 1;
  return sources.map(source => {
    const from = join(workdir, String(source.id), source.artifact || "");
    if (!source.artifact || !existsSync(from)) return { ...source, file: null };
    // The source's own name, without a version prefix it may have picked up when
    // it was published: `s2-from-1-v1-poster.png` reads like a bug and hides the name.
    const rel = join("versions", `s${stamp}-from-${source.id}-${basename(source.artifact).replace(/^v\d+-/, "")}`);
    copyFileSync(from, join(dir, rel));
    return { ...source, file: rel, frozen: join(dir, rel) };
  });
}
// The stored status is the last run's outcome; a live run overrides it. A run that
// the server itself cut off is written to disk as an error at startup, so a card
// never quietly turns back into a draft after a crash.
const view = () => ({ workdir, nodes: Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, { ...nodeRecord(id, n), id: Number(id), workdir: existsSync(join(workdir, id)) ? join(workdir, id) : null, status: claimFor(id) ? "running" : (n.status || (n.artifact ? "idle" : "draft")), attempt: claimFor(id) ? attemptDirs.get(slot(workdir, Number(id))) ?? null : null }])) });
const save = () => writeWorkspace(workdir, nodes);
const emit = event => { const data = `data: ${JSON.stringify(event)}\n\n`; for (const client of clients) client.write(data); };
const getNode = id => { if (!nodes[id]) throw new Error("Node not found"); return { ...nodes[id], id: Number(id) }; };
// Media previews are a person scrubbing a file, not a download. A response with no
// content-length and no Range support makes Chromium show a WAV with `duration:
// null` and a dead progress bar, while an MP4 happens to survive on its own moov
// box - so video looked fine and audio looked broken for the same reason. Range
// support is also what lets a large render start playing before it is all sent.
const mimeFor = file => { const type = typeForFile(file), ext = extname(file).slice(1).toLowerCase(); if (type === "text") return "text/plain; charset=utf-8"; const subtype = { wav: "wav", mp3: "mpeg", ogg: "ogg", png: "png", jpg: "jpeg", jpeg: "jpeg", mp4: "mp4", webm: "webm", mov: "quicktime" }[ext] || ext; return `${({ image: "image", audio: "audio", video: "video" }[type]) || "application"}/${subtype}`; };
function sendFile(req, res, file) {
  if (!existsSync(file)) return json(res, 404, { error: "File not found" });
  const size = statSync(file).size, mime = mimeFor(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (!range) { res.writeHead(200, { "content-type": mime, "content-length": size, "accept-ranges": "bytes" }); return createReadStream(file).pipe(res); }
  // A range request must answer 206 with the slice it actually sent, or a player
  // will keep asking and never settle on a length.
  const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
  res.writeHead(206, { "content-type": mime, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
  createReadStream(file, { start, end }).pipe(res);
}
// A run belongs to the workspace it was started in, not to this server process. Opening
// another workspace replaces `nodes` and `workdir` for every later line, including the
// completion of a run that is still going - and node ids are per workspace, so a
// finishing run wrote its result, its prompt and its sources into whatever card in the
// *new* workspace happened to have the same id. Reproduced on the previous commit by the
// canvas-protection test: opening a second workspace while a card was generating left the
// new, empty card showing the other workspace's 65 MiB file notice and then its run's
// outcome. So every line of a run takes its workspace explicitly (`ws`, captured at the
// press): the bytes go to that workspace's node directory, and `finishIn` writes the
// outcome into the open graph only when that graph is the run's own.
const releaseClaim = claim => { const key = slot(claim.workdir, claim.id); if (running.get(key) === claim) running.delete(key); };
// Every write to a workspace's `workspace.yml` goes through one queue per directory.
// Two writers could otherwise read the same file, each apply its own change and each
// write back, and the second silently undid the first. Both cases a supervisor found are
// this race: a run that finished while its workspace was being opened - the opener saved
// the graph it had read before the run's result existed, so the artifact was on disk and
// on neither the canvas nor the record - and a run finishing in a workspace that was not
// open while the opener's own save was in flight.
//
// The queue is per workspace, so it does not serialise unrelated work, and it never
// carries a failure: an open that fails must not poison the next one (a mistyped path
// once made every later open fail).
const queues = new Map();
function serial(dir, work) {
  const before = queues.get(dir) ?? Promise.resolve();
  const run = before.then(work);
  queues.set(dir, run.catch(() => {}));
  return run;
}
// Opening a workspace is queued too: it is the one other writer of `workspace.yml`.
function openWorkspace(dir) {
  return serial(dir, async () => {
    const graph = await adopt(readWorkspace(dir), dir);
    // Write before switching. A directory that cannot be written (read-only, a
    // permission a person does not have) fails here, and the person keeps the canvas
    // and the state they had - the previous order switched `workdir` first, so a failed
    // open left the canvas labelled with a workspace it had not opened. This also makes
    // the switch atomic from the outside: the path and the cards become the new ones
    // together, after the new file exists.
    writeWorkspace(dir, graph);
    workdir = dir;
    nodes = graph;
    idCounter = Math.max(0, ...Object.keys(graph).map(Number));
  });
}
// Where a finished run puts its outcome. When the person still has the run's own
// workspace open this is the in-memory graph, exactly as before. When they have opened
// another one, the outcome belongs to the workspace the run was started in, and the only
// honest place for it is that workspace's own `workspace.yml`.
async function finishIn(workspace, id, patch) {
  return serial(workspace, () => {
    if (workspace === workdir) { nodes[id] = nodeRecord(id, { ...nodes[id], ...patch }); save(); return; }
    const graph = readWorkspace(workspace);
    if (!graph[id]) return;
    graph[id] = nodeRecord(id, { ...graph[id], ...patch });
    writeWorkspace(workspace, graph);
  });
}
// The slot is found by the workspace that is open and the card. Only a run of a
// *different* workspace is out of reach, and the workspace in the key already says so -
// so coming back to a workspace whose run is still going keeps Stop and the refusal
// working. It used to also require a per-open `session`, and then returning mid-run
// showed the card as generating while Stop answered "not generating" and a second press
// was accepted, which published one extra version.
const claimFor = id => running.get(slot(workdir, Number(id)));
const server = createServer(async (req, res) => { try {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); clients.add(res); req.on("close", () => clients.delete(res)); return; }
  if (url.pathname === "/api/registry") return json(res, 200, registryInfo());
  if (url.pathname === "/api/workspace" && req.method === "GET") return json(res, 200, view());
  // Opening a workspace is one switch, not two: the path and the cards change together.
  // It used to set `workdir` first and then await `adopt`, which puts back a card whose
  // run died mid-flight - seconds of file copying. For that whole window the server
  // reported the new workspace's path with the old workspace's cards, so a canvas that
  // asked in between showed A's cards labelled as B and could edit or generate into
  // them. A supervisor hit it by opening B, which had an interrupted run to recover.
  // Opens are also serialised: two overlapping opens would each build a graph and the
  // slower one would win with cards read before the other's recovery finished.
  if (url.pathname === "/api/workspace" && req.method === "POST") {
    const b = await body(req), next = resolve(b.workdir || defaultWorkdir);
    await openWorkspace(next);
    // Anything that finished while this workspace was being opened has already queued
    // its outcome; let it land before answering, so the reply the canvas paints is the
    // finished state and not a snapshot from a moment earlier. A run that is still
    // going has not queued anything, so this never makes an open wait for a render.
    await serial(next, () => {});
    return json(res, 200, view());
  }
  if (url.pathname === "/api/file") { const file = resolve(url.searchParams.get("path") || ""); const rel = relative(resolve(workdir), file); if (rel.startsWith("..") || rel.startsWith("/")) throw new Error("File outside workspace"); return sendFile(req, res, file); }
  if (url.pathname === "/api/node" && req.method === "POST") {
    const b = await body(req), id = nextId();
    // A card with no method named starts on the first method that works for its own type.
    // It used to start on `llm` whatever the type was, so an audio card created through the
    // API - which is what a person gets from the canvas's own "+ Card" when they switch the
    // type before the card has loaded - carried `llm` as its method. The record then named a
    // text method for an audio card, and Generate asked the prompt assembler for a method
    // that does not exist for that type.
    const fallback = methodsFor(b.type || "text").find(m => m.available !== false)?.id ?? null;
    nodes[id] = nodeRecord(id, { ...b, inputs: [], method: b.method || fallback, quality: b.quality || "standard" }); save(); return json(res, 200, view());
  }
  if (url.pathname === "/api/import" && req.method === "POST") { const b = await body(req), id = nextId(), type = typeForFile(b.path); if (!type) throw new Error("Unsupported asset type"); const name = String(b.path).split(/[\\/]/).pop(); mkdirSync(join(workdir, String(id)), { recursive: true }); copyFileSync(resolve(b.path), join(workdir, String(id), name)); nodes[id] = nodeRecord(id, { x: b.x, y: b.y, type, inputs: [], artifact: name }); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/link" && req.method === "POST") { const b = await body(req), target = getNode(b.target); if (Number(b.source) !== Number(b.target) && !target.inputs.includes(Number(b.source))) target.inputs.push(Number(b.source)); nodes[b.target] = target; save(); return json(res, 200, view()); }
  if (url.pathname === "/api/unlink" && req.method === "POST") { const b = await body(req), target = getNode(b.target); target.inputs = target.inputs.filter(id => id !== Number(b.source)); nodes[b.target] = target; save(); return json(res, 200, view()); }
  // status/error belong to the run, not to the client: a card's prompt or position
  // edit must never be able to claim a run succeeded or erase a failure.
  if (url.pathname === "/api/node" && req.method === "PATCH") { const b = await body(req), n = getNode(b.id); delete b.status; delete b.error; delete b.promptUsed; Object.assign(n, b);
    // Changing the output type drops the artifact (a PNG cannot be a soundtrack).
    // `promptUsed` describes an artifact, so it goes with it; leaving it behind
    // would let the next Generate keep that prompt as "the version it replaced".
    // The narration evidence describes an artifact, so it goes with it for the same reason
    // the instruction does: a card with no artifact cannot have measured anything.
    if (n.artifact == null) { n.promptUsed = null; n.narration = null; }
    nodes[b.id] = nodeRecord(b.id, n); save(); return json(res, 200, view()); }
  // Going back must move the provenance with the bytes. Restoring only the file
  // would leave the card claiming the newest film's materials over an older
  // picture - the same lie the frozen-source work was about. The instruction is
  // provenance too: a person who had asked for a sea film and then for a mountain
  // one must not be shown the sea film under the mountain words, or the next
  // Generate silently re-does a take they thought they were looking at.
  if (url.pathname === "/api/restore" && req.method === "POST") {
    const b = await body(req), n = getNode(b.id);
    if (claimFor(n.id)) return json(res, 409, { ...view(), error: `Node ${n.id} is generating; stop it before going back to an earlier version` });
    const list = [...(n.versions || [])], index = list.findIndex(v => Number(v.id) === Number(b.version));
    if (index < 0) return json(res, 404, { ...view(), error: `Node ${n.id} has no version ${b.version}` });
    const chosen = list[index];
    if (!chosen.file || !existsSync(join(workdir, String(n.id), chosen.file))) return json(res, 409, { ...view(), error: `Version ${chosen.id} of node ${n.id} is missing its file (${chosen.file || "none"})` });
    // The version being replaced becomes selectable in the same slot, so going back
    // is itself reversible.
    const ordinal = Math.max(0, ...list.map(v => Number(v.id) || 0)) + 1;
    // The version being replaced stays where its bytes already are. Because a run
    // publishes rather than overwrites, that is enough: the file it points at is not
    // going anywhere, so there is nothing to copy and nothing to roll back.
    const backAdopt = n.artifact ? adoptLegacy(workdir, n.id, n.artifact) : null;
    const back = n.artifact ? { ...(list[index]), id: ordinal, artifact: n.artifact, file: backAdopt.file, sources: n.sources || [], prompt: n.promptUsed ?? null, narration: n.narration ?? null } : null;
    if (back?.file) list.splice(index, 1, back); else list.splice(index, 1);
    // The instruction has to move with the bytes, and "no instruction recorded" is
    // itself a fact that has to move. A version kept before prompts were recorded
    // has `prompt: null`, and leaving `promptUsed` untouched there made the card
    // show the old picture while still claiming the instruction of the take it had
    // just replaced - the same lie in the other direction, and the first thing a
    // person meets after upgrading with two vintages of version on one card.
    //
    // The box (`prompt`) is different: it holds the next take the person is writing,
    // and a restore is not the moment to throw that away. It follows the chosen
    // version when that version knows what it was asked for, and is left alone when
    // it does not.
    const instruction = typeof chosen.prompt === "string"
      ? { prompt: chosen.prompt, promptUsed: chosen.prompt }
      : { promptUsed: null };
    // The narration evidence is provenance for the bytes, so it moves with them: restoring a
    // spoken take must restore what was measured about it, and restoring a tone take must
    // not leave the previous narration's numbers describing it.
    nodes[n.id] = nodeRecord(n.id, { ...n, ...instruction, artifact: chosen.file, sources: chosen.sources || [], narration: chosen.narration ?? null, versions: list, status: "idle", error: null }); save();
    // Only now that no record names the old path may it go: the copy is already
    // safe under versions/ and the card has already moved somewhere else.
    if (backAdopt?.retire) rmSync(join(workdir, String(n.id), backAdopt.retire), { force: true });
    emit({ kind: "restored", id: n.id, version: chosen.id });
    return json(res, 200, view());
  }
  if (url.pathname === "/api/clone" && req.method === "POST") { const b = await body(req), source = getNode(b.id), id = nextId(); nodes[id] = nodeRecord(id, { ...source, x: source.x + 40, y: source.y + 40, inputs: [...source.inputs], artifact: null, script: null, promptUsed: null, status: null, error: null }); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/delete" && req.method === "POST") { const b = await body(req); delete nodes[b.id]; for (const n of Object.values(nodes)) n.inputs = n.inputs.filter(id => id !== Number(b.id)); if (existsSync(join(workdir, String(b.id)))) rmSync(join(workdir, String(b.id)), { recursive: true, force: true }); if (existsSync(join(workdir, runsRoot, String(b.id)))) rmSync(join(workdir, runsRoot, String(b.id)), { recursive: true, force: true }); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/layout" && req.method === "POST") { Object.entries(nodes).forEach(([id, n], i) => { n.x = i % 4 * 340 + 40; n.y = Math.floor(i / 4) * 280 + 40; }); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/generate" && req.method === "POST") {
    const b = await body(req), n = getNode(b.id);
    // This run's workspace, captured before the first await past the body. Opening
    // another workspace replaces `workdir`/`nodes` for the rest of the process, and a
    // run that finishes afterwards must land in the workspace it was started in - see
    // `slot` above for the failure this was reproduced from.
    const ws = workdir;
    // The card as it stands at the press. Reading it again when the run finishes read
    // the *other* workspace's card if the person had switched away, so its kept takes
    // and its script became this run's starting point.
    const priorRecord = nodes[n.id];
    const priorVersions = [...(n.versions || [])];
    // Refuse a second run instead of spawning a second agent: two processes writing
    // the same node directory is how an artifact gets silently overwritten.
    //
    // The claim is taken here and nowhere later, and it is taken *synchronously*:
    // `body(req)` has awaited the request, but no other await has run yet, so two
    // presses that arrive together are decided one after the other and the second
    // sees the first. That slot is also the only place the cancel signal lives, so
    // Stop always has exactly one target. It used to be recorded only when the agent
    // was spawned, and everything before that - adopting the old take, copying
    // sources, guarding the card, which is seconds of work for a card holding an
    // 8 MiB picture - ran with nothing marked, so a second press in that window was
    // answered 202, got a run directory and a guard of its own, and the two runs
    // published v3 over each other.
    if (claimFor(n.id)) return json(res, 409, { ...view(), error: `Node ${n.id} is already generating` });
    const claim = { id: n.id, workdir: ws, agent: null, stopping: null, cancel: () => { claim.stopping = claim.stopping || new Error("Run stopped by the user"); return claim.agent ? claim.agent.cancel() : true; } };
    running.set(slot(ws, n.id), claim);
    // Every way out of this request after the claim is a reply to it - the 202, one
    // of the refusals, or the 400 the handler writes when preparing the run throws
    // (an unreadable source, a card the filesystem will not let us guard). A card
    // left claimed after a request that started nothing would say "already
    // generating" for the rest of the session, so the claim is dropped when the
    // reply goes out and no agent was ever made.
    res.on("finish", () => {
      if (claim.agent) return;
      releaseClaim(claim);
      // A refused press and a preparation that threw both leave nothing to recover:
      // the marker that names a run directory would otherwise sit in the card until
      // the next startup looked for a guard that was never finished.
      endRun(ws, n.id);
      if (attemptDirs.get(slot(ws, n.id))) dropAttempt(attemptDirs.get(slot(ws, n.id)));
      attemptDirs.delete(slot(ws, n.id));
    });
    // A method whose tool is not on this machine cannot produce anything, and the
    // audio card used to default to exactly such a method (`bark.cpp`, chosen because
    // it sorts first) on a machine with no `~/bark.cpp`. The press then failed with
    // the agent's own message about a missing file - after an attempt directory and a
    // run marker had already been made. Say which file is missing, before anything
    // exists, and point at the method that does work.
    const chosen = methodFor(n.type, n.method);
    if (chosen && chosen.available === false) {
      // Nothing was started, so the claim goes back before the refusal is written:
      // a card must not be left saying it is generating a run that does not exist.
      releaseClaim(claim);
      const fallback = methodsFor(n.type).find(m => m.available !== false);
      return json(res, 409, { ...view(), error: `${chosen.id} needs ${(chosen.requires || []).join(", ")} on this machine, which is not there, so nothing was started.${fallback ? ` Choose ${fallback.id} instead - it works with nothing installed.` : ""}` });
    }
    if (typeof b.prompt === "string") n.prompt = b.prompt;
    // Freeze what this run is given *now*. A film takes minutes; a person may
    const givenInputs = [...(n.inputs || [])];
    // Take the id from the key, not from the record: a node read back from
    // workspace.yml has no `id` field of its own (the map key is the id), so
    // using s.id wrote `null` for every source of a workspace loaded from disk -
    // which is exactly the ordinary case after a restart.
    const givenSources = givenInputs.filter(id => nodes[id]).map(id => ({ id: Number(id), type: nodes[id].type, artifact: nodes[id].artifact ?? null }));
    // Ids, not positions: restoring a version replaces an entry, so counting would
    // hand out an id that is already in the list.
    const ordinal = Math.max(0, ...(n.versions || []).map(v => Number(v.id) || 0)) + 1;
    // Freeze the material bytes now, under this run's number, and hand the agent the
    // copies. Whatever happens upstream from here - a regenerate, a hand-replaced
    // file - this run keeps reading the bytes it started with, so what it publishes
    // and what the card records can only describe the same thing. The first attempt
    // at this copied the material when the run *finished*, which recorded the newer
    // file a person had swapped in mid-render.
    // An older workspace keeps its artifact at the top of the node directory - the
    // exact name the agent renders to - so it is adopted into versions/ *and the card
    // is moved onto that name* before anything can overwrite it. The bytes then live
    // under a name no agent writes, and whatever the agent leaves on the old name is
    // an abandoned attempt that can be deleted.
    const adopted = n.artifact ? adoptLegacy(ws, n.id, n.artifact) : { file: null, retire: null };
    // A crash point for the one ordering that matters here, so a test can stand in
    // the exact window instead of hoping to hit a few microseconds: after the copy
    // exists, before the card names it. Only tests set this.
    if (process.env.HYPERMAKER_CRASH_AFTER_ADOPT === "1" && adopted.file && adopted.file !== n.artifact) process.exit(9);
    if (adopted.file && adopted.file !== n.artifact) { n.artifact = adopted.file; nodes[n.id] = nodeRecord(n.id, n); save(); }
    // After the save, never before: until the card names the copy, the old path is
    // the only thing that can still play the approved film.
    if (adopted.retire) rmSync(join(ws, String(n.id), adopted.retire), { force: true });
    // A linked input that has never been generated has no artifact, so there is
    // nothing to hand the agent. This used to crash the request with "path must be a
    // string, received null" - the canvas greyed the button out and said nothing,
    // and an empty attempt directory was left behind. Say which input is missing and
    // what would fix it, before anything is created.
    const drafts = givenSources.filter(s => !s.artifact);
    if (drafts.length) {
      releaseClaim(claim);
      const names = drafts.map(s => `#${s.id}`).join(", ");
      return json(res, 409, { ...view(), error: `Generate ${names} first, or unlink ${drafts.length > 1 ? "them" : "it"}: ${drafts.length > 1 ? "those cards have" : "that card has"} no result yet, so this run has no material to use.` });
    }
    // This run gets a directory of its own - and it is *not* inside the card. It used to
    // be, under `<card>/attempts/`, which put the agent's working directory inside the
    // directory holding a creator's own files; a probe found that an agent which tidied
    // its surroundings could delete one at the run's own path and still end idle. A run
    // now works in `<ws>/.runs/<card>/<start>`, so nothing it writes, renames or
    // deletes is next to what a person keeps, and the cleanup is still one recursive
    // delete of a directory the harness created.
    const attemptDir = beginRun(ws, n.id);
    attemptDirs.set(slot(ws, n.id), attemptDir);
    const runSources = freezeSources(ws, n.id, givenSources)
      // A source with no file has none because the card upstream holds nothing yet;
      // `frozen` is a path to a copy, and there is no copy to point at.
      .map(({ id, type, artifact, file }) => ({ id, type, artifact, file, frozen: file ? join(ws, String(n.id), file) : null }));
    // The second layer: a snapshot of every file the card held, taken once this run's
    // frozen material copies exist and before the agent starts. A path in a prompt is a
    // request, and `--sandbox danger-full-access` means an agent that ignores it can
    // still reach the card. If it does, the file is put back and the run says so instead
    // of reporting a clean success. The snapshot is taken here rather than earlier so the
    // material copies this run made are protected too, and it excludes the harness's own
    // bookkeeping (`run.json`, the prompt and logs) by name.
    // A hold in the longest-awaited step of the preparation, so a test can stand in
    // the window instead of racing a few milliseconds of file copying. Only tests set
    // it; it changes nothing about what happens, only when.
    if (process.env.HYPERMAKER_HOLD_BEFORE_GUARD_MS) await new Promise(r => setTimeout(r, Number(process.env.HYPERMAKER_HOLD_BEFORE_GUARD_MS)));
    const guard = await guardCard(join(ws, String(n.id)), join(attemptDir, guardName));
    // The card may have been stopped while the snapshot was being taken: there is no
    // process to signal yet, so the press is answerable now, before the run starts.
    if (claim.stopping) {
      // The run directory holds nothing but a guard for a run that never started; the
      // reply's own cleanup drops it. The marker goes now, because it is what a next
      // startup would follow.
      endRun(ws, n.id);
      releaseClaim(claim);
      attemptDirs.delete(slot(ws, n.id));
      nodes[n.id] = nodeRecord(n.id, { ...nodes[n.id], status: "cancelled", error: claim.stopping.message }); save();
      emit({ kind: "cancelled", id: n.id, error: claim.stopping.message });
      return json(res, 200, view());
    }
    // What this run could not protect, said now and not after the fact: a supervisor put
    // a 65 MiB clip next to a card, the run ended normally, and neither the receipt nor
    // the card mentioned that the file was outside the copy tier. The reply to the press
    // carries it, and it is put on the card with the run's own start, so it survives the
    // request that reported it.
    const protection = guardNotice(guard);
    // Kept on `n` as well, not only in `nodes`: the running record below is built from
    // `n`, and spreading the copy taken before this line dropped the notice - which is
    // exactly the silence the supervisor found, one layer down.
    n.notice = protection;
    // The artifact on the card becomes the alternative once this run succeeds.
    // `n.promptUsed`, not `n.prompt`: the box may already hold words for the next
    // take, and the film being kept was asked for something else. A version that
    // recorded the box would claim the wrong instruction for its own bytes.
    // The card was moved onto the published copy above, so this is already a name
    // nothing writes to. Referencing it by the same path is what keeps the kept
    // version and the card from being two different files.
    const kept = n.artifact ? { id: ordinal, artifact: n.artifact, file: n.artifact, sources: n.sources || [], prompt: n.promptUsed ?? null, narration: n.narration ?? null } : null;
    // Freezing the copies is this run's own bookkeeping, so its number must not be
    // reused - but publishing picks its own free name, above.
    // The card keeps pointing at the published artifact while the run works; only a
    // successful run moves it. Nothing the agent writes is visible until then, so a
    // run that dies halfway leaves the picture, the sound and their provenance as
    // they were - there is no copy to make and nothing to roll back.
    // `sources` is left describing the artifact that is still on the card. Writing
    // this run's material here meant a run cut off by a crash (no failure branch,
    // nothing to put back) left workspace.yml claiming the failed attempt's material
    // over the film a person had approved - a lie that outlived the process.
    const run = { ...n, inputs: givenInputs, status: "running", error: null };
    nodes[n.id] = nodeRecord(n.id, run); save(); emit({ kind: "started", id: n.id });
    // The prompt has to point at the frozen copies, not at the live card files. The
    // agent reads its material some time after this line - a film takes minutes -
    // and until this was wired up it read whatever the material card held *then*,
    // so a person who replaced a poster mid-render got a film made from the new
    // poster while the record named the old one.
    const promptNodes = { ...nodes };
    for (const source of runSources) if (source.frozen) promptNodes[source.id] = { ...nodes[source.id], frozen: source.frozen };
    const agent = runCodex({ node: run, workspace: { workdir: ws, nodes: promptNodes, projectCwd: root }, model: b.model, effort: b.effort, useGhPrefix: b.useGhPrefix, attemptDir });
    claim.agent = agent;
    // Stop pressed while the card was still being prepared: there was no process
    // yet, so the claim remembers the press and the run is stopped the moment it
    // exists. Without this a person who pressed Stop on a card holding a large
    // picture was told "not generating" and the run went ahead anyway.
    if (claim.stopping) agent.cancel();
    agent.then(async result => {
      // A narration card claims to have spoken a script. Check that claim against the bytes
      // before anything is published: the timeline must describe this WAV, and the WAV must
      // measure as speech. A card that fails becomes an error card with the reason on it,
      // and the take a person already had stays where it is - the same rule as any other
      // failure. This runs before `publish`, so nothing that fails the check is ever
      // reachable as an artifact on the canvas.
      // `materialText` reads the frozen copies the agent was given, not the live cards: what
      // matters is the words this run could see, and an upstream card edited during a render
      // must not be able to make the take that is already spoken look like it read the new
      // text. The material is what the script must be a selection of, and `from` is the card
      // whose words those were, recorded so a reopened canvas can say where they came from.
      const material = run.type === "audio" && run.method === "narration" ? materialText({ node: run, workspace: { workdir: ws, nodes: promptNodes } }) : null;
      const narration = material ? verifyNarration({ attemptDir, artifact: result.artifact, material: material.text, from: material.from }) : null;
      if (narration && !narration.ok) throw new Error(`This take is not a narration: ${narration.problems.join("; ")}`);
      // Before anything is published, the card is put back the way the run found it.
      // This is the check that matters to a person: the run was given their material to
      // read, and if it deleted or changed a file in the card's directory anyway, the
      // guard puts it back - and the result is *not* presented as a clean success.
      // Publishing is skipped rather than delayed: a run that modified material it was
      // told not to touch has not shown that its output describes that material, while
      // the take already on the card is still exactly what the person approved.
      const cardReport = await keepCard(join(ws, String(n.id)), join(attemptDir, guardName));
      const interference = damageReason(cardReport);
      if (interference) throw new Error(interference);
      // The finished bytes are published under a name no later run can write to, and
      // that is what the card shows. Whatever the agent left behind at its own
      // filename is scratch, and is free to be overwritten next time. `result.artifact`
      // is relative to the card, so it resolves to the run directory this run was given;
      // publish copies out of it into versions/.
      const published = publish(ws, n.id, result.artifact, attemptDir);
      const previous = kept?.file ? [...priorVersions, kept] : priorVersions;
      // The run is over and its result is published, so the marker that claims it is in
      // flight has to go before the outcome is saved.
      endRun(ws, n.id);
      // The script the card records has to outlive the run directory, or a finished take
      // would point at a file that no longer exists. It is small and it is how a person
      // reads what was actually run, so it is published next to the artifact it produced,
      // under the same number: `v2-shot.png` and `v2-render.mjs` are obviously one result.
      const publishedScript = result.script ? publishScript(ws, n.id, result.script, published, attemptDir) : null;
      // The take's own record, kept beside the bytes it describes. Without this a published
      // narration could not be re-verified after the fact: the timeline lived only in the
      // run directory, which is dropped as soon as the run succeeds, so
      // `voice/verify-take.mjs <node-dir>` - the command this project tells a person to use on
      // a card they already have - found no WAV at the top of the directory and no timeline
      // anywhere. Measured on a real workspace before the fix. Named by the take's ordinal, like
      // the script and the prompt: `v2-narration.wav` and `v2-narration.timeline.json`.
      if (published && existsSync(join(attemptDir, "timeline.json"))) {
        const takeNo = /^v(\d+)-/.exec(basename(published))?.[1];
        copyFileSync(join(attemptDir, "timeline.json"), join(ws, String(n.id), "versions", `${takeNo ? `v${takeNo}-` : ""}${basename(published).replace(/^v\d+-/, "").replace(/\.wav$/i, "")}.timeline.json`));
      }
      // The exact instruction this result was produced from, kept next to the take.
      // `promptUsed` says it in the record; this is the assembled prompt, which is what
      // a person reads when they want the whole thing rather than the one line.
      const askedFile = join(attemptDir, "prompt.txt");
      if (existsSync(askedFile)) {
        // Two copies with two jobs: the latest next to the card, so `prompt.txt`
        // always means "what the result on the card was asked" - where people and
        // earlier versions of this harness already look - and one per published take
        // under versions/, so an earlier take keeps its own words.
        copyFileSync(askedFile, join(ws, String(n.id), "prompt.txt"));
        if (published) copyFileSync(askedFile, join(ws, String(n.id), "versions", `v${/^v(\d+)-/.exec(basename(published))?.[1] ?? ""}-prompt.txt`));
      }
      const sources = runSources.map(({ id, type, artifact, file }) => ({ id, type, artifact, file }));
      // `inputs` is deliberately left as it is now: a link the person added during
      // the run is their preparation for the next one, not something this run gets
      // to undo. Only `sources` describes the artifact, and that comes from the set
      // frozen at start.
      // Release the run slot in the same synchronous step that publishes the
      // outcome. Writing `idle` first left a window where the card showed a finished
      // film while a second Generate was still refused with "already generating" -
      // publishing takes a copy, so that window got wide enough to hit every time.
      releaseClaim(claim);
      // What the person asked for *this* artifact, frozen at start exactly like the
      // material: `prompt` stays theirs to edit for the next take, `promptUsed`
      // answers "what is on screen and what was it asked to be".
      // The measured narration, when there was one: it describes the take being published, so
      // it moves with the artifact exactly like `sources` does, and it is cleared by any
      // later take that is not a narration.
      const priorScript = priorRecord.script ?? null;
      await finishIn(ws, n.id, { ...result, artifact: published || result.artifact, script: publishedScript ?? priorScript, sources, narration: narration?.evidence ?? null, promptUsed: run.prompt || "", versions: previous, status: "idle", error: null });
      // After the save, not before: the sweep asks the record what is still reachable,
      // so running it first deleted the script and the per-take prompt this run had
      // just written - the files that say what produced the take now on the card.
      // The record to sweep against is the one this run just settled, which is the open
      // graph only while the run's own workspace is still the open one.
      sweepVersions(ws, n.id, ws === workdir ? nodes[n.id] : readWorkspace(ws)[n.id]);
      // A successful run takes its scratch with it: what a person might want later is
      // the published take and the script beside it, both already under versions/.
      dropAttempt(attemptDir);
      pruneRuns(ws, n.id);
      // The guard did its job and its files are gone with the run directory.
      attemptDirs.delete(slot(ws, n.id));
      // A canvas that has moved on must not be repainted from another workspace.
      if (ws === workdir) emit({ kind: "complete", id: n.id });
    }).catch(async error => {
      const status = /stopped/i.test(error.message) ? "cancelled" : "error";
      // Nothing the failed run wrote was ever published, so the artifact, its
      // provenance and the kept versions are still exactly what they were. But the
      // run may still have deleted or changed a file in the card's directory - a
      // stopped or failing agent can be tidying when it dies - so the guard is read
      // back on this path too. A person who pressed Stop expects their own poster to
      // be there afterwards exactly as much as after a success.
      const report = await keepCard(join(ws, String(n.id)), join(attemptDir, guardName));
      const damaged = damageReason(report);
      // The abandoned run stays under .runs/ so a person can look at what it produced;
      // the count bound is what stops a hundred retries from filling a disk, and it is
      // the only place anything is deleted.
      endRun(ws, n.id);
      pruneRuns(ws, n.id);
      releaseClaim(claim);
      // A Stop stays a Stop even when the stopped run had been damaging the card: the
      // outcome is what the person did, and calling it an error would suggest the run
      // failed on its own. What the run touched is still on the card, in the same
      // sentence, because that is the part they would otherwise never learn.
      const reason = damaged ? `${error.message} ${damaged}` : error.message;
      await finishIn(ws, n.id, { sources: n.sources || null, status, error: reason });
      if (ws === workdir) emit({ kind: status === "cancelled" ? "cancelled" : "error", id: n.id, error: reason });
    }).finally(() => { releaseClaim(claim); attemptDirs.delete(slot(ws, n.id)); });
    // The press itself answers with the notice, so a person learns before the agent has
    // done any work that a large file is only protected against deletion. It is returned
    // here, after the completion handlers are attached: returning early skipped them and
    // left the run unable to ever settle.
    return json(res, 202, protection ? { ...view(), notice: protection } : view());
  }
  if (url.pathname === "/api/cancel" && req.method === "POST") {
    const b = await body(req), id = Number(b.id), agent = claimFor(id);
    if (!agent) return json(res, 409, { ...view(), error: `Node ${id} is not generating` });
    if (!agent.cancel()) return json(res, 409, { ...view(), error: `Node ${id} could not be stopped` });
    return json(res, 200, view());
  }
  const file = resolve(publicDir, url.pathname === "/" ? "index.html" : url.pathname.slice(1)); if (!file.startsWith(publicDir) || !existsSync(file)) return json(res, 404, { error: "Not found" }); res.writeHead(200, { "content-type": extname(file) === ".js" ? "text/javascript" : "text/html" }); res.end(readFileSync(file));
} catch (error) { json(res, 400, { error: error.message }); } });
export { server, assemblePrompt, runCodex };
export const assembledPrompt = assemblePrompt;
// `methodsFor` and `methodFor` come from the registry itself (it is what knows
// whether a method's tool is installed), so they are re-exported rather than wrapped:
// a wrapper that dropped `available` made this module disagree with the registry.
export { methodFor, methodsFor };
export const eventFromLine = () => null;
export const generate = runCodex;
export { registryInfo };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(workdir, { recursive: true });
  // Ctrl-C is how a local server usually ends. Stop the agents with it, so no
  // renderer keeps writing into a node directory after the server is gone.
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { for (const agent of running.values()) agent.cancel?.(); setTimeout(() => process.exit(0), 300).unref(); });
  console.log(`Hypermaker: http://${process.env.HYPERMAKER_HOST || "127.0.0.1"}:${process.env.PORT || 8787}`);
  server.listen(Number(process.env.PORT || 8787), process.env.HYPERMAKER_HOST || "127.0.0.1");
}
