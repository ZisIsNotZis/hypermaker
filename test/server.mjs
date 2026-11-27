// Fixture servers for the browser and lifecycle tests.
//
// Two failures this is written against, both seen for real:
//
//   * Hard-coded ports collide. A server left behind by an interrupted run kept
//     answering on a fixed port, so a "negative control" looked green because it
//     was talking to an old process instead of the code under test.
//   * `child.kill()` does not always reach the server. The server spawns agents,
//     and a test that dies mid-run can leave the listening socket open.
//
// So: ask the OS for a free port, spawn detached, and always tear down the whole
// group - on normal exit and on the way out of a failing process.
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const children = [];

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export function startServer({ cwd = process.cwd(), port, env = {} }) {
  const child = spawn("node", ["server/index.mjs"], { cwd, env: { ...process.env, PORT: String(port), HYPERMAKER_HOST: "127.0.0.1", ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const log = [];
  child.stdout.on("data", chunk => log.push(chunk.toString()));
  child.stderr.on("data", chunk => log.push(chunk.toString()));
  child.log = () => log.join("");
  children.push(child);
  return child;
}

export async function waitReady(port, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/registry`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`fixture server on port ${port} never became ready`);
}

export function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}

export function stopAll() {
  for (const child of children) stopServer(child);
}

// Whatever ends the test process - including an interrupted one - the servers go
// with it, so the next run starts from a clean port space.
for (const signal of ["exit", "SIGINT", "SIGTERM"]) process.on(signal, stopAll);
