import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkspace, writeWorkspace, nodeRecord } from "./workspace.mjs";
import { registryInfo, typeForFile } from "./registry.mjs";
import { assemblePrompt } from "./prompt.mjs";
import { generate as runCodex } from "./codex.mjs";

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
function adopt(graph, dir = workdir) {
  for (const [id, node] of Object.entries(graph)) {
    if (node.status === "running") { recover(dir, id, node); graph[id] = { ...node, status: "error", error: "Run interrupted: the server stopped before the agent finished" }; }
    else recover(dir, id, node);
  }
  return graph;
}
// A run is the only thing in this server that outlives one request, so it is kept
// in one place: `running` maps a node id to the agent promise (whose cancel()
// stops the whole process group). Nothing else may start a second run for the
// same node while it is there.
const clients = new Set(), running = new Map();
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
  for (const rel of readdirSync(dir)) {
    const file = join(dir, rel);
    try { if (!statSync(file).isFile()) continue; } catch { continue; }
    if (live.has(rel) || keepPrompt(rel)) continue;
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
// Every run writes into `attempts/<started>/` under its card. The card's own
// directory then holds only what a person put there: the artifacts they kept, the
// versions, and anything they copied in themselves. That separation is what makes
// cleanup decidable - a directory the harness created can be removed whole, and a
// file next to the card's artifacts is never touched, so a creator's own material
// keeps the path they know and does not go missing after the fourth retry.
const attemptsRoot = "attempts";
// A run that is cut off by the process dying has no failure branch. This marker is
// how the next startup knows a directory under attempts/ is dead rather than live.
const runMarker = "run.json";
function beginAttempt(workdir, id, attemptDir) {
  const startedAt = Number(basename(attemptDir)) || Date.now();
  writeFileSync(join(workdir, String(id), runMarker), JSON.stringify({ startedAt, dir: join(attemptsRoot, basename(attemptDir)), pid: process.pid }), "utf8");
}
// One run's directory, gone. Anything worth keeping was already copied out of it
// by `publish` before this is called, so there is nothing here to preserve.
function dropAttempt(dir) {
  if (dir) rmSync(dir, { recursive: true, force: true });
}
// Abandoned attempts are kept for a while and then dropped, because a person who
// mistyped a prompt may want to look at what the agent actually produced. The bound
// is a count, not a timestamp: five most recent is enough to recover from and small
// enough that fifty tries cannot fill a disk.
const keepAttempts = 5;
function pruneAttempts(workdir, id) {
  const root = join(workdir, String(id), attemptsRoot);
  if (!existsSync(root)) return;
  const dirs = readdirSync(root).map(Number).filter(n => !Number.isNaN(n)).sort((a, b) => b - a);
  for (const stale of dirs.slice(keepAttempts)) rmSync(join(root, String(stale)), { recursive: true, force: true });
}
// A crash leaves the card marked running and its attempt directory behind. The
// marker names that directory, so recovery moves exactly it aside - no guessing -
// and the card's own files are not involved at all.
function recover(workdir, id, node) {
  const dir = join(workdir, String(id)), marker = join(dir, runMarker);
  if (existsSync(marker)) {
    rmSync(marker, { force: true });
    // The cut-off attempt stays under attempts/ like any other discarded one - a
    // person can look at what it rendered - and the count bound keeps that finite.
    pruneAttempts(workdir, id);
  }
  sweepVersions(workdir, id, node);
}
const cut = Object.values(nodes).some(n => n.status === "running");
nodes = adopt(nodes, workdir);
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
const view = () => ({ workdir, nodes: Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, { ...nodeRecord(id, n), id: Number(id), workdir: existsSync(join(workdir, id)) ? join(workdir, id) : null, status: running.has(Number(id)) ? "running" : (n.status || (n.artifact ? "idle" : "draft")), attempt: attemptDirs.get(Number(id)) ?? null }])) });
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
const server = createServer(async (req, res) => { try {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); clients.add(res); req.on("close", () => clients.delete(res)); return; }
  if (url.pathname === "/api/registry") return json(res, 200, registryInfo());
  if (url.pathname === "/api/workspace" && req.method === "GET") return json(res, 200, view());
  if (url.pathname === "/api/workspace" && req.method === "POST") { const b = await body(req); workdir = resolve(b.workdir || defaultWorkdir); nodes = adopt(readWorkspace(workdir), workdir); writeWorkspace(workdir, nodes); idCounter = Math.max(0, ...Object.keys(nodes).map(Number)); return json(res, 200, view()); }
  if (url.pathname === "/api/file") { const file = resolve(url.searchParams.get("path") || ""); const rel = relative(resolve(workdir), file); if (rel.startsWith("..") || rel.startsWith("/")) throw new Error("File outside workspace"); return sendFile(req, res, file); }
  if (url.pathname === "/api/node" && req.method === "POST") { const b = await body(req), id = nextId(); nodes[id] = nodeRecord(id, { ...b, inputs: [], method: b.method || "llm", quality: b.quality || "standard" }); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/import" && req.method === "POST") { const b = await body(req), id = nextId(), type = typeForFile(b.path); if (!type) throw new Error("Unsupported asset type"); const name = String(b.path).split(/[\\/]/).pop(); mkdirSync(join(workdir, String(id)), { recursive: true }); copyFileSync(resolve(b.path), join(workdir, String(id), name)); nodes[id] = nodeRecord(id, { x: b.x, y: b.y, type, inputs: [], artifact: name }); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/link" && req.method === "POST") { const b = await body(req), target = getNode(b.target); if (Number(b.source) !== Number(b.target) && !target.inputs.includes(Number(b.source))) target.inputs.push(Number(b.source)); nodes[b.target] = target; save(); return json(res, 200, view()); }
  if (url.pathname === "/api/unlink" && req.method === "POST") { const b = await body(req), target = getNode(b.target); target.inputs = target.inputs.filter(id => id !== Number(b.source)); nodes[b.target] = target; save(); return json(res, 200, view()); }
  // status/error belong to the run, not to the client: a card's prompt or position
  // edit must never be able to claim a run succeeded or erase a failure.
  if (url.pathname === "/api/node" && req.method === "PATCH") { const b = await body(req), n = getNode(b.id); delete b.status; delete b.error; delete b.promptUsed; Object.assign(n, b);
    // Changing the output type drops the artifact (a PNG cannot be a soundtrack).
    // `promptUsed` describes an artifact, so it goes with it; leaving it behind
    // would let the next Generate keep that prompt as "the version it replaced".
    if (n.artifact == null) n.promptUsed = null;
    nodes[b.id] = nodeRecord(b.id, n); save(); return json(res, 200, view()); }
  // Going back must move the provenance with the bytes. Restoring only the file
  // would leave the card claiming the newest film's materials over an older
  // picture - the same lie the frozen-source work was about. The instruction is
  // provenance too: a person who had asked for a sea film and then for a mountain
  // one must not be shown the sea film under the mountain words, or the next
  // Generate silently re-does a take they thought they were looking at.
  if (url.pathname === "/api/restore" && req.method === "POST") {
    const b = await body(req), n = getNode(b.id);
    if (running.has(n.id)) return json(res, 409, { ...view(), error: `Node ${n.id} is generating; stop it before going back to an earlier version` });
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
    const back = n.artifact ? { ...(list[index]), id: ordinal, artifact: n.artifact, file: backAdopt.file, sources: n.sources || [], prompt: n.promptUsed ?? null } : null;
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
    nodes[n.id] = nodeRecord(n.id, { ...n, ...instruction, artifact: chosen.file, sources: chosen.sources || [], versions: list, status: "idle", error: null }); save();
    // Only now that no record names the old path may it go: the copy is already
    // safe under versions/ and the card has already moved somewhere else.
    if (backAdopt?.retire) rmSync(join(workdir, String(n.id), backAdopt.retire), { force: true });
    emit({ kind: "restored", id: n.id, version: chosen.id });
    return json(res, 200, view());
  }
  if (url.pathname === "/api/clone" && req.method === "POST") { const b = await body(req), source = getNode(b.id), id = nextId(); nodes[id] = nodeRecord(id, { ...source, x: source.x + 40, y: source.y + 40, inputs: [...source.inputs], artifact: null, script: null, promptUsed: null, status: null, error: null }); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/delete" && req.method === "POST") { const b = await body(req); delete nodes[b.id]; for (const n of Object.values(nodes)) n.inputs = n.inputs.filter(id => id !== Number(b.id)); if (existsSync(join(workdir, String(b.id)))) rmSync(join(workdir, String(b.id)), { recursive: true, force: true }); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/layout" && req.method === "POST") { Object.entries(nodes).forEach(([id, n], i) => { n.x = i % 4 * 340 + 40; n.y = Math.floor(i / 4) * 280 + 40; }); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/generate" && req.method === "POST") {
    const b = await body(req), n = getNode(b.id);
    // Refuse a second run instead of spawning a second agent: two processes writing
    // the same node directory is how an artifact gets silently overwritten.
    if (running.has(n.id)) return json(res, 409, { ...view(), error: `Node ${n.id} is already generating` });
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
    const adopted = n.artifact ? adoptLegacy(workdir, n.id, n.artifact) : { file: null, retire: null };
    // A crash point for the one ordering that matters here, so a test can stand in
    // the exact window instead of hoping to hit a few microseconds: after the copy
    // exists, before the card names it. Only tests set this.
    if (process.env.HYPERMAKER_CRASH_AFTER_ADOPT === "1" && adopted.file && adopted.file !== n.artifact) process.exit(9);
    if (adopted.file && adopted.file !== n.artifact) { n.artifact = adopted.file; nodes[n.id] = nodeRecord(n.id, n); save(); }
    // After the save, never before: until the card names the copy, the old path is
    // the only thing that can still play the approved film.
    if (adopted.retire) rmSync(join(workdir, String(n.id), adopted.retire), { force: true });
    // A linked input that has never been generated has no artifact, so there is
    // nothing to hand the agent. This used to crash the request with "path must be a
    // string, received null" - the canvas greyed the button out and said nothing,
    // and an empty attempt directory was left behind. Say which input is missing and
    // what would fix it, before anything is created.
    const drafts = givenSources.filter(s => !s.artifact);
    if (drafts.length) {
      const names = drafts.map(s => `#${s.id}`).join(", ");
      return json(res, 409, { ...view(), error: `Generate ${names} first, or unlink ${drafts.length > 1 ? "them" : "it"}: ${drafts.length > 1 ? "those cards have" : "that card has"} no result yet, so this run has no material to use.` });
    }
    // This run gets a directory of its own, under the card's. Everything the agent
    // writes goes there, so throwing an attempt away is one recursive delete of a
    // directory the harness created - not a guess about which files in a shared
    // folder belong to the creator. That guess is what used to lose a person's own
    // material, or move it somewhere the path they knew stopped working. The card's
    // directory now holds only what a person put there.
    const attemptDir = join(workdir, String(n.id), attemptsRoot, String(Date.now()));
    mkdirSync(attemptDir, { recursive: true });
    attemptDirs.set(n.id, attemptDir);
    // Before the agent starts, not after: a run can die at any moment after this
    // line, and the record has to be on disk for a later startup to reclaim it.
    beginAttempt(workdir, n.id, attemptDir);
    const runSources = freezeSources(workdir, n.id, givenSources)
      // A source with no file has none because the card upstream holds nothing yet;
      // `frozen` is a path to a copy, and there is no copy to point at.
      .map(({ id, type, artifact, file }) => ({ id, type, artifact, file, frozen: file ? join(workdir, String(n.id), file) : null }));
    // The artifact on the card becomes the alternative once this run succeeds.
    // `n.promptUsed`, not `n.prompt`: the box may already hold words for the next
    // take, and the film being kept was asked for something else. A version that
    // recorded the box would claim the wrong instruction for its own bytes.
    // The card was moved onto the published copy above, so this is already a name
    // nothing writes to. Referencing it by the same path is what keeps the kept
    // version and the card from being two different files.
    const kept = n.artifact ? { id: ordinal, artifact: n.artifact, file: n.artifact, sources: n.sources || [], prompt: n.promptUsed ?? null } : null;
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
    const agent = runCodex({ node: run, workspace: { workdir, nodes: promptNodes, projectCwd: root }, model: b.model, effort: b.effort, useGhPrefix: b.useGhPrefix, attemptDir });
    running.set(n.id, agent);
    agent.then(result => {
      // The finished bytes are published under a name no later run can write to, and
      // that is what the card shows. Whatever the agent left behind at its own
      // filename is scratch, and is free to be overwritten next time.
      // `result.artifact` is relative to the card, so it resolves to the attempt
      // directory this run was given; publish copies out of it into versions/.
      const published = publish(workdir, n.id, result.artifact, attemptDir);
      const previous = kept?.file ? [...(nodes[n.id].versions || []), kept] : (nodes[n.id].versions || []);
      rmSync(join(workdir, String(n.id), runMarker), { force: true });
      // The run is over and its result is published, so its working directory has
      // done its job. What a person might want to inspect afterwards - the script
      // the agent wrote - is the script the card records; everything else here is
      // scratch that would otherwise accumulate once per successful take too.
      // The script the card records has to outlive the attempt directory, or a
      // finished take would point at a file that no longer exists. It is small and
      // it is how a person reads what was actually run, so it is published next to
      // the artifact it produced.
      const publishedScript = result.script ? publishScript(workdir, n.id, result.script, published, attemptDir) : null;
      // The exact instruction this result was produced from, kept next to the take.
      // `promptUsed` says it in the record; this is the assembled prompt, which is what
      // a person reads when they want the whole thing rather than the one line.
      const askedFile = join(attemptDir, "prompt.txt");
      if (existsSync(askedFile)) {
        // Two copies with two jobs: the latest next to the card, so `prompt.txt`
        // always means "what the result on the card was asked" - where people and
        // earlier versions of this harness already look - and one per published take
        // under versions/, so an earlier take keeps its own words.
        copyFileSync(askedFile, join(workdir, String(n.id), "prompt.txt"));
        if (published) copyFileSync(askedFile, join(workdir, String(n.id), "versions", `v${/^v(\d+)-/.exec(basename(published))?.[1] ?? ""}-prompt.txt`));
      }
      dropAttempt(attemptDir);
      pruneAttempts(workdir, n.id);
      const sources = runSources.map(({ id, type, artifact, file }) => ({ id, type, artifact, file }));
      // `inputs` is deliberately left as it is now: a link the person added during
      // the run is their preparation for the next one, not something this run gets
      // to undo. Only `sources` describes the artifact, and that comes from the set
      // frozen at start.
      // Release the run slot in the same synchronous step that publishes the
      // outcome. Writing `idle` first left a window where the card showed a finished
      // film while a second Generate was still refused with "already generating" -
      // publishing takes a copy, so that window got wide enough to hit every time.
      running.delete(n.id);
      // What the person asked for *this* artifact, frozen at start exactly like the
      // material: `prompt` stays theirs to edit for the next take, `promptUsed`
      // answers "what is on screen and what was it asked to be".
      nodes[n.id] = nodeRecord(n.id, { ...nodes[n.id], ...result, artifact: published || result.artifact, script: publishedScript ?? nodes[n.id].script ?? null, sources, promptUsed: run.prompt || "", versions: previous, status: "idle", error: null }); save();
      // After the save, not before: the sweep asks the record what is still reachable,
      // so running it first deleted the script and the per-take prompt this run had
      // just written - the files that say what produced the take now on the card.
      sweepVersions(workdir, n.id, nodes[n.id]);
      emit({ kind: "complete", id: n.id });
    }).catch(error => {
      const status = /stopped/i.test(error.message) ? "cancelled" : "error";
      // Nothing the failed run wrote was ever published, so the artifact, its
      // provenance and the kept versions are still exactly what they were. The
      // abandoned attempt stays under attempts/ so a person can look at what it
      // produced; the count bound is what stops a hundred retries from filling a
      // disk, and it is the only place anything is deleted.
      // The marker is this run's claim that it is still in flight. Its failure
      // branch has now run, so the claim is false and must go: leaving it would make
      // the next startup treat a finished attempt as a crash.
      rmSync(join(workdir, String(n.id), runMarker), { force: true });
      pruneAttempts(workdir, n.id);
      running.delete(n.id);
      nodes[n.id] = nodeRecord(n.id, { ...nodes[n.id], sources: n.sources || null, status, error: error.message }); save(); emit({ kind: status === "cancelled" ? "cancelled" : "error", id: n.id, error: error.message });
    }).finally(() => { running.delete(n.id); attemptDirs.delete(n.id); });
    return json(res, 202, view());
  }
  if (url.pathname === "/api/cancel" && req.method === "POST") {
    const b = await body(req), id = Number(b.id), agent = running.get(id);
    if (!agent) return json(res, 409, { ...view(), error: `Node ${id} is not generating` });
    if (!agent.cancel()) return json(res, 409, { ...view(), error: `Node ${id} could not be stopped` });
    return json(res, 200, view());
  }
  const file = resolve(publicDir, url.pathname === "/" ? "index.html" : url.pathname.slice(1)); if (!file.startsWith(publicDir) || !existsSync(file)) return json(res, 404, { error: "Not found" }); res.writeHead(200, { "content-type": extname(file) === ".js" ? "text/javascript" : "text/html" }); res.end(readFileSync(file));
} catch (error) { json(res, 400, { error: error.message }); } });
export { server, assemblePrompt, runCodex };
export const assembledPrompt = assemblePrompt;
export const methodsFor = type => registryInfo().methods[type] || [];
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
