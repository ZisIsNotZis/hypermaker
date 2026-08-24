import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { methodRegistry, typeForFile, typeRegistry } from "./registry.mjs";
import { assemblePrompt } from "./prompt.mjs";

const inside = (file, dir) => { const r = relative(resolve(dir), resolve(file)); return r === "" || (!r.startsWith("..") && !r.startsWith("/")); };
const safe = (dir, name) => { if (!name || typeof name !== "string") throw new Error("Agent artifact missing"); const file = resolve(dir, name); if (!inside(file, dir)) throw new Error("Agent output outside node directory"); return file; };
const modelName = (model, gh) => `${gh ? "gh/" : ""}${String(model || "gpt-5.6-luna").replace(/^gh\//, "")}`;
const finalJson = lines => [...lines].reverse().map(line => { try { const value = JSON.parse(line); const text = value?.item?.type === "agent_message" ? value.item.text : value?.type === "agent_message" ? value.text : null; return value?.artifact ? value : JSON.parse(text || ""); } catch { return null; } }).find(value => value && value.artifact);

export function generate({ node, workspace, context = {}, model, effort, useGhPrefix, onRaw }) {
  const nodeDir = join(workspace.workdir, String(node.id)); mkdirSync(nodeDir, { recursive: true });
  const prompt = assemblePrompt({ node, workspace, context });
  const log = join(nodeDir, "codex.jsonl");
  const command = process.env.CODEX_BIN || "codex";
  const args = ["exec", "--json", "--model", modelName(model, useGhPrefix), "-c", `model_reasoning_effort=${effort || "medium"}`, "--sandbox", "danger-full-access", "--skip-git-repo-check", "--ephemeral", prompt];
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: workspace.projectCwd || process.cwd(), env: { ...process.env, HYPERMAKER_NODE_DIR: nodeDir }, stdio: ["ignore", "pipe", "pipe"] });
    appendFileSync(join(workspace.projectCwd || process.cwd(), "dev.log"), `[${new Date().toISOString()}] command: ${command} ${args.slice(0, -1).map(x => JSON.stringify(x)).join(" ")}\n${prompt}\n`);
    const lines = []; let buffer = "";
    const record = (stream, chunk) => { const raw = chunk.toString(); appendFileSync(log, raw); appendFileSync(join(workspace.projectCwd || process.cwd(), "dev.log"), `[${new Date().toISOString()}] ${stream}: ${raw}`); onRaw?.(stream, raw); if (stream === "stdout") { buffer += raw; const parts = buffer.split(/\r?\n/); buffer = parts.pop() || ""; lines.push(...parts.filter(Boolean)); } };
    child.stdout.on("data", chunk => record("stdout", chunk)); child.stderr.on("data", chunk => record("stderr", chunk));
    child.on("error", fail); child.on("close", code => {
      if (buffer.trim()) lines.push(buffer.trim());
      if (code !== 0) return fail(new Error(`Codex exited with code ${code}`));
      try {
        const result = finalJson(lines); if (!result) throw new Error("Codex returned no artifact JSON"); const artifact = safe(nodeDir, result.artifact), script = result.script ? safe(nodeDir, result.script) : null;
        if (!existsSync(artifact)) throw new Error("Agent artifact does not exist");
        const type = typeForFile(artifact); if (type !== node.type) throw new Error(`Artifact type mismatch: expected ${node.type}`);
        if (!existsSync(join(nodeDir, "AGENTS.md"))) writeFileSync(join(nodeDir, "AGENTS.md"), "", "utf8");
        done({ script: script ? relative(nodeDir, script) : null, artifact: relative(nodeDir, artifact) });
      } catch (error) { fail(error); }
    });
  });
}
