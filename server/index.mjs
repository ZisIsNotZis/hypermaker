import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, copyFileSync, cpSync, rmSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkspace, writeWorkspace, nodeRecord } from "./workspace.mjs";
import { registryInfo, typeForFile } from "./registry.mjs";
import { assemblePrompt } from "./prompt.mjs";
import { generate as runCodex } from "./codex.mjs";

const root = resolve(new URL("..", import.meta.url).pathname), publicDir = join(root, "public"), defaultWorkdir = join(root, ".hypermaker");
let workdir = resolve(process.env.HYPERMAKER_WORKDIR || defaultWorkdir), nodes = readWorkspace(workdir);
if (process.env.NODE_ENV === "test" || process.env.HYPERMAKER_RESET_WORKSPACE === "1") nodes = {};
const clients = new Set(), runtime = new Map();
const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
const body = req => new Promise((ok, no) => { let data = ""; req.on("data", x => data += x); req.on("end", () => { try { ok(data ? JSON.parse(data) : {}); } catch (e) { no(e); } }); });
const nextId = () => Math.max(0, ...Object.keys(nodes).map(Number)) + 1;
const view = () => ({ workdir, nodes: Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, { ...nodeRecord(id, n), id: Number(id), workdir: existsSync(join(workdir, id)) ? join(workdir, id) : null, status: runtime.get(Number(id))?.status || (n.artifact ? "idle" : "draft"), error: runtime.get(Number(id))?.error || null }])) });
const save = () => writeWorkspace(workdir, nodes);
const emit = event => { const data = `data: ${JSON.stringify(event)}\n\n`; for (const client of clients) client.write(data); };
const getNode = id => { if (!nodes[id]) throw new Error("Node not found"); return { ...nodes[id], id: Number(id) }; };
function sendFile(res, file) { if (!existsSync(file)) return json(res, 404, { error: "File not found" }); const type = typeForFile(file), mime = type === "text" ? "text/plain; charset=utf-8" : ({ image: "image", audio: "audio", video: "video" }[type] || "application/octet-stream") + "/" + extname(file).slice(1); res.writeHead(200, { "content-type": mime }); createReadStream(file).pipe(res); }
const server = createServer(async (req, res) => { try {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); clients.add(res); req.on("close", () => clients.delete(res)); return; }
  if (url.pathname === "/api/registry") return json(res, 200, registryInfo());
  if (url.pathname === "/api/workspace" && req.method === "GET") return json(res, 200, view());
  if (url.pathname === "/api/workspace" && req.method === "POST") { const b = await body(req); workdir = resolve(b.workdir || defaultWorkdir); nodes = readWorkspace(workdir); return json(res, 200, view()); }
  if (url.pathname === "/api/file") { const file = resolve(url.searchParams.get("path") || ""); const rel = relative(resolve(workdir), file); if (rel.startsWith("..") || rel.startsWith("/")) throw new Error("File outside workspace"); return sendFile(res, file); }
  if (url.pathname === "/api/node" && req.method === "POST") { const b = await body(req), id = nextId(); nodes[id] = nodeRecord(id, { ...b, inputs: [], method: b.method || "llm", quality: b.quality || "standard" }); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/import" && req.method === "POST") { const b = await body(req), id = nextId(), type = typeForFile(b.path); if (!type) throw new Error("Unsupported asset type"); const name = String(b.path).split(/[\\/]/).pop(); mkdirSync(join(workdir, String(id)), { recursive: true }); copyFileSync(resolve(b.path), join(workdir, String(id), name)); nodes[id] = nodeRecord(id, { x: b.x, y: b.y, type, inputs: [], artifact: name }); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/link" && req.method === "POST") { const b = await body(req), target = getNode(b.target); if (Number(b.source) !== Number(b.target) && !target.inputs.includes(Number(b.source))) target.inputs.push(Number(b.source)); nodes[b.target] = target; save(); return json(res, 200, view()); }
  if (url.pathname === "/api/unlink" && req.method === "POST") { const b = await body(req), target = getNode(b.target); target.inputs = target.inputs.filter(id => id !== Number(b.source)); nodes[b.target] = target; save(); return json(res, 200, view()); }
  if (url.pathname === "/api/node" && req.method === "PATCH") { const b = await body(req), n = getNode(b.id); Object.assign(n, b); nodes[b.id] = nodeRecord(b.id, n); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/clone" && req.method === "POST") { const b = await body(req), source = getNode(b.id), id = nextId(); nodes[id] = nodeRecord(id, { ...source, x: source.x + 40, y: source.y + 40, inputs: [...source.inputs], artifact: null, script: null }); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/delete" && req.method === "POST") { const b = await body(req); delete nodes[b.id]; for (const n of Object.values(nodes)) n.inputs = n.inputs.filter(id => id !== Number(b.id)); if (existsSync(join(workdir, String(b.id)))) rmSync(join(workdir, String(b.id)), { recursive: true, force: true }); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/layout" && req.method === "POST") { Object.entries(nodes).forEach(([id, n], i) => { n.x = i % 4 * 340 + 40; n.y = Math.floor(i / 4) * 280 + 40; }); save(); return json(res, 200, view()); }
  if (url.pathname === "/api/generate" && req.method === "POST") { const b = await body(req), n = getNode(b.id); if (typeof b.prompt === "string") n.prompt = b.prompt; runtime.set(n.id, { status: "running" }); nodes[n.id] = nodeRecord(n.id, n); save(); emit({ kind: "started", id: n.id }); runCodex({ node: n, workspace: { workdir, nodes: { ...nodes }, projectCwd: root }, model: b.model, effort: b.effort, useGhPrefix: b.useGhPrefix }).then(result => { nodes[n.id] = { ...n, ...result }; runtime.set(n.id, { status: "idle" }); save(); emit({ kind: "complete", id: n.id }); }).catch(error => { runtime.set(n.id, { status: "error", error: error.message }); nodes[n.id] = { ...nodes[n.id], error: error.message }; save(); emit({ kind: "error", id: n.id, error: error.message }); }); return json(res, 202, view()); }
  const file = resolve(publicDir, url.pathname === "/" ? "index.html" : url.pathname.slice(1)); if (!file.startsWith(publicDir) || !existsSync(file)) return json(res, 404, { error: "Not found" }); res.writeHead(200, { "content-type": extname(file) === ".js" ? "text/javascript" : "text/html" }); res.end(readFileSync(file));
} catch (error) { json(res, 400, { error: error.message }); } });
export { server, assemblePrompt, runCodex };
export const assembledPrompt = assemblePrompt;
export const methodsFor = type => registryInfo().methods[type] || [];
export const eventFromLine = () => null;
export const discover = () => new Map();
export const generate = runCodex;
export { registryInfo };
if (process.argv[1] === fileURLToPath(import.meta.url)) { mkdirSync(workdir, { recursive: true }); console.log(`Hypermaker: http://${process.env.HYPERMAKER_HOST || "127.0.0.1"}:${process.env.PORT || 8787}`); server.listen(Number(process.env.PORT || 8787), process.env.HYPERMAKER_HOST || "127.0.0.1"); }
