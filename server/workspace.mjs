import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const scalar = value => typeof value === "string" ? JSON.stringify(value) : value == null ? "null" : String(value);
const parseScalar = value => {
  const text = value.trim();
  if (text === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  try { return JSON.parse(text); } catch { return text.replace(/^['"]|['"]$/g, ""); }
};

export function serializeWorkspace(nodes = {}) {
  return Object.entries(nodes).sort(([a], [b]) => Number(a) - Number(b)).map(([id, node]) => {
    const fields = ["x", "y", "inputs", "type", "method", "prompt", "quality", "script", "artifact"];
    return `${id}:\n${fields.map(field => `  ${field}: ${field === "inputs" ? `[${(node.inputs || []).join(", ")}]` : scalar(node[field])}`).join("\n")}`;
  }).join("\n") + (Object.keys(nodes).length ? "\n" : "");
}

export function parseWorkspace(text = "") {
  const nodes = {};
  let current;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const node = raw.match(/^(\d+):\s*$/);
    if (node) { current = nodes[node[1]] = { inputs: [] }; continue; }
    const field = raw.match(/^\s{2}([a-z]+):\s*(.*)$/);
    if (!field || !current) continue;
    current[field[1]] = field[1] === "inputs" ? (field[2].match(/\d+/g) || []).map(Number) : parseScalar(field[2]);
  }
  return nodes;
}

export function readWorkspace(workdir) {
  try { return parseWorkspace(readFileSync(join(resolve(workdir), "workspace.yml"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

export function writeWorkspace(workdir, nodes) {
  const dir = resolve(workdir), target = join(dir, "workspace.yml"), temp = `${target}.tmp-${process.pid}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(temp, serializeWorkspace(nodes), "utf8");
  renameSync(temp, target);
}

export function nodeRecord(id, node) {
  return { id: Number(id), x: node.x ?? 0, y: node.y ?? 0, inputs: (node.inputs || []).map(Number), type: node.type, method: node.method ?? null, prompt: node.prompt || "", quality: node.quality || "standard", script: node.script ?? null, artifact: node.artifact ?? null };
}

export function workspacePath(workdir, id, filename) {
  const path = resolve(workdir, String(id), filename || "");
  if (!path.startsWith(resolve(workdir) + "/")) throw new Error("Node path outside workspace");
  return path;
}
