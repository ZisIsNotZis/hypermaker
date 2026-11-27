import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const scalar = value => typeof value === "string" ? JSON.stringify(value) : value == null ? "null" : String(value);
const parseScalar = value => {
  const text = value.trim();
  if (text === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  try { return JSON.parse(text); } catch { return text.replace(/^['"]|['"]$/g, ""); }
};

// `file` is part of a source, not decoration: it is where the bytes this artifact
// was made from live on disk once the material card has been regenerated. Dropping
// it here made a kept version point back at `poster.png` - today's file - which is
// the mislabelling the snapshot exists to prevent.
const compactSources = sources => (sources || []).map(s => ({ id: Number(s.id), type: s.type, artifact: s.artifact ?? null, ...(s.file ? { file: s.file } : {}) }));

export function serializeWorkspace(nodes = {}) {
  return Object.entries(nodes).sort(([a], [b]) => Number(a) - Number(b)).map(([id, node]) => {
    // `status` and `error` are persisted on purpose: a failed or stopped run has to
    // look the same after a restart as it did before one, and a run cut off by a
    // crash must not come back as a quiet draft.
    // `sources` is the same kind of fact: what a finished artifact was built from.
    // Links alone cannot answer it, because an input card can be relinked or
    // deleted later, and then a finished film has no visible provenance.
    // `promptUsed` is the instruction the artifact on the card was actually made
    // from, as distinct from `prompt`, which is what the person is asking for next.
    // Without it the two are the same field, so editing the text before pressing
    // Generate silently rewrites the record of the film already on screen - and
    // going back to an earlier version leaves the box describing the newer one.
    const fields = ["x", "y", "inputs", "type", "method", "prompt", "wpm", "quality", "script", "artifact", "status", "error"];
    const lines = fields.map(field => `  ${field}: ${field === "inputs" ? `[${(node.inputs || []).join(", ")}]` : scalar(node[field])}`);
    // Written only when there is one: a node that has never finished a run has no
    // artifact, so it has no instruction behind one, and repeating `null` on every
    // draft would be noise in a file people are meant to be able to read.
    if (typeof node.promptUsed === "string") lines.push(`  promptUsed: ${JSON.stringify(node.promptUsed)}`);
    // A notice is what the harness told the person *before* a run started - today, that a
    // file was too large to copy and is only kept by a link. It is stored for the same
    // reason a failure is: the reason a file is not fully covered has to survive the page
    // being closed, or it is a warning nobody reads twice.
    if (typeof node.notice === "string" && node.notice) lines.push(`  notice: ${JSON.stringify(node.notice)}`);
    // What the audio of a narration measured, as the server measured it and not as the
    // agent said it did. It is kept with the artifact because it is a fact about those
    // bytes: a person who reopens the workspace tomorrow can still read that this take was
    // checked, and against how many words. A card without a narration has no such line.
    if (node.narration && typeof node.narration === "object") lines.push(`  narration: ${JSON.stringify(node.narration)}`);
    // What a film measured about itself: its duration, its stream codecs, and how well its
    // embedded track matched the narration it was given. Kept with the artifact for the same
    // reason a narration's numbers are - a reopened canvas has to be able to show that the sound
    // was checked rather than that a track exists.
    if (node.film && typeof node.film === "object") lines.push(`  film: ${JSON.stringify(node.film)}`);
    if (Array.isArray(node.sources) && node.sources.length) {
      lines.push(`  sources: ${JSON.stringify(compactSources(node.sources))}`);
    }
    // Each kept version is one finished run: the file that holds its bytes (which
    // may be a copy under versions/, when a later run wrote the same name) and the
    // materials that version was made from. Without this, regenerating a film
    // leaves the older render sitting on disk with nothing on the canvas that
    // points at it.
    if (Array.isArray(node.versions) && node.versions.length) {
      // `prompt` is part of a version for the same reason `sources` is: two takes of
      // one card are told apart by what they were asked for, and a version that
      // only remembered its bytes could not say which of two prompts made it.
      const compact = node.versions.map(v => ({ id: v.id, artifact: v.artifact ?? null, file: v.file ?? null, sources: compactSources(v.sources), prompt: v.prompt ?? null, ...(v.narration ? { narration: v.narration } : {}) }));
      lines.push(`  versions: ${JSON.stringify(compact)}`);
    }
    return `${id}:\n${lines.join("\n")}`;
  }).join("\n") + (Object.keys(nodes).length ? "\n" : "");
}

export function parseWorkspace(text = "") {
  const nodes = {};
  let current;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const node = raw.match(/^(\d+):\s*$/);
    if (node) { current = nodes[node[1]] = { inputs: [] }; continue; }
    // Field names are camelCase (`promptUsed`), so this cannot be [a-z]+ only: a
    // stricter pattern does not fail, it silently drops the line, which is how a
    // field written to disk came back as undefined.
    const field = raw.match(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
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
  const record = { id: Number(id), x: node.x ?? 0, y: node.y ?? 0, inputs: (node.inputs || []).map(Number), type: node.type, method: node.method ?? null, prompt: node.prompt || "", promptUsed: typeof node.promptUsed === "string" ? node.promptUsed : null, quality: node.quality || "standard", script: node.script ?? null, artifact: node.artifact ?? null, status: node.status ?? null, error: node.error ?? null, notice: typeof node.notice === "string" && node.notice ? node.notice : null, sources: Array.isArray(node.sources) ? node.sources : null, narration: node.narration && typeof node.narration === "object" ? node.narration : null, film: node.film && typeof node.film === "object" ? node.film : null, wpm: Number.isFinite(Number(node.wpm)) && Number(node.wpm) > 0 ? Number(node.wpm) : null, versions: Array.isArray(node.versions) && node.versions.length ? node.versions : null };
  return record;
}
export function workspacePath(workdir, id, filename) {
  const path = resolve(workdir, String(id), filename || "");
  if (!path.startsWith(resolve(workdir) + "/")) throw new Error("Node path outside workspace");
  return path;
}
