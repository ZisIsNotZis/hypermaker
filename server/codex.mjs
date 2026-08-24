import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { methodRegistry, typeForFile, typeRegistry } from "./registry.mjs";
import { assemblePrompt } from "./prompt.mjs";

const inside = (file, dir) => { const r = relative(resolve(dir), resolve(file)); return r === "" || (!r.startsWith("..") && !r.startsWith("/")); };
const safe = (dir, name) => { if (!name || typeof name !== "string") throw new Error("Agent artifact missing"); const file = resolve(dir, name); if (!inside(file, dir)) throw new Error("Agent output outside node directory"); return file; };
const modelName = (model, gh) => `${gh ? "gh/" : ""}${String(model || "gpt-5.6-luna").replace(/^gh\//, "")}`;
const finalJson = file => {
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (typeof value === "object" && value?.artifact) return value;
  if (typeof value === "string") return JSON.parse(value);
  throw new Error("Codex final output is not artifact JSON");
};

export function generate({ node, workspace, context = {}, model, effort, useGhPrefix, onRaw }) {
  const nodeDir = join(workspace.workdir, String(node.id)); mkdirSync(nodeDir, { recursive: true });
  const prompt = assemblePrompt({ node, workspace, context });
  const log = join(nodeDir, "codex.jsonl"), final = join(nodeDir, "codex-final.json"), devLog = join(workspace.projectCwd || process.cwd(), "dev.log");
  const configured = process.env.CODEX_BIN || "codex";
    const command = configured.endsWith(".mjs") ? process.execPath : configured;
    const commandArgs = configured.endsWith(".mjs") ? [configured, "--output-last-message", final] : [];
  const args = configured.endsWith(".mjs") ? commandArgs : ["exec", "--json", "--output-last-message", final, "--model", modelName(model, useGhPrefix), "-c", `model_reasoning_effort=${effort || "medium"}`, "--sandbox", "danger-full-access", "--skip-git-repo-check", "--ephemeral", prompt];
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: workspace.projectCwd || process.cwd(), env: { ...process.env, HYPERMAKER_NODE_DIR: nodeDir }, stdio: ["ignore", "pipe", "pipe"] });
    const commandLine = `${command} ${args.map(x => JSON.stringify(x)).join(" ")}`;
    const commandLog = `[${new Date().toISOString()}] command: ${commandLine}\n${prompt}\n`;
    appendFileSync(devLog, commandLog); process.stdout.write(commandLog);
    const record = (stream, chunk) => { const raw = chunk.toString(); appendFileSync(log, raw); const line = `[${new Date().toISOString()}] ${stream}: ${raw}`; appendFileSync(devLog, line); process.stdout.write(line); onRaw?.(stream, raw); };
    child.stdout.on("data", chunk => record("stdout", chunk)); child.stderr.on("data", chunk => record("stderr", chunk));
    child.on("error", fail); child.on("close", code => {
      if (code !== 0) return fail(new Error(`Codex exited with code ${code}`));
      try {
        const result = finalJson(final); const artifact = safe(nodeDir, result.artifact), script = result.script ? safe(nodeDir, result.script) : null;
        if (!existsSync(artifact)) throw new Error("Agent artifact does not exist");
        const type = typeForFile(artifact); if (type !== node.type) throw new Error(`Artifact type mismatch: expected ${node.type}`);
        if (!existsSync(join(nodeDir, "AGENTS.md"))) writeFileSync(join(nodeDir, "AGENTS.md"), "", "utf8");
        done({ script: script ? relative(nodeDir, script) : null, artifact: relative(nodeDir, artifact) });
      } catch (error) { fail(error); }
    });
  });
}
