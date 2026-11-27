import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { methodRegistry, typeForFile, typeRegistry } from "./registry.mjs";
import { assemblePrompt } from "./prompt.mjs";

const inside = (file, dir) => { const r = relative(resolve(dir), resolve(file)); return r === "" || (!r.startsWith("..") && !r.startsWith("/")); };
const safe = (dir, name) => { if (!name || typeof name !== "string") throw new Error("Agent artifact missing"); const file = resolve(dir, name); if (!inside(file, dir)) throw new Error("Agent output outside node directory"); return file; };
const modelName = (model, gh) => `${gh ? "gh/" : ""}${String(model || "gpt-5.6-luna").replace(/^gh\//, "")}`;
// The real CLI exits non-zero and prints why on its event stream. "Codex exited
// with code 1" tells a person nothing they can act on, so the last message the
// CLI itself called an error is carried into the card as the reason.
const reasonFrom = file => {
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const event = JSON.parse(lines[i]);
      const message = event?.error?.message || event?.message;
      if (message && (event.type === "error" || event.type === "turn.failed")) return String(message);
    }
  } catch {}
  return null;
};
const finalJson = file => {
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (typeof value === "object" && value?.artifact) return value;
  if (typeof value === "string") return JSON.parse(value);
  throw new Error("Codex final output is not artifact JSON");
};

// The run is returned as a promise that also carries `cancel()`, because a person
// who presses Stop expects the agent and everything it started to be gone - not
// just the direct child process.
export function generate({ node, workspace, context = {}, model, effort, useGhPrefix, onRaw }) {
  const nodeDir = join(workspace.workdir, String(node.id)); mkdirSync(nodeDir, { recursive: true });
  const prompt = assemblePrompt({ node, workspace, context });
  const log = join(nodeDir, "codex.jsonl"), final = join(nodeDir, "codex-final.json"), devLog = join(workspace.projectCwd || process.cwd(), "dev.log");
  const configured = process.env.CODEX_BIN || "codex";
    const command = configured.endsWith(".mjs") ? process.execPath : configured;
    const commandArgs = configured.endsWith(".mjs") ? [configured, "--output-last-message", final] : [];
  const args = configured.endsWith(".mjs") ? commandArgs : ["exec", "--json", "--output-last-message", final, "--model", modelName(model, useGhPrefix), "-c", `model_reasoning_effort=${effort || "medium"}`, "--sandbox", "danger-full-access", "--skip-git-repo-check", "--ephemeral", prompt];
  let child, cancelled = false;
  const promise = new Promise((done, fail) => {
    // detached makes the child a process-group leader, so a cancel can signal the
    // whole tree the agent spawned (shell, node, renderer), not only the CLI.
    child = spawn(command, args, { cwd: workspace.projectCwd || process.cwd(), env: { ...process.env, HYPERMAKER_NODE_DIR: nodeDir }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const commandLine = `${command} ${args.map(x => JSON.stringify(x)).join(" ")}`;
    const commandLog = `[${new Date().toISOString()}] command: ${commandLine}\n${prompt}\n`;
    appendFileSync(devLog, commandLog); process.stdout.write(commandLog);
    const record = (stream, chunk) => { const raw = chunk.toString(); appendFileSync(log, raw); const line = `[${new Date().toISOString()}] ${stream}: ${raw}`; appendFileSync(devLog, line); process.stdout.write(line); onRaw?.(stream, raw); };
    child.stdout.on("data", chunk => record("stdout", chunk)); child.stderr.on("data", chunk => record("stderr", chunk));
    // A missing or unexecutable CLI is the most likely first-run problem, and a
    // bare `spawn codex ENOENT` is not something a person can act on.
    child.on("error", error => fail(error.code === "ENOENT"
      ? new Error(`Cannot run the Codex CLI (${command}): it is not installed or not on PATH. Install Codex, or set CODEX_BIN to its path.`)
      : error));
    child.on("close", code => {
      if (cancelled) return fail(new Error("Run stopped by the user"));
      if (code !== 0) {
        const reason = reasonFrom(log);
        return fail(new Error(`Codex exited with code ${code}${reason ? `: ${reason}` : ""}`));
      }
      try {
        const result = finalJson(final); const artifact = safe(nodeDir, result.artifact), script = result.script ? safe(nodeDir, result.script) : null;
        if (!existsSync(artifact)) throw new Error("Agent artifact does not exist");
        const type = typeForFile(artifact); if (type !== node.type) throw new Error(`Artifact type mismatch: expected ${node.type}`);
        if (!existsSync(join(nodeDir, "AGENTS.md"))) writeFileSync(join(nodeDir, "AGENTS.md"), "", "utf8");
        done({ script: script ? relative(nodeDir, script) : null, artifact: relative(nodeDir, artifact) });
      } catch (error) { fail(error); }
    });
  });
  promise.cancel = () => {
    if (cancelled || !child || child.exitCode !== null) return false;
    cancelled = true;
    // Ask the group to stop, then insist, so a wedged renderer cannot keep a
    // stopped card's directory changing behind the user's back.
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    const hard = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000);
    hard.unref?.();
    return true;
  };
  return promise;
}
