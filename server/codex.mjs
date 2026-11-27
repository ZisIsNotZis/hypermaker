import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { methodRegistry, typeForFile, typeRegistry } from "./registry.mjs";
import { assemblePrompt } from "./prompt.mjs";

const inside = (file, dir) => { const r = relative(resolve(dir), resolve(file)); return r === "" || (!r.startsWith("..") && !r.startsWith("/")); };
const safe = (dir, name) => { if (!name || typeof name !== "string") throw new Error("Agent artifact missing"); const file = resolve(dir, name); if (!inside(file, dir)) throw new Error("Agent output outside node directory"); return file; };
// "The file exists" is not "this run made it". The artifact named by the final JSON
// has to have been written during this run; an older file at the same path means
// the agent handed back previous output, and publishing that would show a film made
// from material it never used.
//
// The first attempt compared modification time against the run's start time with a
// one-second tolerance for timestamp granularity. That tolerance was a window in
// which the rule simply did not apply: two runs closer together than the slack let
// the first run's untouched file pass as the second run's output - exactly the
// failure this check exists to stop. A clock cannot answer "was this file written
// during this run" without inventing such a window, so it is not asked. Each file
// in the node directory is fingerprinted before the run, and the returned artifact
// must no longer match its fingerprint (or must not have existed at all). Whether a
// file was written then becomes a property of the file itself, at any speed.
const identity = file => { const s = statSync(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; };
// Relative paths, because that is how the final JSON names the artifact; a file in a
// subdirectory counts the same way as one next to the prompt. Unreadable entries are
// skipped rather than fatal: a broken link in the agent's own directory must not
// stop the run from starting.
const snapshot = dir => {
  const prints = new Map();
  for (const rel of readdirSync(dir, { recursive: true })) {
    try { if (!statSync(join(dir, rel)).isFile()) continue; prints.set(rel, identity(join(dir, rel))); } catch {}
  }
  return prints;
};
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
    // No structured event, but the CLI (or a tool it ran) may still have said why on stderr.
    // This is the case a person hits with a script the voice refuses: the renderer prints
    // `this voice has no way to say: ¥500` and exits 2, and the agent stops there. Without
    // this fallback the card said "the run's directory was modified", which is untrue and
    // sends the writer looking for the wrong thing. The `[time] stderr: ` prefix the log adds
    // is stripped, and the first line is taken because the renderer puts the summary there.
    const said = lines
      .map(line => /^\[[^\]]*\]\s*stderr:\s?(.*)$/s.exec(line)?.[1])
      .filter(text => text && text.trim());
    if (said.length) {
      const first = said[0].trim().split(/\r?\n/)[0].trim();
      if (first) return first;
    }
  } catch {}
  return null;
};
// The most useful sentence in a tail of stderr: the first line that is not Node's stack noise,
// preferring a line the renderer or the CLI wrote as its own message. Node prints a blank line,
// a `node:internal` header and a `throw err` line before the error that matters.
const lastLine = text => {
  const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const useful = lines.filter(l => !/^(node:internal|\^+$|at |\}|const err =|throw err)/.test(l));
  // A refusal prints the token, then the line that says what to change about it, then the
  // general advice. The middle line is the one a writer can act on (`¥ is a currency this voice
  // does not name`), so it is preferred; the token line comes next so nothing is lost.
  return useful.find(l => /is a (?:currency|fraction|mathematical|unit)/.test(l))
    ?? useful.find(l => /this voice has no way to say|no way to say/.test(l))
    ?? useful[0] ?? null;
};
const finalJson = file => {
  let value = JSON.parse(readFileSync(file, "utf8"));
  if (typeof value === "string") value = JSON.parse(value);
  if (typeof value === "object" && value?.artifact) return value;
  // An agent that cannot finish says so in the same JSON shape, with a null
  // artifact and a sentence naming what it hit. A real run returned "no browser
  // executable is installed", and the card showed "final output is not artifact
  // JSON" instead: the one message that told the person what to fix was thrown
  // away for not being the happy shape.
  if (typeof value === "object" && typeof value?.error === "string" && value.error.trim()) throw new Error(value.error.trim());
  throw new Error("Codex final output is not artifact JSON");
};

// The run is returned as a promise that also carries `cancel()`, because a person
// who presses Stop expects the agent and everything it started to be gone - not
// just the direct child process.
// `attemptDir` is where this run is allowed to write. It is a directory of its own,
// not the card's, because the card's holds things a person put there: a poster they
// dropped in, the versions they kept. Keeping the two apart is what makes "throw
// away the attempt" a single delete of a directory the harness created, instead of
// a guess about which files in a shared folder are somebody else's.
export function generate({ node, workspace, context = {}, model, effort, useGhPrefix, onRaw, attemptDir }) {
  const nodeDir = join(workspace.workdir, String(node.id)), workDir = attemptDir || nodeDir;
  mkdirSync(nodeDir, { recursive: true }); mkdirSync(workDir, { recursive: true });
  const prompt = assemblePrompt({ node, workspace, context });
  // The record of how a card was made - the assembled prompt, the CLI's event stream,
  // its final message - belongs with the card and outlives the run, because it is how
  // a person checks what they were actually charged for. The agent's *output* is
  // different: it is bulky, it is scratch once published, and it lives in workDir.
  const log = join(nodeDir, "codex.jsonl"), final = join(nodeDir, "codex-final.json"), devLog = join(workspace.projectCwd || process.cwd(), "dev.log");
  // Fingerprinted before the harness writes prompt.txt and the log, so this describes
  // the directory as the previous run left it. Comparing against it afterwards is how
  // the check below tells "this run wrote it" from "it was already here".
  const before = snapshot(workDir);
  const configured = process.env.CODEX_BIN || "codex";
    const command = configured.endsWith(".mjs") ? process.execPath : configured;
    const commandArgs = configured.endsWith(".mjs") ? [configured, "--output-last-message", final] : [];
  const args = configured.endsWith(".mjs") ? commandArgs : ["exec", "--json", "--output-last-message", final, "--model", modelName(model, useGhPrefix), "-c", `model_reasoning_effort=${effort || "medium"}`, "--sandbox", "danger-full-access", "--skip-git-repo-check", "--ephemeral", prompt];
  let child, cancelled = false;
  const promise = new Promise((done, fail) => {
    // detached makes the child a process-group leader, so a cancel can signal the
    // whole tree the agent spawned (shell, node, renderer), not only the CLI.
    // Written before the spawn, not after: a child can be running before the next
    // line executes, and a reader of this directory (a person, or a test fixture
    // standing in for an agent) must never see the directory without the prompt
    // that produced it.
    // In the run's own directory: that is what HYPERMAKER_NODE_DIR means, and the
    // agent reads the instruction from there. It is also the one file a person can
    // read afterwards to see exactly what was asked, so it is copied to the card
    // before the attempt directory is dropped.
    writeFileSync(join(workDir, "prompt.txt"), prompt, "utf8");
    // HYPERMAKER_NODE_DIR is where a run writes, and that is now its own directory.
    // HYPERMAKER_CARD_DIR is the card's, for reading things a person put there.
    child = spawn(command, args, { cwd: workspace.projectCwd || process.cwd(), env: { ...process.env, HYPERMAKER_NODE_DIR: workDir, HYPERMAKER_CARD_DIR: nodeDir, HYPERMAKER_NODE_TYPE: node.type, HYPERMAKER_NODE_ID: String(node.id) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const commandLine = `${command} ${args.map(x => JSON.stringify(x)).join(" ")}`;
    // What was actually invoked, kept with the card and not with the attempt: the
    // attempt directory is scratch and goes away, but "which model, which flags, on
    // what prompt" is the record a person needs when a result is not what they
    // expected. The prompt is the last argument, so it is the one thing kept out of
    // this file - prompt.txt holds it in full.
    writeFileSync(join(nodeDir, "codex-command.json"), JSON.stringify({ command, args: args.slice(0, -1), at: new Date().toISOString() }, null, 1), "utf8");
    const commandLog = `[${new Date().toISOString()}] command: ${commandLine}\n${prompt}\n`;
    appendFileSync(devLog, commandLog); process.stdout.write(commandLog);
    // The last thing the CLI said on stderr, kept in memory as well as on disk. A run that
    // dies before writing its final message still has a reason - the renderer's `this voice has
    // no way to say: ¥500` arrives exactly this way - and reading it back out of the log file
    // means guessing at the log's own format. This is the plain fact: the bytes that came out of
    // the process, in order.
    let stderrTail = "";
    const record = (stream, chunk) => {
      const raw = chunk.toString();
      if (stream === "stderr") stderrTail = (stderrTail + raw).slice(-4000);
      appendFileSync(log, raw);
      const line = `[${new Date().toISOString()}] ${stream}: ${raw}`;
      appendFileSync(devLog, line);
      process.stdout.write(line);
      onRaw?.(stream, raw);
    };
    child.stdout.on("data", chunk => record("stdout", chunk)); child.stderr.on("data", chunk => record("stderr", chunk));
    // A missing or unexecutable CLI is the most likely first-run problem, and a
    // bare `spawn codex ENOENT` is not something a person can act on.
    child.on("error", error => fail(error.code === "ENOENT"
      ? new Error(`Cannot run the Codex CLI (${command}): it is not installed or not on PATH. Install Codex, or set CODEX_BIN to its path.`)
      : error));
    child.on("close", code => {
      if (cancelled) return fail(new Error("Run stopped by the user"));
      if (code !== 0) {
        // The node directory belongs to the agent, and a real one deleted the
        // harness's own files while "tidying": the CLI then could not write its last
        // message and exited 1 with no reason in its event stream. Say what actually
        // happened, and point at the one cause worth suspecting.
        //
        // But first: if the CLI *did* say why, that reason is the answer. A narration
        // agent whose script contains a symbol the voice cannot say prints
        // "¥ is a currency this voice does not name" and stops - and the card used to
        // report "the run's directory was modified", which is both untrue and useless
        // to a writer holding a line with a ¥ in it. The directory message is kept for
        // the case where there is no reason at all, which is the case it was written
        // for.
        if (!existsSync(final)) {
          const why = reasonFrom(log) || lastLine(stderrTail);
          if (why) return fail(new Error(`Codex exited with code ${code}: ${why}`));
          return fail(new Error(`Codex exited with code ${code} and did not write its final message (${basename(final)} is missing): the run's directory was modified during the run. A run may write its own files but must not delete ${basename(final)}.`));
        }
        const reason = reasonFrom(log);
        return fail(new Error(`Codex exited with code ${code}${reason ? `: ${reason}` : ""}`));
      }
      try {
        const result = finalJson(final);
        // An agent may name its output three ways: an absolute path, a path relative to
        // the directory it wrote in (what HYPERMAKER_NODE_DIR means now), or - from an
        // agent that still assumes the old layout - a path relative to the card. All
        // three are accepted, and all three must land inside the card's directory.
        // It also has to be this run's own work. A path that points anywhere else in
        // the card - a kept version, an earlier take, something a person put there -
        // is not output of this run, however valid the file looks. The old defence
        // compared fingerprints of the card's directory; with a directory per run the
        // same rule is stronger and simpler: publish only from the run's own folder.
        const resolveOut = name => {
          if (!name) return null;
          const file = isAbsolute(name) ? name : (existsSync(join(workDir, name)) ? join(workDir, name) : join(nodeDir, name));
          const inside = relative(workDir, resolve(file));
          if (inside.startsWith("..") || isAbsolute(inside)) {
            throw new Error(`The run named ${basename(name)}, which is outside the directory it was given to work in. A run may publish only a file it wrote itself this time, so an earlier result cannot be handed back as a new one.`);
          }
          return safe(workDir, resolve(file));
        };
        const artifact = resolveOut(result.artifact), script = resolveOut(result.script);
        if (!existsSync(artifact)) throw new Error("Agent artifact does not exist");
        const type = typeForFile(artifact); if (type !== node.type) throw new Error(`Artifact type mismatch: expected ${node.type}`);
        // Publishing is publishing a result. A file that still matches its pre-run
        // fingerprint means nobody wrote it during this run; a real agent did exactly
        // that and two different posters became two films with byte-identical video.
        // Failures are what a person can act on; a quiet duplicate is not.
        const rel = relative(workDir, artifact);
        if (before.has(rel) && before.get(rel) === identity(artifact)) {
          throw new Error(`The agent returned ${rel} without rewriting it: the file is exactly as it was before this run started, so it holds the previous result rather than a new one. Try again, or ask the agent to render again into that path.`);
        }
        if (!existsSync(join(nodeDir, "AGENTS.md"))) writeFileSync(join(nodeDir, "AGENTS.md"), "", "utf8");
        // Paths are relative to the card, because that is what `node.artifact` and
        // `node.script` mean everywhere else, and because the attempt directory may
        // not survive the run (a failure moves it aside).
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
