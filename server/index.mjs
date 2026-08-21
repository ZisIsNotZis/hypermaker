import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)), projectDir = resolve(root, "..");
const publicDir = join(root, "../public"), nodeRoot = resolve(root, "../.hypermaker/nodes"), logPath = resolve(root, "../dev.log");
const runs = new Map(), canvases = new Map(), clients = new Set();
const registryRoot = resolve(projectDir, "types");
const registryTypes = readdirSync(registryRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
const typeEntries = await Promise.all(registryTypes.map(async entry => [entry.name, (await import(pathToFileURL(join(registryRoot, entry.name, "index.mjs")))).type]));
export const typeRegistry = new Map(typeEntries);
const methodEntries = (await Promise.all(registryTypes.map(async entry => {
  const methodRoot = join(registryRoot, entry.name, "methods");
  return Promise.all(readdirSync(methodRoot).filter(file => file.endsWith(".mjs")).map(async file => [`${entry.name}/${file.slice(0, -4)}`, (await import(pathToFileURL(join(methodRoot, file)))).method]));
}))).flat();
export const methodRegistry = new Map(methodEntries);
export const types = new Map([...typeRegistry.values()].flatMap(type => type.extensions.map(ext => [ext, type.id])));
const supported = [...typeRegistry.keys()];
const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
const typeOf = path => typeof path === "string" ? types.get(extname(path).toLowerCase()) : undefined;
const canonical = path => realpathSync(resolve(String(path)));
const inside = (child, parent) => { const value = relative(resolve(parent), resolve(child)); return value === "" || (!value.startsWith("..") && !value.startsWith("/")); };
export const methodsFor = type => [...methodRegistry].filter(([key]) => key.startsWith(`${type}/`)).map(([, method]) => method.id);
export const methods = Object.fromEntries([...typeRegistry.keys()].map(type => [type, methodsFor(type)]));
export const codexModels = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];
export const codexEfforts = ["none", "low", "medium", "high", "xhigh", "max", "ultra"];
const defaultModel = codexModels[0], defaultEffort = "medium";
export const registryInfo = { types: [...typeRegistry.values()], methods, models: codexModels, efforts: codexEfforts, defaults: { model: defaultModel, effort: defaultEffort } };
const normalizeModel = value => { const model = typeof value === "string" ? value.replace(/^gh\//, "") : ""; return codexModels.includes(model) ? model : defaultModel; };
const ensureNodeDir = workdir => { mkdirSync(workdir, { recursive: true }); return workdir; };
const layoutSize = { width: 300, height: 520, gapX: 60, gapY: 60 };
function layoutNodes(items) {
  const ids = new Map(items.map(n => [n.path || n.id, n])), depth = new Map(), visiting = new Set();
  const getDepth = n => { if (!n) return 0; const id = n.path || n.id; if (depth.has(id)) return depth.get(id); if (visiting.has(id)) return 0; visiting.add(id); const d = Math.max(-1, ...Object.values(n.inputs || {}).map(source => getDepth(ids.get(source))).filter(Number.isFinite)) + 1; visiting.delete(id); depth.set(id, d); return d; };
  items.forEach(getDepth);
  const columns = new Map(); for (const n of items) { const d = depth.get(n.path || n.id) || 0; if (!columns.has(d)) columns.set(d, []); columns.get(d).push(n); }
  for (const [d, column] of columns) column.forEach((n, i) => { n.position = { x: 40 + d * (layoutSize.width + layoutSize.gapX), y: 40 + i * (layoutSize.height + layoutSize.gapY) }; });
  for (let pass = 0; pass < items.length * 2; pass++) { let changed = false; for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) { const a = items[i], b = items[j], ap = a.position, bp = b.position; if (Math.abs(ap.x - bp.x) >= layoutSize.width || Math.abs(ap.y - bp.y) >= layoutSize.height) continue; const push = (layoutSize.height + layoutSize.gapY - Math.abs(ap.y - bp.y)) / 2; if (ap.y <= bp.y) { ap.y -= push; bp.y += push; } else { ap.y += push; bp.y -= push; } changed = true; } if (!changed) break; }
  return items;
}
function logEvent(event) { if (!event) return; const line = `[${new Date().toISOString()}] ${event.path ? `[${event.path}] ` : ""}${event.kind}: ${JSON.stringify(event)}`; console.log(line); appendFileSync(logPath, line + "\n"); const data = `data: ${JSON.stringify(event)}\n\n`; for (const client of clients) client.write(data); }
function logRaw(path, stream, line) { const output = `[${new Date().toISOString()}] [${path}] codex_raw_${stream}: ${line}`; console.log(output); appendFileSync(logPath, output + "\n"); }
const emit = event => { if (!event) return null; if (event.kind === "complete" && !event.nodeId) event.nodeId = event.path; logEvent(event); return event; };
function readManifest(artifact) { const path = join(dirname(artifact), "manifest.json"); if (!existsSync(path)) return null; try { const value = JSON.parse(readFileSync(path, "utf8")); return value && value.version === 1 && value.inputs && typeof value.inputs === "object" ? { path, value } : { path, error: "Unsupported manifest" }; } catch (error) { return { path, error: error.message }; } }
export function discover(input, nodes = new Map(), stack = new Set()) { let path; try { path = canonical(input); } catch { return nodes; } if (nodes.has(path)) return nodes; const type = typeOf(path), manifest = type ? readManifest(path) : null; const node = { id: path, path, type: type || "unknown", inputs: {}, status: type ? (manifest?.error ? "warning" : "idle") : "error", trajectory: [], position: { x: nodes.size * 300, y: 80 } }; nodes.set(path, node); if (!type) return Object.assign(node, { error: "Unsupported artifact type" }), nodes; if (manifest?.value) { node.prompt = manifest.value.prompt || ""; node.script = manifest.value.script ? resolve(dirname(path), manifest.value.script) : undefined; node.method = manifest.value.method; node.output = manifest.value.output; for (const [name, input] of Object.entries(manifest.value.inputs)) { const child = resolve(dirname(path), input); node.inputs[name] = child; if (stack.has(child)) { node.status = "error"; node.error = "Manifest cycle"; continue; } if (!existsSync(child)) { node.status = "warning"; node.error = `Missing input: ${child}`; continue; } discover(child, nodes, new Set([...stack, path])); } } else if (manifest?.error) node.error = manifest.error; return nodes; }
const safeFile = path => { const value = canonical(path); if (!statSync(value).isFile()) throw new Error("Artifact is not a file"); return value; };
const safeOutput = (dir, path) => { if (!path || typeof path !== "string") throw new Error("Agent output path missing"); const value = resolve(dir, path); if (!inside(value, dir)) throw new Error("Agent output outside node directory"); if (existsSync(value) && !inside(realpathSync(value), realpathSync(dir))) throw new Error("Agent output symlink escapes node directory"); return value; };
const parseJson = value => { try { return JSON.parse(value); } catch { return null; } };
function parseResult(value) { if (value && typeof value === "object") { if (value.prompt && value.script && value.artifact) return value; for (const nested of [value.item?.text, value.item?.message, value.text, value.message, value.result, value.output]) { const found = parseResult(nested); if (found) return found; } } if (typeof value !== "string") return null; const text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""); return parseResult(parseJson(text)); }
export function eventFromLine(line, path) { const value = parseJson(line); if (!value) return { kind: "reason", path, text: line }; const item = value.item || value, eventType = String(value.type || value.kind || item.type || ""); if (item.type === "agent_message" || item.type === "message") { const text = item.text || item.message || ""; return text ? { kind: "text", path, text, raw: value } : null; } if (item.type === "reasoning") { const text = item.text || ""; return text && text !== "✨" ? { kind: "reason", path, text, raw: value } : null; } if (item.type === "function_call" || item.type === "tool_call" || item.type === "custom_tool_call") return { kind: "tool_call", path, name: item.name || item.tool || "tool", input: item.arguments ?? item.input ?? {}, raw: value }; if (item.type === "file_change" && eventType === "item.completed") return { kind: "tool_call", path, name: "file_change", input: item.changes || item, raw: value }; if (item.type === "command_execution" && item.command && eventType === "item.started") return { kind: "tool_call", path, name: "command_execution", input: item.command, raw: value }; if (item.type === "command_execution" || item.type === "tool_result" || eventType.includes("command_execution") || eventType.includes("tool_result")) { const output = item.output ?? item.aggregated_output ?? item.result ?? item.error ?? value.output ?? value.aggregated_output ?? value.result ?? value.error ?? ""; return output === "" ? null : { kind: "tool_result", path, output, raw: value }; } if (eventType.includes("question")) return { kind: "question", path, id: value.id || item.id, text: value.text || value.question || item.text || item.question || "", options: value.options || item.options, raw: value }; if (eventType.includes("error") || eventType === "failure") return { kind: "failure", path, error: value.error || value.message || item.error || JSON.stringify(value), raw: value }; if (eventType.includes("warning")) return { kind: "warning", path, text: value.text || value.message || JSON.stringify(value), raw: value }; return null; }
function resultFromOutput(output) { return output.split(/\r?\n/).reverse().map(parseJson).map(parseResult).find(Boolean); }
function normalizeType(value, artifact, fallback) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (supported.includes(normalized)) return normalized;
  const mime = typeof normalized === "string" ? normalized.split(";", 1)[0] : "";
  const mimeType = mime.startsWith("text/") ? "text" : mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : undefined;
  const registered = [...typeRegistry.values()].find(type => type.mime.includes(mime));
  return registered?.id || mimeType || typeOf(artifact || "") || fallback;
}
function normalizeMethod(value, fallback) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  return normalized || fallback;
}
function filesIn(dir) { const files = []; const walk = current => { for (const entry of readdirSync(current, { withFileTypes: true })) { const path = join(current, entry.name); if (entry.isDirectory()) { if (!entry.name.startsWith(".")) walk(path); } else files.push(path); } }; walk(dir); return files; }
function recoverResult({ workdir, type, method, prompt, startedAt }) { const files = filesIn(workdir).filter(path => { try { return statSync(path).mtimeMs >= startedAt - 1000; } catch { return false; } }); const artifacts = files.filter(path => typeOf(path) === type && !["manifest.json", "AGENTS.md"].includes(path.split(/[\\/]/).pop())); const scripts = files.filter(path => [".js", ".mjs", ".cjs", ".ts", ".py", ".sh"].includes(extname(path).toLowerCase())); const artifact = artifacts.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]; const script = scripts.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]; return artifact && script ? { prompt, script: relative(workdir, script), artifact: relative(workdir, artifact), type, method, recovered: true } : null; }
function textInput(path) { return typeof path === "string" && typeOf(path) === "text"; }
function optionalBlock(path, label) { return path && existsSync(path) ? `### ${label}\n\`\`\`text\n${readFileSync(path, "utf8")}\n\`\`\`` : `### ${label}\n(none)`; }
function readAgentMemory(workdir) { return optionalBlock(join(workdir, "AGENTS.md"), "AGENTS.md"); }
function commandOutput(command, args) {
  try { const result = spawnSync(command, args, { encoding: "utf8", timeout: 1500 }); return result.status === 0 ? result.stdout.trim() : ""; } catch { return ""; }
}
function mediaMetadata(path) {
  if (typeof path !== "string") return { reference: path, available: false };
  try {
    const file = canonical(path), stat = statSync(file), type = typeOf(file), metadata = { filename: file.split(/[\\/]/).pop(), path: file, type, bytes: stat.size };
    if (type === "image") {
      const identify = commandOutput("identify", ["-format", "%w×%h", file]);
      if (identify) metadata.dimensions = identify;
    } else if (type === "audio" || type === "video") {
      const probe = commandOutput("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=width,height,codec_name", "-of", "default=noprint_wrappers=1:nokey=0", file]);
      if (probe) metadata.probe = probe;
    }
    return metadata;
  } catch { return { path, type: typeOf(path), available: false }; }
}
function inputSection(name, reference) {
  const inputDir = typeof reference === "string" ? dirname(resolve(reference)) : "(unknown)";
  const inputManifest = typeof reference === "string" ? readManifest(resolve(reference)) : null;
  const sourcePath = inputManifest?.value?.script ? resolve(inputDir, inputManifest.value.script) : null;
  const filename = typeof reference === "string" ? reference.split(/[\\/]/).pop() : String(reference);
  const artifact = textInput(reference)
    ? `### Artifact: ${filename}\nPath: ${reference}\n\`\`\`text\n${readFileSync(canonical(reference), "utf8")}\n\`\`\``
    : `### Artifact: ${filename}\n${JSON.stringify(mediaMetadata(reference), null, 2)}`;
  const source = sourcePath && existsSync(sourcePath) ? optionalBlock(sourcePath, `Source: ${sourcePath.split(/[\\/]/).pop()}`) : "### Source\n(none)";
  const memory = optionalBlock(join(inputDir, "AGENTS.md"), "Input AGENTS.md");
  return [`## Input: ${name}`, `Directory: ${inputDir}`, artifact, source, memory].join("\n\n");
}
const typePrompts = {
  text: "OUTPUT TEXT: produce exactly one plain UTF-8 text file. Do not use Markdown headings, fences, or formatting unless the user explicitly requests Markdown. Use an informative .txt name.",
  image: "OUTPUT IMAGE: produce exactly one inspectable raster image with the requested dimensions/style. Use an informative .png or .jpg name.",
  audio: "OUTPUT AUDIO: produce exactly one playable audio file with the requested format, duration, sample rate, and channels. Use an informative .wav or .mp3 name.",
  video: "OUTPUT VIDEO: produce exactly one playable rendered video with the requested dimensions, frame rate, duration, and codec. Use an informative .mp4 or .webm name."
};
export function assembledPrompt({ workdir, type, method, prompt, inputs, context }) {
  const shared = `You are Hypermaker generation agent. Project: ${projectDir}. Node: ${workdir}. Write script, exactly one ${type} artifact, and AGENTS.md only in node. Inspect output once; repair only if invalid. Return JSON only: {prompt,script,artifact,type,method,error}.`;
  const inputPrompt = Object.entries(inputs || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, reference]) => { try { return inputSection(name, reference); } catch { return [`## Input: ${name}`, `Directory: ${typeof reference === "string" ? dirname(resolve(reference)) : "(unknown)"}`, `Artifact unavailable: ${reference}`].join("\n\n"); } }).join("\n\n") || "(no direct linked inputs)";
  const methodGuide = methodRegistry.get(`${type}/${method}`);
  return [`# SHARED PROMPT\n${shared}`, `# OUTPUT TYPE\n${typePrompts[type] || `Produce one valid ${type} artifact.`}`, `# GENERATION METHOD\n${methodGuide ? `${methodGuide.guide} Available tools: ${methodGuide.tools.join(", ")}.` : `Produce one valid artifact using the available project tools.`}`, `# CURRENT AGENTS.md\n${readAgentMemory(workdir)}`, `# DIRECT INPUTS\n${inputPrompt}`, `# CONTEXT\n${JSON.stringify(context || {}, null, 2)}`, `# USER PROMPT\n${prompt}`].join("\n\n");
}
function draftDir(workdir, fallback) { const value = resolve(workdir || fallback || join(nodeRoot, crypto.randomUUID())); if (!inside(value, nodeRoot)) throw new Error("Draft workdir outside node root"); return value; }
function updateCanvas(identity, result) { const canvas = canvases.get("default"), draft = canvas?.get(identity); if (!draft) return; for (const node of canvas.values()) for (const [name, input] of Object.entries(node.inputs || {})) if (input === identity) node.inputs[name] = result.artifact; canvas.set(identity, { ...draft, workdir: dirname(result.artifact), path: result.artifact, script: result.script, type: result.type, method: result.method, prompt: result.prompt, status: result.error ? "warning" : "idle", error: result.error || undefined }); }
export async function generate(body, emitEvent = emit) {
  const identity = body.nodeId || body.path;
  if (!identity) throw new Error("Generation node has no identity");
  if (runs.has(identity)) throw new Error("Node already generating");
  const nodePath = body.path ? safeFile(body.path) : null;
  const workdir = nodePath ? resolve(body.workdir || dirname(nodePath)) : draftDir(body.workdir, join(nodeRoot, identity.replace(/^draft:/, "")));
  if (nodePath && !inside(workdir, dirname(nodePath))) throw new Error("Node workdir outside artifact directory");
  ensureNodeDir(workdir);
  const manifest = nodePath ? readManifest(nodePath) : null;
  const type = normalizeType(body.type || manifest?.value?.type || typeOf(nodePath), nodePath, typeOf(nodePath));
  const method = normalizeMethod(body.method || manifest?.value?.method);
  const model = normalizeModel(body.model), useGhPrefix = body.useGhPrefix === true, codexModel = useGhPrefix ? `gh/${model}` : model, effort = codexEfforts.includes(body.effort) ? body.effort : defaultEffort;
  if (!supported.includes(type) || !methodsFor(type).includes(method)) throw new Error("Unsupported output type or generation method");
  const prompt = body.prompt ?? manifest?.value?.prompt ?? "", inputs = body.inputs ?? manifest?.value?.inputs ?? {};
  const context = { projectCwd: projectDir, currentNode: { directory: workdir, artifact: nodePath }, directInputNames: Object.keys(inputs).sort(), codex: { model, useGhPrefix, effort } };
  writeFileSync(join(workdir, "manifest.json"), JSON.stringify({ version: 1, prompt, inputs, script: null, output: null, type, method, model, useGhPrefix, effort }, null, 2) + "\n");
  const codex = process.env.CODEX_BIN || "codex", args = ["exec", "--json", "--model", codexModel, "-c", `model_reasoning_effort=${effort}`, "--sandbox", "danger-full-access", "--skip-git-repo-check", "--ephemeral", assembledPrompt({ workdir, type, method, prompt, inputs, context })];
  const run = { identity, process: null }; runs.set(identity, run);
  emitEvent({ kind: "status", path: identity, text: "Starting Codex" }); emitEvent({ kind: "command", path: identity, text: `${codex} ${args.map(arg => JSON.stringify(arg)).join(" ")}` });
  let child; try { child = spawn(codex, args, { cwd: projectDir, env: { ...process.env, HYPERMAKER_NODE_DIR: workdir }, stdio: ["pipe", "pipe", "pipe"] }); run.process = child; child.stdin.end(); } catch (error) { runs.delete(identity); throw error; }
  let buffer = "", stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines.filter(Boolean)) { logRaw(identity, "stdout", line); const event = eventFromLine(line, identity); if (event) emitEvent(event); } });
  child.stderr.on("data", chunk => { const output = chunk.toString(); if (output.trim()) logRaw(identity, "stderr", output.trimEnd()); });
  return await new Promise((done, fail) => {
    let settled = false;
    const finishFailure = error => { if (settled) return; settled = true; runs.delete(identity); error.eventEmitted = true; emitEvent({ kind: "failure", path: identity, error: error.message }); fail(error); };
    child.on("error", finishFailure);
    child.on("close", code => {
      if (buffer.trim()) { logRaw(identity, "stdout", buffer.trim()); const event = eventFromLine(buffer.trim(), identity); if (event) emitEvent(event); }
      if (code !== 0) return finishFailure(new Error(`Codex exited ${code}`));
      const result = resultFromOutput(stdout); if (!result) return finishFailure(new Error("Codex did not return final JSON"));
      try {
        const script = safeOutput(workdir, result.script), artifact = safeOutput(workdir, result.artifact), normalizedType = normalizeType(result.type, artifact, type), normalizedResult = { ...result, type: normalizedType, method: normalizeMethod(result.method, method) };
        if (!supported.includes(normalizedResult.type) || !methodsFor(normalizedResult.type).includes(normalizedResult.method)) throw new Error("Invalid agent output type or method");
        if (!existsSync(script) || !existsSync(artifact)) throw new Error("Agent output missing");
        if (!existsSync(join(workdir, "AGENTS.md"))) writeFileSync(join(workdir, "AGENTS.md"), "");
        writeFileSync(join(workdir, "manifest.json"), JSON.stringify({ version: 1, prompt: normalizedResult.prompt, inputs, script: relative(workdir, script), output: relative(workdir, artifact), type: normalizedResult.type, method: normalizedResult.method, model, useGhPrefix, effort }, null, 2) + "\n");
        updateCanvas(identity, { ...normalizedResult, script, artifact }); emitEvent({ kind: "complete", path: identity, result: { ...normalizedResult, script, artifact } });
        runs.delete(identity); settled = true; done(normalizedResult);
      } catch (error) { finishFailure(error); }
    });
  });
}
function bodyJson(req) { return new Promise((resolveBody, reject) => { let text = ""; req.on("data", chunk => text += chunk); req.on("end", () => { try { resolveBody(JSON.parse(text || "{}")); } catch (error) { reject(error); } }); req.on("error", reject); }); }
function canvas() { const value = canvases.get("default") || new Map(); canvases.set("default", value); return value; }
function findNode(value) { if (!value) return undefined; if (canvas().has(value)) return canvas().get(value); try { return canvas().get(canonical(value)); } catch { return undefined; } }
function staleDescendants(sourcePath) { for (const node of canvas().values()) if (Object.values(node.inputs || {}).includes(sourcePath) && node.status === "idle") { node.status = "stale"; staleDescendants(node.path); } }
export const server = createServer(async (req, res) => { try { if (req.url === "/events") { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); clients.add(res); req.on("close", () => clients.delete(res)); return; } if (req.url === "/api/import" && req.method === "POST") { const body = await bodyJson(req); for (const node of discover(body.path).values()) canvas().set(node.id, { ...canvas().get(node.id), ...node }); return json(res, 200, { nodes: [...canvas().values()] }); } if (req.url === "/api/node" && req.method === "POST") { const body = await bodyJson(req), id = `draft:${crypto.randomUUID()}`, workdir = join(nodeRoot, id.slice(6)), type = body.type || "text"; if (!methodsFor(type).length) throw new Error("Unsupported output type"); const node = { id, workdir: null, type, method: body.method || methodsFor(type)[0], prompt: "", inputs: {}, status: "dirty", trajectory: [], position: body.position || { x: 80, y: 80 } }; canvas().set(id, node); return json(res, 201, { node }); } if (req.url === "/api/generate" && req.method === "POST") { const body = await bodyJson(req); if (runs.has(body.nodeId || body.path)) return json(res, 409, { error: "Node already generating" }); generate(body).catch(error => { if (!error.eventEmitted) emit({ kind: "failure", path: body.nodeId || body.path, error: error.message }); }); return json(res, 202, { started: true }); } if (req.url === "/api/link" && req.method === "POST") { const body = await bodyJson(req), target = findNode(body.target), source = findNode(body.source); if (!target || !source || !body.name || (!source.path && !source.id)) return json(res, 400, { error: "Invalid link" }); target.inputs[body.name] = source.path || source.id; if (target.path) staleDescendants(target.path); return json(res, 200, { node: target }); } if (req.url === "/api/unlink" && req.method === "POST") { const body = await bodyJson(req), target = findNode(body.target); if (!target) return json(res, 404, { error: "Node not found" }); delete target.inputs[body.name]; return json(res, 200, { node: target }); } if (req.url === "/api/rename-link" && req.method === "POST") { const body = await bodyJson(req), target = findNode(body.target); if (!target || !body.from || !body.to || target.inputs[body.to]) return json(res, 400, { error: "Invalid link name" }); target.inputs[body.to] = target.inputs[body.from]; delete target.inputs[body.from]; return json(res, 200, { node: target }); } if (req.url === "/api/clone" && req.method === "POST") { const body = await bodyJson(req), source = findNode(body.id || body.path); if (!source) return json(res, 404, { error: "Node not found" }); const id = `draft:${crypto.randomUUID()}`, workdir = join(nodeRoot, id.slice(6)); const node = { ...source, id, path: undefined, script: undefined, workdir, status: "dirty", trajectory: [], position: { x: source.position.x + 40, y: source.position.y + 40 } }; canvas().set(id, node); return json(res, 201, { node }); } if (req.url === "/api/layout" && req.method === "POST") { const items = [...canvas().values()], indegree = new Map(items.map(n => [n.path || n.id, 0])); for (const n of items) for (const source of Object.values(n.inputs || {})) if (indegree.has(source)) indegree.set(n.id, indegree.get(n.id) + 1); let level = items.filter(n => !indegree.get(n.path || n.id)), placed = new Set(); for (let pass = 0; level.length && pass < items.length + 1; pass++) { level.forEach((n, i) => { n.position = { x: pass * 360 + 40, y: i * 220 + 40 }; placed.add(n.id); }); level = items.filter(n => !placed.has(n.id) && Object.values(n.inputs || {}).every(source => placed.has(source))); } items.filter(n => !placed.has(n.id)).forEach((n, i) => n.position = { x: 40, y: i * 220 + 40 }); return json(res, 200, { nodes: items }); } if (req.url === "/api/delete" && req.method === "POST") { const body = await bodyJson(req); const node = findNode(body.id || body.path); if (node) canvas().delete(node.id); return json(res, 200, { nodes: [...canvas().values()] }); } if (req.url === "/api/answer" && req.method === "POST") { const body = await bodyJson(req), run = runs.get(body.nodeId || body.path); if (!run) return json(res, 404, { error: "Run not found" }); run.process.stdin.write(JSON.stringify({ id: body.id, answer: body.answer }) + "\n"); return json(res, 200, { accepted: true }); } if (req.url.startsWith("/api/file?") && req.method === "GET") { const file = safeFile(new URL(req.url, "http://localhost").searchParams.get("path")), type = typeOf(file) || "text"; res.writeHead(200, { "content-type": type === "text" ? "text/plain" : `${type}/${extname(file).slice(1)}` }); return res.end(readFileSync(file)); } const file = req.url === "/" ? "index.html" : req.url.slice(1), path = normalize(join(publicDir, file)); if (!inside(path, publicDir) || !existsSync(path)) return json(res, 404, { error: "Not found" }); res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/html" }); return res.end(readFileSync(path)); } catch (error) { return json(res, 400, { error: error.message }); } });
if (process.argv[1] === fileURLToPath(import.meta.url)) { mkdirSync(publicDir, { recursive: true }); mkdirSync(nodeRoot, { recursive: true }); appendFileSync(logPath, `[${new Date().toISOString()}] server: starting\n`); const host = process.env.HYPERFRAME_HOST || "127.0.0.1", port = Number(process.env.PORT || 8787); server.listen(port, host, () => console.log(`Hypermaker: http://${host}:${port}`)); }
