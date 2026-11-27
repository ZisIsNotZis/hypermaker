// Between the press and the agent there is real work: the old take is adopted into
// `versions/`, the material is copied, and - the longest of them on a card holding an
// 8 MiB picture - every file the card holds is copied into the run's guard. A second
// press in that window was answered 202, because the card was only marked "running"
// at the moment the agent was spawned. Two open canvases gave the same card two runs,
// two guards and two publishes for one press each - the card ended on v3 - and a Stop
// pressed during the copy was told "not generating" while the run went ahead.
//
// The fix is one claim taken synchronously in the request handler, before any await
// beyond reading the request body, and that claim is also what Stop signals: before
// the process exists it records the press, and the run is stopped the instant it
// exists. These tests use the ordinary HTTP entry point and hold the preparation open
// (`HYPERMAKER_HOLD_BEFORE_GUARD_MS`) so the window is entered on purpose instead of
// raced.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-prepare-"));
// The agent appends one line per spawn, outside its run directory, so "one press, one
// process" is counted rather than inferred from the result.
writeFileSync(join(base, "agent.mjs"), `
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR, out = process.argv[process.argv.indexOf("--output-last-message") + 1];
appendFileSync(${JSON.stringify(join(base, "spawns.log"))}, "spawn " + dir + "\\n");
writeFileSync(join(dir, "note.txt"), "a take made by " + dir + "\\n");
await new Promise(r => setTimeout(r, Number(process.env.AGENT_DELAY || 0)));
writeFileSync(out, JSON.stringify({ prompt: "stand-in", script: null, artifact: "note.txt", type: "text", method: "llm", error: null }));
`);
const bin = join(base, "agent-bin");
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(base, "agent.mjs"))} "$@"\n`);
chmodSync(bin, 0o755);
const spawns = () => existsSync(join(base, "spawns.log")) ? readFileSync(join(base, "spawns.log"), "utf8").trim().split("\n").filter(Boolean).length : 0;

const apps = [];
function start(port, workdir, extra = {}) {
  const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "0", ...extra } });
  app.stderr.on("data", c => process.stderr.write(c));
  apps.push(app);
  return app;
}
const workspace = port => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
async function settle(port, id, tries = 300) {
  for (let i = 0; i < tries; i++) {
    const n = (await workspace(port)).nodes[id];
    if (n && n.status !== "running") return n;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`node ${id} never settled`);
}

// An approved take and one ordinary material file big enough that copying it is not
// instant: the same shape the supervisor reproduced with an 8 MiB picture.
const MIB = 8 * 1024 * 1024;
function cardWithBigMaterial(workdir) {
  mkdirSync(join(workdir, "1", "versions"), { recursive: true });
  writeFileSync(join(workdir, "1", "my-poster.png"), Buffer.alloc(MIB, 7));
  writeFileSync(join(workdir, "1", "versions", "v1-note.txt"), "the take I approved\n");
  writeFileSync(join(workdir, "workspace.yml"), [
    "1:", "  x: 40", "  y: 40", "  inputs: []", "  type: text", "  method: llm",
    '  prompt: "the take I approved"', '  promptUsed: "the take I approved"', "  quality: standard",
    "  artifact: versions/v1-note.txt", "  status: idle", ""
  ].join("\n"));
}
const versions = workdir => readdirSync(join(workdir, "1", "versions")).sort();
// One take published beside the kept one is an artifact and the prompt that produced
// it (`v2-note.txt`, `v2-prompt.txt`). Counting artifacts is what "one take" means.
const takes = workdir => versions(workdir).filter(f => !/-prompt\.txt$/.test(f));

after(() => { for (const app of apps) stopServer(app); stopAll(); });

test("two presses that arrive together start one run and publish one take", async () => {
  const workdir = join(base, "together-ws");
  cardWithBigMaterial(workdir);
  const port = await freePort();
  start(port, workdir, { HYPERMAKER_HOLD_BEFORE_GUARD_MS: "1500" });
  await waitReady(port);
  const before = spawns(), versionsBefore = versions(workdir);

  // Pressed at the same moment, the way two open canvases do: neither request waits
  // for the first to be answered.
  // Two separate connections, like two browses: `fetch` reuses one agent and would
  // queue the second request behind the first, which is not the situation being
  // tested (that case already worked - it was the *overlap* that did not).
  const press = () => new Promise((ok, no) => {
    const payload = JSON.stringify({ id: 1, prompt: "a take" });
    const req = request({ host: "127.0.0.1", port, path: "/api/generate", method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => ok({ status: res.statusCode, ...JSON.parse(data) }));
    });
    req.on("error", no);
    req.end(payload);
  });
  const [first, second] = await Promise.all([press(), press()]);
  const codes = [first.status, second.status].sort();
  assert.deepEqual(codes, [202, 409], `exactly one press starts a run, got ${JSON.stringify([first, second].map(r => ({ status: r.status, error: r.error })))}`);
  const refused = first.status === 409 ? first : second;
  assert.match(refused.error, /already generating/i, "the refused press says the card is busy rather than failing quietly");

  const done = await settle(port, 1);
  assert.equal(done.status, "idle", `the one run that was started succeeds, got ${done.error}`);

  assert.equal(spawns() - before, 1, "one agent process for the two presses");
  const after_ = takes(workdir);
  const added = after_.filter(f => !versionsBefore.includes(f));
  assert.equal(added.length, 1, `one take was published, got ${JSON.stringify({ versionsBefore, after: after_ })}`);
  assert.match(done.artifact, /^versions\/v2-/, `the card shows the one new take, got ${done.artifact}`);

  // Nothing of the refused press is left behind: the material is intact and no
  // second run directory survived.
  assert.equal(readFileSync(join(workdir, "1", "my-poster.png")).length, MIB);
  assert.deepEqual(existsSync(join(workdir, ".runs", "1")) ? readdirSync(join(workdir, ".runs", "1")) : [], [], "the successful run's directory is gone");
});

test("Stop during the preparation stops the one run before it becomes a second press", async () => {
  const workdir = join(base, "stop-window-ws");
  cardWithBigMaterial(workdir);
  const port = await freePort();
  start(port, workdir, { HYPERMAKER_HOLD_BEFORE_GUARD_MS: "1500" });
  await waitReady(port);
  const before = spawns(), versionsBefore = versions(workdir);

  assert.equal((await post(port, "/api/generate", { id: 1, prompt: "a take" })).status, 202);
  // The card is marked running while it is still being prepared, so a person looking
  // at it sees a Stop button and a second canvas refuses rather than starting another.
  assert.equal((await workspace(port)).nodes[1].status, "running");
  assert.equal((await post(port, "/api/generate", { id: 1 })).status, 409);

  const stopped = await post(port, "/api/cancel", { id: 1 });
  assert.equal(stopped.status, 200, `Stop during the preparation is accepted, got ${JSON.stringify(stopped)}`);

  const done = await settle(port, 1);
  assert.equal(done.status, "cancelled", `the stopped run is not an error of its own, got ${JSON.stringify(done)}`);
  assert.match(done.error, /stopped by the user/i);
  assert.equal(spawns() - before, 0, "stopping before the process exists means no process was started");
  assert.deepEqual(versions(workdir), versionsBefore, "nothing was published");
  assert.equal(done.artifact, "versions/v1-note.txt", "the approved take is still the one on the card");
  assert.equal(readFileSync(join(workdir, "1", "my-poster.png")).length, MIB, "the material is where the person put it");

  // The card is not left claimed: the next press is a real run.
  assert.equal((await post(port, "/api/generate", { id: 1, prompt: "try again" })).status, 202);
  const again = await settle(port, 1);
  assert.equal(again.status, "idle", `the card can be used again, got ${again.error}`);
  assert.equal(spawns() - before, 1, "and exactly one agent ran for the second press");
  assert.equal(takes(workdir).filter(f => !versionsBefore.includes(f)).length, 1, "which published exactly one take");
});

test("a run that settles does not release the claim of the run after it", async () => {
  // The first run's tail used to delete the slot unconditionally. Once the slot is
  // taken at the press, a settled run clearing it would free a card that is already
  // working again - the canvas would offer Generate and a third run could start.
  const workdir = join(base, "handover-ws");
  cardWithBigMaterial(workdir);
  const port = await freePort();
  start(port, workdir, { AGENT_DELAY: "400" });
  await waitReady(port);

  assert.equal((await post(port, "/api/generate", { id: 1, prompt: "first" })).status, 202);
  const first = await settle(port, 1);
  assert.equal(first.status, "idle", `the first run succeeds, got ${first.error}`);
  // Pressed again the moment it settled: this run is live, and the first run's
  // completion handlers have all run by now.
  assert.equal((await post(port, "/api/generate", { id: 1, prompt: "second" })).status, 202);
  const mid = (await workspace(port)).nodes[1];
  assert.equal(mid.status, "running", "the second run is live and the card says so");
  assert.equal((await post(port, "/api/generate", { id: 1 })).status, 409, "so a third press is refused while it works");
  const second = await settle(port, 1);
  assert.equal(second.status, "idle", `the second run succeeds, got ${second.error}`);
  assert.match(second.artifact, /^versions\/v3-/, "two presses in sequence are two takes, as before");
});
