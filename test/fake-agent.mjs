import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A stand-in for the Codex CLI whose only job is to be observable: it can be
// slow, it can fail the way the real CLI fails (non-zero exit, empty final
// file), and it can leave a grandchild behind so a Stop has to kill the whole
// process group rather than just the direct child.
const dir = process.env.HYPERMAKER_NODE_DIR || process.cwd();
const mode = process.env.AGENT_MODE || "slow";
const delay = Number(process.env.AGENT_DELAY || 1200);
// Only when the flag is actually there: indexOf() returns -1 otherwise, and -1+1
// is argv[0], the node binary - which the fixture then tried to overwrite.
const flag = process.argv.indexOf("--output-last-message");
const output = flag === -1 ? null : process.argv[flag + 1];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
mkdirSync(dir, { recursive: true });

// Record the exact argv so a test can check the adapter against the real CLI's
// contract (codex exec --json --output-last-message ... --ephemeral <prompt>).
writeFileSync(join(dir, "argv.json"), JSON.stringify(process.argv.slice(2)));

if (mode === "fail") {
  // The real CLI exits 1 and leaves an empty --output-last-message file behind.
  if (output) writeFileSync(output, "");
  // The real CLI reports the reason as a JSON event on its stream, then exits
  // non-zero. Reproducing that shape is what lets the harness carry the reason
  // to the card instead of only the exit code.
  console.log(JSON.stringify({ type: "error", message: "the agent could not finish" }));
  console.log(JSON.stringify({ type: "turn.failed", error: { message: "the agent could not finish" } }));
  process.exit(3);
}

if (mode === "reuse") {
  // The agent answers without rendering: it names the file the previous run left.
  // A real agent did this when it decided the old render was good enough, so a
  // second poster produced a "new" film with byte-identical video.
  const stale = join(dir, "note.txt");
  // Only the first run writes it. The second run names it again without touching
  // it, so its content predates the run that claims it.
  if (!existsSync(stale)) writeFileSync(stale, "made by an earlier run\n");
  const result = { prompt: "stand-in", script: null, artifact: "note.txt", type: "text", method: "llm", error: null };
  if (output) writeFileSync(output, JSON.stringify(result));
  console.log(JSON.stringify({ type: "turn.completed" }));
  process.exit(0);
}

if (mode === "cannot") {
  // What the real CLI did when it could not render: a successful exit, and a final
  // message in the same JSON shape with a null artifact and the reason spelled out.
  // The card must show that sentence - it is the only thing that says what to fix.
  const reason = "Rendering could not complete because no browser executable is installed or available";
  const result = { prompt: "stand-in", script: "render.mjs", artifact: null, type: "text", method: "llm", error: reason };
  if (output) writeFileSync(output, JSON.stringify(result));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
  process.exit(0);
}

if (mode === "tree") {
  // A grandchild in the same process group. If Stop kills only the direct child,
  // this one keeps running and writes its marker after the run is reported stopped.
  // No `detached`: the grandchild stays in the agent's process group, which is
  // exactly the thing a Stop has to signal. Detaching it here would make the
  // test pass even when Stop only killed the direct child.
  //
  // It keeps touching its marker instead of writing once after a fixed delay:
  // with a single delayed write the test had to race that delay, and a tight
  // window made a leaking Stop look clean. A stopped group never writes it; a
  // child-only kill keeps rewriting it for as long as anything looks.
  const marker = JSON.stringify(join(dir, "grandchild.txt"));
  // --input-type=commonjs because this repository is `type: module`, so a plain
  // `node -e` would be ESM and `require` would not exist. The first version of
  // this fixture crashed instantly for that reason, which made a leaking Stop
  // look clean: nothing was left alive to write the marker.
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", `const fs = require('node:fs'); for (;;) { fs.writeFileSync(${marker}, 'survived'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200) }`], { stdio: "ignore" });
  child.unref();
  await sleep(delay);
}

await sleep(delay);
writeFileSync(join(dir, "note.txt"), "made by the stand-in agent\n");
const result = { prompt: "stand-in", script: null, artifact: "note.txt", type: "text", method: "llm", error: null };
if (output) writeFileSync(output, JSON.stringify(result));
console.log(JSON.stringify({ type: "turn.completed" }));
