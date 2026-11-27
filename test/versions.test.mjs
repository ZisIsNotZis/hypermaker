import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";
import { parseWorkspace } from "../server/workspace.mjs";
import { browserPath, launchBrowser } from "./browser.mjs";

// The need: a person changes the material upstream, presses Generate again, and
// wants to compare the new result with the one they already approved - not lose it.
//
// Two failures this is written against, both reproduced by hand before the fix:
//
//   1. The agent writes its usual filename and *then* fails. The card kept the old
//      film's name and provenance but played the failed attempt's bytes, because
//      the agent had written over the file the card was pointing at.
//   2. A film reads its material, then takes minutes. A person replaces the poster
//      meanwhile. The film was made from the old poster, but the saved material
//      copy was taken at the end and held the new one - so the version claimed
//      provenance it never had.
//
// Both are the same root cause, and both are fixed by the same rule: what a run is
// given is frozen before it starts, and what it produces is published under a name
// nothing can write to. The checks below make the rule observable from outside.
const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-versions-")), bin = join(base, "codex");
// The stand-in agent answers with the same filename every time, like a real one.
// The film's bytes are a copy of the material it was given, so "which material went
// into which version" can be read from the files rather than trusted from the
// metadata this test is checking.
writeFileSync(join(base, "agent.mjs"), `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR;
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
const prompt = readFileSync(join(dir, "prompt.txt"), "utf8");
const given = (prompt.match(/artifact path: (\\S+)/) || [])[1];
// Read the material before waiting, so a swap during the wait cannot change what
// this run saw - that is exactly what a real renderer does.
const material = given && existsSync(given) ? readFileSync(given, "utf8") : "no material";
if (prompt.includes("slow")) { const { execFileSync } = await import("node:child_process"); execFileSync("sleep", ["2"]); }
const artifact = join(dir, "film.png");
// A failing run still writes a partial file first, which is the case that used to
// destroy the approved film.
writeFileSync(artifact, "made from " + material + (prompt.includes("please fail") ? " (unfinished)" : ""));
if (prompt.includes("please fail")) { console.error("the agent could not finish"); process.exit(3); }
if (out) writeFileSync(out, JSON.stringify({ prompt: "p", script: null, artifact, type: "image", method: "remotion", error: null }));
`);
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(base, "agent.mjs"))} "$@"\n`);
chmodSync(bin, 0o755);

const missingBrowser = existsSync(browserPath()) ? null
  : `no Chromium at ${browserPath()}: run \`npx playwright install chromium\` or set HYPERMAKER_CHROME`;
const canvasTest = (name, fn) => test(name, missingBrowser ? { skip: missingBrowser } : {}, fn);

let app, port, workdir, browser;
before(async () => {
  port = await freePort();
  workdir = join(base, "ws");
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
  if (!missingBrowser) browser = await launchBrowser();
});
after(async () => { await browser?.close(); stopServer(app); stopAll(); });

const call = (method, path, payload) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
const workspace = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
async function settle(id, tries = 400) {
  for (let i = 0; i < tries; i++) {
    const node = (await workspace()).nodes[id];
    if (node && node.status !== "running") return node;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`node ${id} never settled`);
}
const bytesOf = (id, file) => readFileSync(join(workdir, String(id), file), "utf8").trim();

// One film card and one material card, so both tests can share a workspace without
// depending on each other's numbering.
let materialId, filmId;
async function setUp() {
  const created = await call("POST", "/api/node", { x: 0, y: 0, type: "image", method: "remotion", prompt: "material" });
  materialId = Number(Object.keys(created.nodes).at(-1));
  mkdirSync(join(workdir, String(materialId)), { recursive: true });
  filmId = Number(Object.keys((await call("POST", "/api/node", { x: 300, y: 0, type: "image", method: "remotion", prompt: "first take" })).nodes).at(-1));
  await call("POST", "/api/link", { source: materialId, target: filmId });
}
const setMaterial = text => { writeFileSync(join(workdir, String(materialId), "poster.png"), text); };
async function paint(text) {
  // The card has to be told the material exists; that is what a person's generated
  // poster looks like from the server's side.
  setMaterial(text);
  await call("PATCH", "/api/node", { id: materialId, artifact: "poster.png" });
}

test("a failed attempt cannot take the film the person is looking at, nor relabel it", async () => {
  await setUp();
  await paint("A");
  await call("POST", "/api/generate", { id: filmId });
  const first = await settle(filmId);
  assert.equal(first.error, null, `the first film rendered, got ${first.error}`);
  assert.equal(bytesOf(filmId, first.artifact), "made from A");

  // The upstream material changes, the person tries again, and this time the agent
  // writes its usual filename and then dies.
  await paint("B");
  await call("PATCH", "/api/node", { id: filmId, prompt: "please fail" });
  await call("POST", "/api/generate", { id: filmId });
  const failed = await settle(filmId);

  assert.equal(failed.status, "error");
  assert.equal(bytesOf(filmId, failed.artifact), "made from A", "the card still plays the film that worked");
  assert.equal(failed.sources.length, 1);
  assert.equal(bytesOf(filmId, failed.sources[0].file), "A", "and its provenance still names the material it was really made from");
  assert.deepEqual(failed.versions || [], [], "a failed first attempt leaves nothing to compare");

  // The partial file the agent wrote is scratch and must not be what anyone sees.
  assert.notEqual(bytesOf(filmId, failed.artifact), "made from B (unfinished)");
});

test("a second version keeps the first one playable, its own bytes and its own material", async () => {
  await call("PATCH", "/api/node", { id: filmId, prompt: "second take" });
  await call("POST", "/api/generate", { id: filmId });
  const second = await settle(filmId);
  assert.equal(second.error, null, `the second film rendered, got ${second.error}`);
  assert.equal(bytesOf(filmId, second.artifact), "made from B", "the card shows the new film");
  assert.equal(second.versions.length, 1, "the film it replaced is still listed");
  const kept = second.versions[0];
  assert.equal(bytesOf(filmId, kept.file), "made from A", "and its bytes are the ones that were approved");
  assert.equal(bytesOf(filmId, kept.sources[0].file), "A", "with the material that film saw, not today's");
  assert.equal(bytesOf(filmId, second.sources[0].file), "B", "and the new film records its own material");
  assert.notEqual(second.artifact, kept.file, "two versions cannot share one file");

  // Going back is not a one-way door: the film being replaced becomes the alternative.
  const restored = (await call("POST", "/api/restore", { id: filmId, version: kept.id })).nodes[filmId];
  assert.equal(bytesOf(filmId, restored.artifact), "made from A", "going back really restores the earlier film");
  assert.equal(bytesOf(filmId, restored.sources[0].file), "A", "with the material that film was made from");
  assert.equal(restored.versions.length, 1);
  assert.equal(bytesOf(filmId, restored.versions[0].file), "made from B", "and the film you left is the alternative");
});

test("a material swapped mid-render does not change what the film is made from, or what it records", async () => {
  await call("PATCH", "/api/node", { id: filmId, prompt: "slow take" });
  await call("POST", "/api/generate", { id: filmId });
  for (let i = 0; i < 60 && (await workspace()).nodes[filmId].status !== "running"; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await workspace()).nodes[filmId].status, "running", "the film is really rendering while the material is swapped");
  // The person replaces the poster's file while the film is being made.
  setMaterial("C");
  const done = await settle(filmId);
  assert.equal(done.error, null, `the film finished, got ${done.error}`);
  assert.equal(bytesOf(filmId, done.artifact), "made from B", "the film used the material it started with");
  assert.equal(bytesOf(filmId, done.sources[0].file), "B", "and the material it recorded is the same bytes");
  assert.equal(bytesOf(materialId, "poster.png"), "C", "while the card upstream now holds the new material");
});

test("an agent that hands back the previous render fails instead of publishing it again", async () => {
  // A real run did this: two different posters, two "versions", byte-identical video,
  // because the agent named the film it had already rendered. "The file exists" was
  // treated as "this run made it", so the card showed a second version made from
  // material the film never saw. A creator needs to see a failure they can retry,
  // with the approved version still playable.
  const reuseBin = join(base, "reuse-codex");
  // fake-agent.mjs is the one that can leave a file behind and name it again; the
  // film stand-in above always renders a fresh PNG.
  writeFileSync(reuseBin, `#!/bin/sh\nAGENT_MODE=reuse exec node ${JSON.stringify(join(root, "test/fake-agent.mjs"))} "$@"\n`);
  chmodSync(reuseBin, 0o755);
  const reusePort = await freePort(), reuseWorkdir = join(base, "reuse-ws");
  const reuse = startServer({ cwd: root, port: reusePort, env: { CODEX_BIN: reuseBin, HYPERMAKER_WORKDIR: reuseWorkdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  reuse.stderr.on("data", c => process.stderr.write(c));
  await waitReady(reusePort);
  const api = (method, path, payload) => fetch(`http://127.0.0.1:${reusePort}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
  const ws = () => fetch(`http://127.0.0.1:${reusePort}/api/workspace`).then(r => r.json());
  const wait = async id => { for (let i = 0; i < 200; i++) { const n = (await ws()).nodes[id]; if (n.status !== "running") return n; await new Promise(r => setTimeout(r, 100)); } };

  try {
    const card = Number(Object.keys((await api("POST", "/api/node", { x: 0, y: 0, type: "text", method: "llm", prompt: "first" })).nodes).at(-1));
    await api("POST", "/api/generate", { id: card });
    const first = await wait(card);
    assert.equal(first.error, null, `the first run produced output, got ${first.error}`);
    const approved = first.artifact;

    // The second attempt names the same file without rewriting it. Deliberately back
    // to back, with no pause: an earlier version of this check allowed a second of
    // clock slack for timestamps, so two runs closer together than that let the old
    // file through and published it as a new version. Waiting 1.5s first hid exactly
    // the case a person hits - change the prompt and press Generate again.
    await api("PATCH", "/api/node", { id: card, prompt: "second" });
    await api("POST", "/api/generate", { id: card });
    const second = await wait(card);

    assert.equal(second.status, "error", "handing back an old file is a failure, not a new version");
    assert.match(second.error, /without rewriting it/, `the card says what happened, got ${second.error}`);
    assert.equal(second.artifact, approved, "the approved artifact is still the one on the card");
    assert.deepEqual(second.versions || [], [], "and no duplicate version was published");
    const approvedBytes = readFileSync(join(reuseWorkdir, String(card), approved), "utf8").trim();
    assert.match(approvedBytes, /made by an earlier run/, "the approved bytes are untouched");
  } finally {
    stopServer(reuse);
  }
});

test("kept versions survive a restart, and a card that is generating refuses to be rewound", async () => {
  const before = (await workspace()).nodes[filmId];
  assert.ok(before.versions?.length, "there is a version to check");

  stopServer(app);
  await new Promise(r => setTimeout(r, 300));
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "0" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);

  const reopened = (await workspace()).nodes[filmId];
  assert.equal(reopened.versions.length, before.versions.length, "the alternative versions are still there after reopening");
  for (const version of reopened.versions) {
    assert.ok(version.file && existsSync(join(workdir, String(filmId), version.file)), `version ${version.id} still has its file`);
    assert.ok(version.sources[0].file, `version ${version.id} still names its material copy`);
  }

  // A run in flight must not be rewound underneath itself: it would publish a
  // result the person had just navigated away from.
  await call("PATCH", "/api/node", { id: filmId, prompt: "slow again" });
  await call("POST", "/api/generate", { id: filmId });
  for (let i = 0; i < 60 && (await workspace()).nodes[filmId].status !== "running"; i++) await new Promise(r => setTimeout(r, 100));
  const refused = await fetch(`http://127.0.0.1:${port}/api/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: filmId, version: reopened.versions[0].id }) });
  assert.equal(refused.status, 409, "a card that is generating is not rewound underneath the agent");
  assert.match((await refused.json()).error, /generating/i, "the refusal says why, rather than silently doing nothing");
  const finished = await settle(filmId);
  assert.equal(finished.status, "idle");
  assert.ok(finished.versions.length >= reopened.versions.length + 1, "the finished run kept the film it replaced");
});

// The other side of the same rule. A deterministic renderer - same poster, same
// text, fixed frame count - really can produce identical bytes twice. That is a
// second result, not a stale file, and refusing it would make the canvas look
// broken to anyone whose output reproduces exactly. So the rule is "was this file
// written", not "did its bytes change"; this test fails if the check ever drifts
// back to comparing content.
// The instruction is provenance too. Two takes of one card differ by what they were
// asked for, and the canvas used to keep only the bytes: going back to an earlier
// film left the prompt box describing the newer one, so the card showed one thing and
// claimed another. Worse, the record it kept for the replaced version was read from
// the box at the *start* of the next run, so simply editing the text and pressing
// Generate rewrote the history of the film already on screen.
//
// These checks use their own server and their own stand-in agent, whose output is the
// instruction it was given: then "which prompt made these bytes" is readable from the
// files, not trusted from the metadata being tested.
test("a kept version carries the prompt that made it, and going back brings it too", async () => {
  const promptAgent = join(base, "prompt-agent.mjs"), promptBin = join(base, "prompt-codex");
  writeFileSync(promptAgent, `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR;
mkdirSync(dir, { recursive: true });
const asked = readFileSync(join(dir, "prompt.txt"), "utf8").split("# USER PROMPT").pop().trim();
writeFileSync(join(dir, "take.txt"), "asked for: " + asked);
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (out) writeFileSync(out, JSON.stringify({ prompt: asked, script: null, artifact: "take.txt", type: "text", method: "llm", error: null }));
`);
  writeFileSync(promptBin, `#!/bin/sh\nexec node ${JSON.stringify(promptAgent)} "$@"\n`);
  chmodSync(promptBin, 0o755);

  const promptPort = await freePort(), promptWorkdir = join(base, "prompt-ws");
  const prompt = startServer({ cwd: root, port: promptPort, env: { CODEX_BIN: promptBin, HYPERMAKER_WORKDIR: promptWorkdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  prompt.stderr.on("data", c => process.stderr.write(c));
  await waitReady(promptPort);
  const api = (method, path, payload) => fetch(`http://127.0.0.1:${promptPort}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
  const ws = () => fetch(`http://127.0.0.1:${promptPort}/api/workspace`).then(r => r.json());
  const wait = async id => { for (let i = 0; i < 300; i++) { const n = (await ws()).nodes[id]; if (n.status !== "running") return n; await new Promise(r => setTimeout(r, 100)); } throw new Error("never settled"); };
  const says = async (id, file) => (await (await fetch(`http://127.0.0.1:${promptPort}/api/file?path=${encodeURIComponent(join(promptWorkdir, String(id), file))}`)).text()).trim();

  try {
    const card = Number(Object.keys((await api("POST", "/api/node", { x: 0, y: 0, type: "text", method: "llm", prompt: "a film about the sea" })).nodes).at(-1));
    await api("POST", "/api/generate", { id: card, prompt: "a film about the sea" });
    const first = await wait(card);
    assert.equal(first.promptUsed, "a film about the sea", "the card records the instruction behind the artifact it shows");

    // A person starts rewriting the box but does not press Generate yet. The film on
    // screen was not made from those words, and the card must not start saying it was
    // - that is how an edit became a false history of an already approved take.
    await api("PATCH", "/api/node", { id: card, prompt: "a film about the mountains" });
    const edited = (await ws()).nodes[card];
    assert.equal(edited.promptUsed, "a film about the sea", "an edit to the box is not a fact about the artifact on screen");
    assert.equal(await says(card, edited.artifact), "asked for: a film about the sea");

    await api("POST", "/api/generate", { id: card });
    await wait(card);
    const second = (await ws()).nodes[card];
    assert.equal(second.promptUsed, "a film about the mountains");
    assert.equal(second.versions.length, 1);
    const kept = second.versions[0];
    assert.equal(kept.prompt, "a film about the sea", "the version it replaced records the words that made its bytes");
    assert.notEqual(kept.prompt, second.prompt, "and not the take that replaced it");
    assert.equal(await says(card, kept.file), "asked for: a film about the sea");

    // Going back has to move the instruction with the bytes, or the card plays the sea
    // film while the box reads "mountains" and the next Generate silently redoes a
    // take the person thought they were looking at.
    const back = (await api("POST", "/api/restore", { id: card, version: kept.id })).nodes[card];
    assert.equal(await says(card, back.artifact), "asked for: a film about the sea");
    assert.equal(back.prompt, "a film about the sea", "the box now describes the film on screen");
    assert.equal(back.promptUsed, "a film about the sea");
    assert.equal(back.versions[0].prompt, "a film about the mountains", "and the film left behind keeps its own words");
    assert.equal(await says(card, back.versions[0].file), "asked for: a film about the mountains");

    // A version kept before prompts were recorded must not inherit today's words.
    const legacy = parseWorkspace(`1:\n  type: text\n  method: llm\n  prompt: today's words\n  artifact: versions/v1-take.txt\n  versions: [{"id":9,"artifact":"versions/v9-take.txt","file":"versions/v9-take.txt","sources":[],"prompt":null}]\n`);
    assert.equal(legacy[1].versions[0].prompt, null, "an unknown prompt stays unknown instead of being invented");
  } finally {
    stopServer(prompt);
  }
});

// The canvas is a single script, so one undefined name in one helper is not a small
// bug: it takes the whole page down, and the page then shows no cards at all. That
// happened while adding the "asked for" line - `oneLine` was declared inside
// `versions()` and used by `used()` - and the lexical check in html-syntax.test.mjs
// could not see it, because the name *is* declared somewhere in the script. Only
// running the page catches it, so this test runs the page.
//
// It also pins the number a take is published under, and it needs a particular kind of
// agent to do that: one that renders to a fresh path each run, which is what the video
// method guide tells a real agent to do. Publishing used to number by filename
// collision, so those runs became `v1-shot-a.png` and `v1-shot-b.png` - two takes of
// one card, both labelled v1. The rest of this suite's stand-in always writes
// `film.png`, and for a fixed filename the broken numbering and the right one agree,
// so a test built on it stays green with the bug in place.
canvasTest("two takes get different version numbers, and the canvas survives the render", async () => {
  const freshAgent = join(base, "fresh-agent.mjs"), freshBin = join(base, "fresh-codex");
  writeFileSync(freshAgent, `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR;
mkdirSync(dir, { recursive: true });
const asked = readFileSync(join(dir, "prompt.txt"), "utf8").split("# USER PROMPT").pop().trim();
// A fresh path each run, as the video method guide tells a real agent to render.
const artifact = "shot-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".png";
writeFileSync(join(dir, artifact), "made from: " + asked);
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (out) writeFileSync(out, JSON.stringify({ prompt: asked, script: null, artifact, type: "image", method: "remotion", error: null }));
`);
  writeFileSync(freshBin, `#!/bin/sh\nexec node ${JSON.stringify(freshAgent)} "$@"\n`);
  chmodSync(freshBin, 0o755);

  const uiPort = await freePort(), uiWorkdir = join(base, "ui-ws");
  const ui = startServer({ cwd: root, port: uiPort, env: { CODEX_BIN: freshBin, HYPERMAKER_WORKDIR: uiWorkdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  ui.stderr.on("data", c => process.stderr.write(c));
  await waitReady(uiPort);
  const api = (method, path, payload) => fetch(`http://127.0.0.1:${uiPort}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
  const ws = () => fetch(`http://127.0.0.1:${uiPort}/api/workspace`).then(r => r.json());
  const wait = async id => { for (let i = 0; i < 300; i++) { const n = (await ws()).nodes[id]; if (n.status !== "running") return n; await new Promise(r => setTimeout(r, 100)); } throw new Error("never settled"); };
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  const errors = []; page.on("pageerror", e => errors.push(String(e)));

  try {
    const card = Number(Object.keys((await api("POST", "/api/node", { x: 60, y: 60, type: "image", method: "remotion", prompt: "first take" })).nodes).at(-1));
    await page.goto(`http://127.0.0.1:${uiPort}/`);
    await page.waitForSelector(`.card[data-id="${card}"]`);
    await page.locator(`.card[data-id="${card}"] [data-generate]`).click();
    await wait(card);
    await page.waitForFunction(id => !document.querySelector(`.card[data-id="${id}"] [data-generate]`).disabled, card, { timeout: 15000 });
    const sel = `.card[data-id="${card}"]`;
    const read = () => page.evaluate(sel => {
      const card = document.querySelector(sel);
      if (!card) return null;
      return {
        meta: card.querySelector(".meta").textContent,
        promptInBox: card.querySelector("[data-prompt]").value,
        askedFor: card.querySelector(".used")?.textContent ?? null,
        kept: card.querySelector(".versions")?.textContent ?? null,
        keptTitle: card.querySelector(".versions button")?.title ?? null,
      };
    }, sel);
    const one = await read();
    assert.ok(one, "the card is on the page at all: an error in the canvas script leaves an empty viewport");
    assert.match(one.meta, /v1\b/, `the first take is v1, got ${one.meta}`);
    assert.equal(one.askedFor, null, "the box and the artifact agree, so there is nothing to warn about");

    // Rewriting the box must not change what the artifact on screen was asked for.
    await page.fill(`${sel} [data-prompt]`, "second take");
    await page.locator(`${sel} [data-prompt]`).blur();
    await page.waitForTimeout(400);
    const edited = await read();
    assert.equal(edited.promptInBox, "second take");
    assert.equal(edited.askedFor, "asked for: first take", "the card still says what the picture on it was made from");
    assert.match(edited.meta, /v1\b/, "editing the box is not a new version");

    await page.locator(`${sel} [data-generate]`).click();
    await wait(card);
    await page.waitForFunction(id => !document.querySelector(`.card[data-id="${id}"] [data-generate]`).disabled, card, { timeout: 15000 });
    await page.waitForTimeout(400);
    const two = await read();
    assert.match(two.meta, /v2\b/, `the second take is v2, got ${two.meta}`);
    // The row also carries a compare control, so match the part that matters: the
    // kept take is named and reachable. Pinning the whole string made an unrelated
    // addition to the row look like a regression.
    assert.match(two.kept, /kept v1\b/, `the first take is still one click away, got ${two.kept}`);
    assert.equal(two.keptTitle, "asked for: first take", "the kept version says what made it");

    await page.locator(`${sel} .versions button`).first().click();
    await page.waitForFunction(sel => document.querySelector(`${sel} .meta`).textContent.includes("v1"), sel, { timeout: 15000 });
    await page.waitForTimeout(400);
    const back = await read();
    assert.equal(back.promptInBox, "first take", "going back puts the words that made it back in the box");
    assert.equal(back.askedFor, null, "so there is nothing left to warn about");
    assert.equal(back.keptTitle, "asked for: second take", "and the other take still carries its own");
    assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  } finally {
    await page.close();
    stopServer(ui);
  }
});

// Keeping two takes is only useful if a person can choose between them, and choosing
// by memory - watch one, swap the card, watch the other - is how the wrong take gets
// regenerated. So the card offers a side-by-side view, and this drives it: both panes
// show real bytes from the two files, each says which take it is and what it was asked
// for, either side can be repointed at another version, and the card underneath is left
// alone - comparing must never swap what the card is showing.
// The first thing a person meets after upgrading, and the one the fix got wrong: a card
// whose oldest version predates stored prompts sitting next to a newer one that has one.
// Restoring the old version moved the bytes and the materials and left `promptUsed`
// alone - so the card showed the old picture while still claiming the instruction of the
// take it had just replaced. "No instruction recorded" is a fact that has to travel with
// the version like any other.
//
// Written as a workspace on disk rather than by generating, because that is the state a
// person actually arrives in: the old version's record has no prompt because nothing
// recorded one at the time.
test("restoring a version from before prompts were recorded does not inherit the newer take's instruction", async () => {
  const legacyPort = await freePort(), legacyWorkdir = join(base, "legacy-ws");
  mkdirSync(join(legacyWorkdir, "1", "versions"), { recursive: true });

  // Two takes of one card, as the filesystem would hold them: the old one published
  // before this feature existed, the new one after. The bytes say which is which, so a
  // card claiming the wrong instruction is visible in the files too.
  writeFileSync(join(legacyWorkdir, "1", "versions", "v1-old.txt"), "asked for: the old idea");
  writeFileSync(join(legacyWorkdir, "1", "versions", "v2-new.txt"), "asked for: the new idea");
  writeFileSync(join(legacyWorkdir, "1", "versions", "s1-from-9-poster.png"), "material");
  const versions = [
    // The old version does have recorded materials - provenance was shipped before
    // prompts were - so this also checks that a version's materials travel with it
    // while its unknown instruction stays unknown.
    { id: 1, artifact: "versions/v1-old.txt", file: "versions/v1-old.txt", sources: [{ id: 9, type: "image", artifact: "poster.png", file: "versions/s1-from-9-poster.png" }], prompt: null },
    { id: 2, artifact: "versions/v2-new.txt", file: "versions/v2-new.txt", sources: [], prompt: "the new idea" },
  ];
  writeFileSync(join(legacyWorkdir, "workspace.yml"), [
    "1:",
    "  x: 40",
    "  y: 40",
    "  inputs: []",
    "  type: text",
    "  method: llm",
    '  prompt: "a draft I am writing now"',
    '  promptUsed: "the new idea"',
    "  quality: standard",
    '  artifact: versions/v2-new.txt',
    "  status: idle",
    '  sources: [{"id":9,"type":"image","artifact":"poster.png","file":"versions/s1-from-9-poster.png"}]',
    `  versions: ${JSON.stringify(versions)}`,
    ""
  ].join("\n"));

  const legacy = startServer({ cwd: root, port: legacyPort, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: legacyWorkdir, HYPERMAKER_RESET_WORKSPACE: "0" } });
  legacy.stderr.on("data", c => process.stderr.write(c));
  await waitReady(legacyPort);
  const api = (method, path, payload) => fetch(`http://127.0.0.1:${legacyPort}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());

  try {
    const before = (await api("GET", "/api/workspace")).nodes["1"];
    assert.equal(before.promptUsed, "the new idea", "the card starts on the take that does have an instruction");
    assert.equal(before.prompt, "a draft I am writing now", "with the next take in the box");

    const after = (await api("POST", "/api/restore", { id: 1, version: 1 })).nodes["1"];
    assert.equal(after.artifact, "versions/v1-old.txt", "the picture is the old one");
    assert.equal(after.promptUsed, null, "and the card no longer claims the replaced take's instruction");
    assert.equal(after.prompt, "a draft I am writing now", "while the box keeps what the person is writing - a restore is not the moment to discard it");
    assert.equal(after.sources.length, 1, "the old version's materials still travel with it");

    // Going back the other way restores the instruction it does know, in the box too.
    const forward = (await api("POST", "/api/restore", { id: 1, version: after.versions[0].id })).nodes["1"];
    assert.equal(forward.artifact, "versions/v2-new.txt");
    assert.equal(forward.promptUsed, "the new idea");
    assert.equal(forward.prompt, "the new idea");
    assert.equal(forward.versions[0].prompt, null, "and the version left behind still records nothing rather than the wrong thing");
  } finally {
    stopServer(legacy);
  }
});

// The same case on the canvas: silence there reads as agreement, so an artifact whose
// instruction is not recorded has to say so.
canvasTest("a card whose artifact predates stored prompts says the instruction is unknown", async () => {
  const unknownPort = await freePort(), unknownWorkdir = join(base, "unknown-ws");
  mkdirSync(join(unknownWorkdir, "1", "versions"), { recursive: true });
  writeFileSync(join(unknownWorkdir, "1", "versions", "v1-old.txt"), "the old idea, rendered");
  writeFileSync(join(unknownWorkdir, "workspace.yml"), [
    "1:",
    "  x: 40",
    "  y: 40",
    "  inputs: []",
    "  type: text",
    "  method: llm",
    '  prompt: "whatever I type next"',
    "  quality: standard",
    '  artifact: versions/v1-old.txt',
    "  status: idle",
    ""
  ].join("\n"));
  const unknown = startServer({ cwd: root, port: unknownPort, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: unknownWorkdir, HYPERMAKER_RESET_WORKSPACE: "0" } });
  unknown.stderr.on("data", c => process.stderr.write(c));
  await waitReady(unknownPort);
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  const errors = []; page.on("pageerror", e => errors.push(String(e)));
  try {
    await page.goto(`http://127.0.0.1:${unknownPort}/`);
    const sel = `.card[data-id="1"]`;
    await page.waitForSelector(sel);
    const shown = await page.evaluate(sel => ({
      askedFor: document.querySelector(`${sel} .used`)?.textContent ?? null,
      prompt: document.querySelector(`${sel} [data-prompt]`).value,
    }), sel);
    assert.match(shown.askedFor || "", /unknown/, `the card says the instruction is not recorded, got ${shown.askedFor}`);
    assert.equal(shown.prompt, "whatever I type next", "and does not touch what the person is writing");
    assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  } finally {
    await page.close();
    stopServer(unknown);
  }
});

canvasTest("two takes can be watched side by side without moving the card", async () => {
  const freshAgent = join(base, "cmp-agent.mjs"), freshBin = join(base, "cmp-codex");
  // The artifact is the text of the prompt, so each pane's bytes say which take they
  // are; a comparison that silently showed the same file twice would read as a pass.
  writeFileSync(freshAgent, `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR;
mkdirSync(dir, { recursive: true });
const asked = readFileSync(join(dir, "prompt.txt"), "utf8").split("# USER PROMPT").pop().trim();
const artifact = "take-" + Date.now() + ".txt";
writeFileSync(join(dir, artifact), "asked for: " + asked);
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (out) writeFileSync(out, JSON.stringify({ prompt: asked, script: null, artifact, type: "text", method: "llm", error: null }));
`);
  writeFileSync(freshBin, `#!/bin/sh\nexec node ${JSON.stringify(freshAgent)} "$@"\n`);
  chmodSync(freshBin, 0o755);

  const cmpPort = await freePort(), cmpWorkdir = join(base, "cmp-ws");
  const cmp = startServer({ cwd: root, port: cmpPort, env: { CODEX_BIN: freshBin, HYPERMAKER_WORKDIR: cmpWorkdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  cmp.stderr.on("data", c => process.stderr.write(c));
  await waitReady(cmpPort);
  const api = (method, path, payload) => fetch(`http://127.0.0.1:${cmpPort}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
  const ws = () => fetch(`http://127.0.0.1:${cmpPort}/api/workspace`).then(r => r.json());
  const wait = async id => { for (let i = 0; i < 300; i++) { const n = (await ws()).nodes[id]; if (n.status !== "running") return n; await new Promise(r => setTimeout(r, 100)); } throw new Error("never settled"); };
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = []; page.on("pageerror", e => errors.push(String(e)));

  try {
    const card = Number(Object.keys((await api("POST", "/api/node", { x: 60, y: 60, type: "text", method: "llm", prompt: "a sea film" })).nodes).at(-1));
    await api("POST", "/api/generate", { id: card, prompt: "a sea film" });
    await wait(card);
    await api("POST", "/api/generate", { id: card, prompt: "a mountain film" });
    const second = await wait(card);

    await page.goto(`http://127.0.0.1:${cmpPort}/`);
    const sel = `.card[data-id="${card}"]`;
    await page.waitForSelector(`${sel} .versions [data-compare]`);

    // The control is inside the card, so pressing it must not also count as a version
    // restore or a card drag.
    await page.locator(`${sel} [data-compare]`).click();
    await page.waitForSelector(".cmp .pane section[data-side=right] pre[data-text]");
    await page.waitForFunction(() => !document.querySelector(".cmp .pane section[data-side=right] pre").textContent.includes("loading"), null, { timeout: 8000 });

    const pane = async side => page.evaluate(side => {
      const s = document.querySelector(`.cmp .pane section[data-side=${side}]`);
      return { caption: s.querySelector(".caption").textContent, bytes: s.querySelector("pre")?.textContent ?? (s.querySelector("video,audio,img")?.getAttribute("src") ?? null) };
    }, side);
    const left = await pane("left"), right = await pane("right");
    assert.match(left.bytes, /asked for: a mountain film/, `the left pane shows the take on the card, got ${left.bytes}`);
    assert.match(right.bytes, /asked for: a sea film/, `the right pane shows the kept take, got ${right.bytes}`);
    assert.match(left.caption, /card/, `the left caption names the take, got ${left.caption}`);
    assert.match(right.caption, /kept v1/, `the right caption names the take, got ${right.caption}`);
    assert.match(right.caption, /asked for: a sea film/, "and what that take was asked for");

    // Repointing the left side must repaint that pane only.
    await page.selectOption('.cmp [data-pick="left"]', String(second.versions[0].id));
    await page.waitForFunction(() => !document.querySelector(".cmp .pane section[data-side=left] pre").textContent.includes("loading"), null, { timeout: 8000 });
    const swapped = await pane("left");
    assert.match(swapped.bytes, /asked for: a sea film/, `the left pane follows its selector, got ${swapped.bytes}`);

    // Escape closes it, and the card never moved: comparing is looking, not choosing.
    await page.keyboard.press("Escape");
    await page.waitForSelector(".cmp", { state: "detached" });
    const after = (await ws()).nodes[card];
    assert.equal(after.artifact, second.artifact, "the card still shows the take it showed before");
    assert.equal(after.promptUsed, "a mountain film");
    assert.equal(after.versions.length, 1, "and nothing was restored by looking");
    assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  } finally {
    await page.close();
    stopServer(cmp);
  }
});

test("a run that really renders again is accepted even when the bytes are identical", async () => {
  const echoAgent = join(base, "echo-agent.mjs");
  const echoBin = join(base, "echo-codex");
  writeFileSync(echoAgent, `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR;
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
writeFileSync(join(dir, "still.png"), "a deterministic frame");
if (out) writeFileSync(out, JSON.stringify({ prompt: "p", script: null, artifact: "still.png", type: "image", method: "remotion", error: null }));
`);
  writeFileSync(echoBin, `#!/bin/sh\nexec node ${JSON.stringify(echoAgent)} "$@"\n`);
  chmodSync(echoBin, 0o755);
  const echoPort = await freePort(), echoWorkdir = join(base, "echo-ws");
  const echo = startServer({ cwd: root, port: echoPort, env: { CODEX_BIN: echoBin, HYPERMAKER_WORKDIR: echoWorkdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  echo.stderr.on("data", c => process.stderr.write(c));
  await waitReady(echoPort);
  const api = (method, path, payload) => fetch(`http://127.0.0.1:${echoPort}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
  const ws = () => fetch(`http://127.0.0.1:${echoPort}/api/workspace`).then(r => r.json());
  const wait = async id => { for (let i = 0; i < 200; i++) { const n = (await ws()).nodes[id]; if (n.status !== "running") return n; await new Promise(r => setTimeout(r, 100)); } };

  try {
    const card = Number(Object.keys((await api("POST", "/api/node", { x: 0, y: 0, type: "image", method: "remotion", prompt: "first" })).nodes).at(-1));
    await api("POST", "/api/generate", { id: card });
    const first = await wait(card);
    assert.equal(first.error, null, `the first run rendered, got ${first.error}`);

    // No pause, and the same bytes by construction.
    await api("POST", "/api/generate", { id: card });
    const second = await wait(card);
    assert.equal(second.status, "idle", `a real second render is a result, got ${second.error}`);
    assert.equal(second.versions.length, 1, "and the render it replaced is kept");
    assert.notEqual(second.artifact, second.versions[0].file, "the two renders have separate files");
    assert.equal(readFileSync(join(echoWorkdir, String(card), second.artifact), "utf8"), readFileSync(join(echoWorkdir, String(card), second.versions[0].file), "utf8"), "with identical bytes, which is why content cannot decide this");
  } finally {
    stopServer(echo);
  }
});
