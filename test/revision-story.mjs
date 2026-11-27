// The revision story, walked through the real browser entry:
// make a film from a line of text and a picture, change the upstream material,
// make a second take, compare the two, and go back to the first one's meaning.
// The revision story the way a person walks it, through the real browser entry, with
// every artifact rendered for real (Remotion still and h264 film) by a stand-in agent:
//
//   a line of text + a picture -> a film
//   change both upstream materials -> a second take
//   compare the two               -> which material and which instruction went into which
//   go back to the first take     -> and keep editing its meaning
//
// Not part of `npm test`: it renders two films and takes about a minute, and
// `test/revision.test.mjs` already gates the part that would regress. This is the
// evidence a person can rerun and look at.
//
//   HYPERMAKER_CHROME=/path/to/chrome node test/revision-story.mjs
//
// HYPERMAKER_SHOTS (default `.tmp/revision`) receives a screenshot at each step and
// `receipt.json` - every fact asserted along the way, including each take's own prompt
// and the frozen copy of each material, so "which material went into which take" can be
// read from the record rather than trusted from the captions this script also checks.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

const root = process.cwd();
const base = mkdtempSync(join(tmpdir(), "hyper-rev-"));
const bin = join(base, "codex");
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(root, "test", "revision-agent.mjs"))} "$@"\n`);
chmodSync(bin, 0o755);
const port = await freePort();
const workdir = join(base, "ws");
const chrome = process.env.HYPERMAKER_CHROME;
const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1", HYPERMAKER_CHROME: chrome } });
const log = [];
app.stdout.on("data", c => log.push(c.toString()));
app.stderr.on("data", c => log.push(c.toString()));
await waitReady(port);
const browser = await chromium.launch({ headless: true, executablePath: chrome });
const shots = process.env.HYPERMAKER_SHOTS || join(root, ".tmp", "revision");
mkdirSync(shots, { recursive: true });
const ws = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
async function settle(id, tries = 900) {
  for (let i = 0; i < tries; i++) {
    const n = (await ws()).nodes[id];
    if (n && n.status !== "running") return n;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`node ${id} never settled`);
}
const out = { steps: [] };
const note = (name, value) => { out.steps.push({ name, value }); console.log(name, JSON.stringify(value)); };

let page;
try {
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector("#cards");

  // 1. text card, typed in the canvas
  await page.mouse.dblclick(120, 120); await page.waitForTimeout(200);
  const textCard = page.locator(".card").last();
  await textCard.locator("[data-prompt]").click();
  await textCard.locator("[data-prompt]").pressSequentially("A lighthouse keeper hears the sea in a shell.");
  await textCard.locator("[data-prompt]").blur();
  await page.waitForTimeout(300);
  const textId = await textCard.getAttribute("data-id");
  await textCard.locator("[data-generate]").click();
  const textNode = await settle(textId);
  note("text take", { artifact: textNode.artifact, status: textNode.status, error: textNode.error });

  // 2. poster card
  await page.mouse.dblclick(560, 120); await page.waitForTimeout(200);
  const posterCard = page.locator(".card").last();
  await posterCard.locator("[data-field=type]").selectOption("image");
  await page.waitForTimeout(300);
  await posterCard.locator("[data-prompt]").click();
  await posterCard.locator("[data-prompt]").pressSequentially("first poster");
  await posterCard.locator("[data-prompt]").blur();
  await page.waitForTimeout(300);
  const posterId = await posterCard.getAttribute("data-id");
  await posterCard.locator("[data-generate]").click();
  const poster1 = await settle(posterId);
  note("poster take 1", { artifact: poster1.artifact, status: poster1.status, error: poster1.error });

  // 3. film card, linked from both by dragging the source title bars
  await page.mouse.dblclick(900, 400); await page.waitForTimeout(200);
  const filmCard = page.locator(".card").last();
  await filmCard.locator("[data-field=type]").selectOption("video");
  await page.waitForTimeout(300);
  const filmId = await filmCard.getAttribute("data-id");
  const boxOf = async id => page.locator(`.card[data-id="${id}"]`).boundingBox();
  for (const src of [textId, posterId]) {
    const a = await boxOf(src), b = await boxOf(filmId);
    await page.mouse.move(a.x + 100, a.y + 15); await page.mouse.down();
    await page.mouse.move(b.x + 100, b.y + 15, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(250);
  }
  note("links", (await ws()).nodes[filmId].inputs);
  await filmCard.locator("[data-prompt]").click();
  await filmCard.locator("[data-prompt]").pressSequentially("first cut: wide sea");
  await filmCard.locator("[data-prompt]").blur();
  await page.waitForTimeout(300);
  await filmCard.locator("[data-generate]").click();
  const take1 = await settle(filmId);
  note("film take 1", { artifact: take1.artifact, status: take1.status, error: take1.error, sources: take1.sources?.map(s => ({ id: s.id, artifact: s.artifact, copy: s.file })), promptUsed: take1.promptUsed });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, "1-take1.png") });

  // 4. change the upstream material: the text, and the poster too
  const textCardNow = page.locator(`.card[data-id="${textId}"]`);
  await textCardNow.locator("[data-prompt]").click();
  await textCardNow.locator("[data-prompt]").fill("A lighthouse keeper hears a storm in the shell.");
  await textCardNow.locator("[data-prompt]").blur();
  await page.waitForTimeout(400);
  await textCardNow.locator("[data-generate]").click();
  const text2 = await settle(textId);
  note("text take 2", { artifact: text2.artifact, status: text2.status, error: text2.error });

  const posterCardNow = page.locator(`.card[data-id="${posterId}"]`);
  await posterCardNow.locator("[data-prompt]").click();
  await posterCardNow.locator("[data-prompt]").fill("second poster");
  await posterCardNow.locator("[data-prompt]").blur();
  await page.waitForTimeout(400);
  await posterCardNow.locator("[data-generate]").click();
  const poster2 = await settle(posterId);
  note("poster take 2", { artifact: poster2.artifact, status: poster2.status, error: poster2.error });

  // 5. second take of the film with a new instruction
  const filmNow = page.locator(`.card[data-id="${filmId}"]`);
  await filmNow.locator("[data-prompt]").click();
  await filmNow.locator("[data-prompt]").fill("second cut: close on the shell");
  await filmNow.locator("[data-prompt]").blur();
  await page.waitForTimeout(400);
  await filmNow.locator("[data-generate]").click();
  const take2 = await settle(filmId);
  note("film take 2", { artifact: take2.artifact, status: take2.status, error: take2.error, sources: take2.sources?.map(s => ({ id: s.id, artifact: s.artifact, copy: s.file })), versions: take2.versions?.map(v => ({ id: v.id, artifact: v.artifact, copy: v.file, prompt: v.prompt, sources: (v.sources || []).map(s => ({ id: s.id, artifact: s.artifact, copy: s.file })) })), promptUsed: take2.promptUsed });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, "2-take2.png") });

  // 6. compare both takes in the canvas
  await filmNow.locator("[data-compare]").click();
  await page.waitForTimeout(700);
  const panes = await page.locator(".cmp .pane section").evaluateAll(es => es.map(e => ({ caption: e.querySelector(".caption")?.innerText, media: e.querySelector("video,img,pre")?.tagName, side: e.dataset.side })));
  note("compare panes", panes);
  await page.screenshot({ path: join(shots, "3-compare.png") });
  const picks = await page.locator(".cmp [data-pick=right] option").evaluateAll(es => es.map(e => ({ value: e.value, text: e.textContent })));
  note("compare options", picks);
  await page.locator(".cmp [data-close]").click();
  await page.waitForTimeout(200);

  // 7. go back to the first take and keep editing its meaning
  const versions = await page.locator(`.card[data-id="${filmId}"] [data-version]`).evaluateAll(es => es.map(e => ({ v: e.dataset.version, text: e.textContent, title: e.title })));
  note("version buttons", versions);
  await page.locator(`.card[data-id="${filmId}"] [data-version]`).first().click();
  await page.waitForTimeout(700);
  const restored = (await ws()).nodes[filmId];
  note("after restore", { artifact: restored.artifact, promptUsed: restored.promptUsed, prompt: restored.prompt, box: await page.locator(`.card[data-id="${filmId}"] [data-prompt]`).inputValue(), used: await page.locator(`.card[data-id="${filmId}"] .used-slot`).innerText(), versions: restored.versions.map(v => ({ id: v.id, copy: v.file, prompt: v.prompt })) });
  await page.screenshot({ path: join(shots, "4-restored.png") });

  // 8. reopen the page: the history has to survive
  await page.reload();
  await page.waitForSelector(".card");
  const afterReload = (await ws()).nodes[filmId];
  note("after reload", { artifact: afterReload.artifact, promptUsed: afterReload.promptUsed, versions: afterReload.versions.map(v => ({ id: v.id, copy: v.file, prompt: v.prompt })) });
  note("page errors", errors);
  out.workdir = workdir; out.shots = shots; out.serverLog = log.join("").slice(-2000);
} finally {
  writeFileSync(join(shots, "receipt.json"), JSON.stringify(out, null, 2));
  await page?.close();
  await browser.close();
  stopServer(app); stopAll();
  console.log("receipt:", join(shots, "receipt.json"), "shots:", shots);
}
