import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
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
function adopt(graph) {
  for (const [id, node] of Object.entries(graph)) {
    if (node.status === "running") graph[id] = { ...node, status: "error", error: "Run interrupted: the server stopped before the agent finished" };
  }
  return graph;
}
const cut = Object.values(nodes).some(n => n.status === "running");
nodes = adopt(nodes);
if (cut) writeWorkspace(workdir, nodes);
// A run is the only thing in this server that outlives one request, so it is kept
// in one place: `running` maps a node id to the agent promise (whose cancel()
// stops the whole process group). Nothing else may start a second run for the
// same node while it is there.
const clients = new Set(), running = new Map();
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
function publish(workdir, id, artifact) {
  if (!artifact) return null;
  const dir = join(workdir, String(id)), source = join(dir, artifact);
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
// An artifact from before this change lives at the top of its node directory. It
// is still perfectly good bytes, so it is adopted into `versions/` once, on first
// use, rather than left as the one file a new run is allowed to overwrite.
function adoptLegacy(workdir, id, artifact) {
  if (!artifact || artifact.startsWith("versions/")) return artifact;
  const dir = join(workdir, String(id));
  return existsSync(join(dir, artifact)) ? (publish(workdir, id, artifact, 0) || artifact) : artifact;
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
const view = () => ({ workdir, nodes: Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, { ...nodeRecord(id, n), id: Number(id), workdir: existsSync(join(workdir, id)) ? join(workdir, id) : null, status: running.has(Number(id)) ? "running" : (n.status || (n.artifact ? "idle" : "draft")) }])) });
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
  if (url.pathname === "/api/workspace" && req.method === "POST") { const b = await body(req); workdir = resolve(b.workdir || defaultWorkdir); nodes = adopt(readWorkspace(workdir)); writeWorkspace(workdir, nodes); idCounter = Math.max(0, ...Object.keys(nodes).map(Number)); return json(res, 200, view()); }
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
    const back = n.artifact ? { ...(list[index]), id: ordinal, artifact: n.artifact, file: adoptLegacy(workdir, n.id, n.artifact), sources: n.sources || [], prompt: n.promptUsed ?? null } : null;
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
    nodes[n.id] = nodeRecord(n.id, { ...n, ...instruction, artifact: chosen.file, sources: chosen.sources || [], versions: list, status: "idle", error: null }); save(); emit({ kind: "restored", id: n.id, version: chosen.id });
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
    const runSources = freezeSources(workdir, n.id, givenSources)
      .map(({ id, type, artifact, file }) => ({ id, type, artifact, file, frozen: join(workdir, String(n.id), file) }));
    // The artifact on the card becomes the alternative once this run succeeds. An
    // older workspace keeps its artifact at the top of the node directory, which a
    // new run may write over, so it is adopted into versions/ on first use.
    // `n.promptUsed`, not `n.prompt`: the box may already hold words for the next
    // take, and the film being kept was asked for something else. A version that
    // recorded the box would claim the wrong instruction for its own bytes.
    const kept = n.artifact ? { id: ordinal, artifact: n.artifact, file: adoptLegacy(workdir, n.id, n.artifact), sources: n.sources || [], prompt: n.promptUsed ?? null } : null;
    // Freezing the copies is this run's own bookkeeping, so its number must not be
    // reused - but publishing picks its own free name, above.
    // The card keeps pointing at the published artifact while the run works; only a
    // successful run moves it. Nothing the agent writes is visible until then, so a
    // run that dies halfway leaves the picture, the sound and their provenance as
    // they were - there is no copy to make and nothing to roll back.
    const run = { ...n, inputs: givenInputs, sources: runSources, status: "running", error: null };
    nodes[n.id] = nodeRecord(n.id, run); save(); emit({ kind: "started", id: n.id });
    // The prompt has to point at the frozen copies, not at the live card files. The
    // agent reads its material some time after this line - a film takes minutes -
    // and until this was wired up it read whatever the material card held *then*,
    // so a person who replaced a poster mid-render got a film made from the new
    // poster while the record named the old one.
    const promptNodes = { ...nodes };
    for (const source of runSources) if (source.frozen) promptNodes[source.id] = { ...nodes[source.id], frozen: source.frozen };
    const agent = runCodex({ node: run, workspace: { workdir, nodes: promptNodes, projectCwd: root }, model: b.model, effort: b.effort, useGhPrefix: b.useGhPrefix });
    running.set(n.id, agent);
    agent.then(result => {
      // The finished bytes are published under a name no later run can write to, and
      // that is what the card shows. Whatever the agent left behind at its own
      // filename is scratch, and is free to be overwritten next time.
      const published = publish(workdir, n.id, result.artifact);
      const previous = kept?.file ? [...(nodes[n.id].versions || []), kept] : (nodes[n.id].versions || []);
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
      nodes[n.id] = nodeRecord(n.id, { ...nodes[n.id], ...result, artifact: published || result.artifact, sources, promptUsed: run.prompt || "", versions: previous, status: "idle", error: null }); save(); emit({ kind: "complete", id: n.id });
    }).catch(error => {
      const status = /stopped/i.test(error.message) ? "cancelled" : "error";
      // Nothing the failed run wrote was ever published, so the artifact, its
      // provenance and the kept versions are still exactly what they were. What has
      // to go is this run's frozen material copies: they describe a run that
      // produced nothing, and leaving them would grow versions/ with every failure.
      for (const source of runSources) if (source.file) rmSync(join(workdir, String(n.id), source.file), { force: true });
      running.delete(n.id);
      nodes[n.id] = nodeRecord(n.id, { ...nodes[n.id], sources: n.sources || null, status, error: error.message }); save(); emit({ kind: status === "cancelled" ? "cancelled" : "error", id: n.id, error: error.message });
    }).finally(() => running.delete(n.id));
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
