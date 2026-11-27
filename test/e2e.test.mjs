import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { browserPath, launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

// Without a Chromium every canvas test would fail eight times with the same
// Playwright banner. Skip them with one readable reason instead; the unit and
// canvas-script tests still run.
const missingBrowser = existsSync(browserPath()) ? null
  : `no Chromium at ${browserPath()}: run \`npx playwright install chromium\` or set HYPERMAKER_CHROME`;
const canvasTest = (name, fn) => test(name, missingBrowser ? { skip: missingBrowser } : {}, fn);

const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-e2e-")), bin = join(base, "codex");
let port;
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(root, "test/fake-codex.mjs"))} "$@"\n`); chmodSync(bin, 0o755);
let app, browser;

before(async () => {
  // When every test in this file is skipped there is nothing to launch; spinning
  // up a browser anyway printed a full error banner next to the one skip reason.
  if (missingBrowser) return;
  port = await freePort();
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: join(base, "workspace"), HYPERMAKER_RESET_WORKSPACE: "1" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); stopServer(app); stopAll(); });

const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const workspace = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
const waitForNode = async id => { for (let i = 0; i < 60; i++) { const node = (await workspace()).nodes[id]; if (node?.artifact || node?.error) return node; await new Promise(r => setTimeout(r, 100)); } return (await workspace()).nodes[id]; };
// Each test gets an empty canvas, so nothing leaks between tests.
async function blankPage(viewport = { width: 1100, height: 700 }) {
  const dir = mkdtempSync(join(base, "ws-"));
  await post("/api/workspace", { workdir: dir });
  const page = await browser.newPage({ viewport });
  // Collect page errors and assert them per test: throwing from a listener fires
  // after the test has ended and is reported as an uncaught exception instead.
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack || String(error)));
  page.catchErrors = () => assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  const close = page.close.bind(page);
  page.close = async (...args) => { page.catchErrors(); await close(...args); };
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.querySelector("#cards"));
  return page;
}
const frontMost = page => page.evaluate(() => [...document.querySelectorAll(".card")].find(c => c.classList.contains("raised"))?.dataset.id ?? [...document.querySelectorAll(".card")].at(-1)?.dataset.id ?? null);
const edgeEnds = page => page.evaluate(() => [...document.querySelectorAll(".edge")].map(path => {
  const ctm = path.getScreenCTM(), at = length => { const p = path.getPointAtLength(length); return { x: p.x * ctm.a + ctm.e, y: p.y * ctm.d + ctm.f }; };
  return { start: at(0), end: at(path.getTotalLength()) };
}));
const cardBox = async (page, id) => page.locator(`.card[data-id="${id}"]`).boundingBox();

canvasTest("double-click creates a card, typing persists, and Generate produces an artifact", async () => {
  const page = await blankPage({ width: 1100, height: 700 });
  await page.mouse.dblclick(150, 150); await page.waitForTimeout(150);
  assert.equal(await page.locator(".card").count(), 1);
  const card = page.locator(".card").first();
  await card.locator("[data-prompt]").click();
  await card.locator("[data-prompt]").pressSequentially("make a persona");
  await card.locator("[data-prompt]").blur();
  const id = await card.getAttribute("data-id");
  assert.equal((await workspace()).nodes[id].prompt, "make a persona");
  await card.locator("[data-generate]").click();
  const node = await waitForNode(id);
  assert.equal(node.artifact, "xiaoming_persona.txt", JSON.stringify(node));
  await page.waitForFunction(() => !document.querySelector(".preview pre")?.textContent.includes("loading"), null, { timeout: 5000 });
  assert.match(await page.locator(".preview pre").textContent(), /程序员小明/);
  await page.close();
});

canvasTest("drag links two cards and right-click removes the link", async () => {
  const page = await blankPage();
  await page.mouse.dblclick(120, 120); await page.waitForTimeout(150);
  await page.mouse.dblclick(620, 120); await page.waitForTimeout(150);
  const [a, b] = await page.locator(".card").evaluateAll(es => es.map(e => e.dataset.id));
  const boxA = await cardBox(page, a), boxB = await cardBox(page, b);
  await page.mouse.move(boxA.x + 100, boxA.y + 15); await page.mouse.down();
  await page.mouse.move(boxB.x + 100, boxB.y + 15, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(200);
  assert.equal(await page.locator(".edge").count(), 1);
  assert.deepEqual((await workspace()).nodes[b].inputs, [+a]);
  assert.deepEqual(await cardBox(page, a), { ...boxA }, "source card returns to where it started");
  const mid = await page.evaluate(() => { const r = document.querySelector(".edge-hit").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(mid.x, mid.y, { button: "right" });
  await page.waitForFunction(() => document.querySelectorAll(".edge").length === 0, null, { timeout: 4000 });
  assert.equal(await page.locator(".edge").count(), 0);
  assert.deepEqual((await workspace()).nodes[b].inputs, []);
  await page.close();
});

canvasTest("link lines stay attached to their cards through pan, zoom and drag", async () => {
  const page = await blankPage({ width: 1100, height: 700 });
  const created = (await post("/api/node", { x: 100, y: 100, type: "text", method: "llm" })).nodes;
  const source = Object.keys(created).at(-1);
  await post("/api/node", { x: 560, y: 330, type: "text", method: "llm" });
  const target = Object.keys((await workspace()).nodes).at(-1);
  await post("/api/link", { source, target });
  await page.reload(); await page.waitForSelector(".edge", { state: "attached" });
  const check = async label => {
    const ends = await edgeEnds(page), box = await cardBox(page, source), dst = await cardBox(page, target);
    assert.equal(ends.length, 1, `${label}: one link, got ${ends.length}`);
    assert.ok(Math.abs(ends[0].start.x - (box.x + box.width)) < 3, `${label}: line starts at source right edge (${ends[0].start.x} vs ${box.x + box.width})`);
    assert.ok(Math.abs(ends[0].start.y - (box.y + 15)) < 3, `${label}: line starts at source header (${ends[0].start.y} vs ${box.y + 15})`);
    assert.ok(Math.abs(ends[0].end.x - dst.x) < 3, `${label}: line ends at target left edge`);
  };
  await check("at rest");
  // Pan by dragging empty canvas, then verify the line moved with the cards.
  const before = await cardBox(page, source);
  await page.mouse.move(300, 620); await page.mouse.down(); await page.mouse.move(520, 660, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(150);
  const after = await cardBox(page, source);
  assert.ok(Math.abs(after.x - before.x - 220) < 3, `pan moved the card ${after.x - before.x}`);
  await check("after pan");
  // Zoom keeps the line on the cards as well.
  await page.mouse.move(700, 500); await page.mouse.wheel(0, -200); await page.waitForTimeout(200);
  await check("after zoom");
  // Dragging a card keeps the link starting at its new edge.
  const box = await cardBox(page, source);
  await page.mouse.move(box.x + 100, box.y + 15); await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 200, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(200);
  assert.deepEqual((await workspace()).nodes[target].inputs, [+source]);
  await check("after drag");
  await page.close();
});

canvasTest("clicking the exposed edge of a covered card raises it, and its controls then work", async () => {
  const page = await blankPage({ width: 1100, height: 700 });
  const first = Object.keys((await post("/api/node", { x: 40, y: 40, type: "text", method: "llm", prompt: "card one" })).nodes)[0];
  const created = await post("/api/node", { x: 220, y: 60, type: "text", method: "llm", prompt: "card two" });
  const second = Object.keys(created.nodes).at(-1);
  await page.reload(); await page.waitForSelector(".card");
  assert.equal(await frontMost(page), second, "later card starts in front");
  const boxFirst = await cardBox(page, first);
  const strip = { x: boxFirst.x + 8, y: boxFirst.y + 12 };
  const covering = await cardBox(page, second);
  assert.ok(strip.x < covering.x, `probe point ${strip.x} must be left of the front card ${covering.x}`);
  assert.equal(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest(".card")?.dataset.id ?? null, strip), first);
  await page.mouse.click(strip.x, strip.y); await page.waitForTimeout(200);
  assert.equal(await frontMost(page), first, "clicking the exposed strip brings the covered card forward");
  assert.notEqual(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest(".card")?.dataset.id ?? null, strip), second);
  // Real clicks, no forced dispatch: the now-raised card's own controls accept input.
  await page.locator(`.card[data-id="${first}"] [data-field="quality"]`).click({ timeout: 4000 });
  await page.locator(`.card[data-id="${first}"] [data-field="quality"]`).selectOption("sketch");
  await page.waitForFunction(async id => { const ws = await (await fetch('/api/workspace')).json(); return ws.nodes[id]?.quality === 'sketch' }, first, { timeout: 4000 });
  assert.equal((await workspace()).nodes[first].quality, "sketch");
  // Changing type goes through methods() first; that path once handed a promise
  // to safe(fn) and threw "fn is not a function" on every select change.
  await page.locator(`.card[data-id="${first}"] [data-field="type"]`).selectOption("image");
  await page.waitForFunction(async id => { const ws = await (await fetch('/api/workspace')).json(); return ws.nodes[id]?.type === 'image' }, first, { timeout: 4000 });
  assert.equal((await workspace()).nodes[first].type, "image");
  assert.equal(await page.locator(`.card[data-id="${first}"] [data-field="method"] option`).count() > 0, true, "method list reloads for the new type");
  page.catchErrors();
  await page.locator(`.card[data-id="${first}"] [data-prompt]`).click();
  await page.locator(`.card[data-id="${first}"] [data-prompt]`).fill("edited after raising");
  await page.waitForFunction(async id => { const ws = await (await fetch('/api/workspace')).json(); return ws.nodes[id]?.prompt === 'edited after raising' }, first, { timeout: 4000 });
  // Leaving the field and reopening must show the edited text, not the old prompt.
  await page.locator(`.card[data-id="${first}"] [data-field="quality"]`).focus();
  await page.reload(); await page.waitForSelector(".card"); await page.waitForTimeout(200);
  assert.equal(await page.locator(`.card[data-id="${first}"] [data-prompt]`).inputValue(), "edited after raising");
  const reopenedFirst = await cardBox(page, first);
  await page.mouse.click(reopenedFirst.x + 8, reopenedFirst.y + 12); await page.waitForTimeout(200);
  assert.equal(await frontMost(page), first, "after reopening, the covered card can still be raised");
  // Deleting the raised card asks first, and never deletes the card that was in front.
  const dialogs = []; page.on("dialog", d => { dialogs.push(d.message()); d.dismiss(); });
  await page.locator(`.card[data-id="${first}"] [data-delete]`).click({ timeout: 4000 }); await page.waitForTimeout(200);
  assert.deepEqual(dialogs, ["Delete this node?"]);
  assert.equal(await page.locator(".card").count(), 2);
  page.removeAllListeners("dialog"); page.on("dialog", d => d.accept());
  await page.locator(`.card[data-id="${first}"] [data-delete]`).click({ timeout: 4000 }); await page.waitForTimeout(300);
  assert.equal(await page.locator(".card").count(), 1);
  const left = (await workspace()).nodes;
  assert.deepEqual(Object.keys(left).map(Number), [+second]);
  assert.equal(left[second].prompt, "card two", "the previously front card is untouched");
  assert.equal(await frontMost(page), second);
  await page.close();
});

canvasTest("a link passing behind a card never steals that card's own controls, and stays removable", async () => {
  const page = await blankPage({ width: 1000, height: 620 });
  // Two cards, linked left to right, with the fronts deliberately in line with the link.
  const a = Object.keys((await post("/api/node", { x: 60, y: 200, type: "text", method: "llm", prompt: "left" })).nodes)[0];
  const created = await post("/api/node", { x: 760, y: 200, type: "text", method: "llm", prompt: "right" });
  const b = Object.keys(created.nodes).at(-1);
  await post("/api/link", { source: a, target: b });
  await page.reload(); await page.waitForSelector(".edge", { state: "attached" }); await page.waitForTimeout(200);
  // Park a third card on top of the link, so the link runs behind a card body.
  // The cover card sits on the middle of the link, in the gap between the two cards,
  // so a visible segment remains on either side.
  const cover = Object.keys((await post("/api/node", { x: 400, y: 170, type: "text", method: "llm", prompt: "cover" })).nodes).at(-1);
  await page.reload(); await page.waitForSelector(".card"); await page.waitForTimeout(200);
  const coverBox = await cardBox(page, cover);
  const overLink = await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest(".card")?.dataset.id ?? null, { x: coverBox.x + 120, y: coverBox.y + 8 });
  assert.equal(overLink, String(cover), "the card body is what the pointer sees, not the link");

  // 1. The visible link segment is a real mouse target.
  const mid = await page.evaluate(() => {
    const h = document.querySelector(".edge-hit"); if (!h) return null;
    const ctm = h.getScreenCTM(), p = h.getPointAtLength(h.getTotalLength() / 2);
    const point = { x: p.x * ctm.a + ctm.e, y: p.y * ctm.d + ctm.f };
    const card = document.elementFromPoint(point.x, point.y)?.closest(".card");
    // Walk along the curve until a point is not under a card.
    for (let t = 0.1; t <= 0.9; t += 0.02) {
      const q = h.getPointAtLength(h.getTotalLength() * t);
      const x = q.x * ctm.a + ctm.e, y = q.y * ctm.d + ctm.f;
      if (document.elementFromPoint(x, y) === h) return { x, y, under: false };
    }
    return { x: point.x, y: point.y, under: !!card };
  });
  assert.ok(mid, "a hit path exists for the link");
  assert.equal(mid.under, false, `the sampled point ${mid.x},${mid.y} is on the visible part of the link`);

  // 2. Right-clicking a card's own controls must never unlink anything, and must
  //    keep working while the link runs behind that card.
  const beforeInputs = (await workspace()).nodes[b].inputs;
  await page.locator(`.card[data-id="${cover}"] [data-prompt]`).click({ button: "right" }); await page.waitForTimeout(150);
  assert.deepEqual((await workspace()).nodes[b].inputs, beforeInputs, "right-clicking a prompt leaves the link alone");
  await page.locator(`.card[data-id="${cover}"] [data-generate]`).click({ button: "right" }); await page.waitForTimeout(150);
  assert.deepEqual((await workspace()).nodes[b].inputs, beforeInputs, "right-clicking Generate leaves the link alone");

  // 3. Removing the link works on the visible segment with a real right-click.
  await page.mouse.click(mid.x, mid.y, { button: "right" });
  await page.waitForFunction(() => document.querySelectorAll(".edge").length === 0, null, { timeout: 4000 });
  assert.deepEqual((await workspace()).nodes[b].inputs, []);

  // 4. A link fully hidden behind a card body is still removable, without the
  //    card's controls losing their own clicks.
  await post("/api/link", { source: a, target: b });
  // Pull the target card over the source so the whole link runs beneath card bodies.
  await post("/api/node", { id: b, x: 200 });
  await page.reload(); await page.waitForSelector(".card"); await page.waitForTimeout(200);
  const hidden = await page.evaluate(() => {
    const h = document.querySelector(".edge-hit"), ctm = h.getScreenCTM(), len = h.getTotalLength();
    const control = e => !!e?.closest("button,select,textarea,input,pre,a");
    for (let t = 0.1; t <= 0.9; t += 0.02) {
      const q = h.getPointAtLength(len * t), x = q.x * ctm.a + ctm.e, y = q.y * ctm.d + ctm.f;
      const top = document.elementFromPoint(x, y);
      // Hidden by plain card surface: the person still sees where it goes.
      if (top?.closest(".card") && !control(top)) return { x, y, card: top.closest(".card").dataset.id };
    }
    return null;
  });
  assert.ok(hidden, "the link does pass behind plain card surface");
  await page.mouse.click(hidden.x, hidden.y, { button: "right" });
  await page.waitForFunction(() => document.querySelectorAll(".edge").length === 0, null, { timeout: 4000 });
  assert.deepEqual((await workspace()).nodes[b].inputs, [], "a covered link is still removable");
  // And the covering card's controls still belong to that card afterwards.
  await page.locator(`.card[data-id="${hidden.card}"] [data-prompt]`).fill("still mine");
  await page.waitForTimeout(400);
  assert.equal((await workspace()).nodes[hidden.card].prompt, "still mine");
  await page.close();
});

canvasTest("a card covered by another can still be generated after being raised", async () => {
  const page = await blankPage({ width: 900, height: 600 });
  const first = Object.keys((await post("/api/node", { x: 40, y: 90, type: "text", method: "llm", prompt: "underneath" })).nodes)[0];
  await post("/api/node", { x: 150, y: 60, type: "text", method: "llm", prompt: "on top" });
  await page.reload(); await page.waitForSelector(".card");
  const box = await cardBox(page, first);
  await page.mouse.click(box.x + 8, box.y + 12); await page.waitForTimeout(200);
  assert.equal(await frontMost(page), first);
  await page.locator(`.card[data-id="${first}"] [data-generate]`).click({ timeout: 5000 });
  const node = await waitForNode(first);
  assert.equal(node.artifact, "xiaoming_persona.txt", JSON.stringify(node));
  assert.equal(node.prompt, "underneath");
  await page.close();
});

canvasTest("drag keeps tracking after the pointer leaves the header, and Delete asks confirmation", async () => {
  const page = await blankPage({ width: 900, height: 600 });
  await page.mouse.dblclick(120, 120); await page.waitForTimeout(150);
  const card = page.locator(".card").first(), box = await card.boundingBox();
  await page.mouse.move(box.x + 100, box.y + 15); await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 180, { steps: 4 });
  await page.mouse.move(box.x + 300, box.y + 220, { steps: 4 });
  await page.mouse.up(); await page.waitForTimeout(200);
  const moved = await page.locator(".card").first().boundingBox();
  assert.ok(moved && moved.y > box.y + 100, `card moved from ${box.y} to ${moved?.y}`);
  // A click without a drag raises but must not move the card, and the drag must
  // release on pointerup: a live drag used to follow the pointer forever.
  await page.locator(".card header .title").click(); await page.waitForTimeout(200);
  const clicked = await page.locator(".card").first().boundingBox();
  assert.deepEqual({ x: clicked.x, y: clicked.y }, { x: moved.x, y: moved.y }, "a click without a drag leaves the card alone");
  await page.mouse.move(200, 200); await page.mouse.move(700, 500, { steps: 4 }); await page.waitForTimeout(200);
  assert.deepEqual({ x: (await page.locator(".card").first().boundingBox()).x, y: (await page.locator(".card").first().boundingBox()).y }, { x: clicked.x, y: clicked.y }, "the card stops following the pointer after the drop");
  const stored = (await workspace()).nodes[await card.getAttribute("data-id")];
  const offset = await page.evaluate(() => document.querySelector("#viewport").getBoundingClientRect().top);
  assert.ok(Math.abs(stored.y - (moved.y - offset)) < 4, `stored world y ${stored.y} matches the card on screen ${moved.y} minus viewport ${offset}`);
  const dialogs = []; page.on("dialog", d => { dialogs.push(d.message()); d.dismiss(); });
  await page.locator("[data-delete]").click();
  assert.deepEqual(dialogs, ["Delete this node?"]);
  assert.equal(await page.locator(".card").count(), 1, "dismissing the question keeps the card");
  page.removeAllListeners("dialog"); page.on("dialog", d => d.accept());
  await page.locator("[data-delete]").click(); await page.waitForTimeout(200);
  assert.equal(await page.locator(".card").count(), 0);
  await page.close();
});

canvasTest("reopening the page restores cards, links and generated previews", async () => {
  const page = await blankPage();
  await page.mouse.dblclick(120, 120); await page.waitForTimeout(150);
  await page.mouse.dblclick(620, 120); await page.waitForTimeout(150);
  const [a, b] = await page.locator(".card").evaluateAll(es => es.map(e => e.dataset.id));
  await page.locator(`.card[data-id="${a}"] [data-prompt]`).fill("left card");
  await page.locator(`.card[data-id="${b}"] [data-prompt]`).fill("right card");
  const boxA = await cardBox(page, a), boxB = await cardBox(page, b);
  await page.mouse.move(boxA.x + 100, boxA.y + 15); await page.mouse.down();
  await page.mouse.move(boxB.x + 100, boxB.y + 15, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(200);
  await page.locator(`.card[data-id="${a}"] [data-generate]`).click();
  assert.equal((await waitForNode(a)).artifact, "xiaoming_persona.txt");
  const reopened = await browser.newPage();
  const reopenedErrors = []; reopened.on("pageerror", error => reopenedErrors.push(String(error)));
  await reopened.goto(`http://127.0.0.1:${port}/`);
  await reopened.waitForSelector(".card"); await reopened.waitForTimeout(300);
  assert.equal(await reopened.locator(".card").count(), 2);
  assert.equal(await reopened.locator(".edge").count(), 1);
  assert.deepEqual(await reopened.locator("[data-prompt]").evaluateAll(es => es.map(e => e.value)), ["left card", "right card"]);
  assert.match(await reopened.locator(`.card[data-id="${a}"] .preview pre`).textContent(), /程序员小明/);
  assert.deepEqual(reopenedErrors, [], `no page errors on the reopened page, got ${reopenedErrors.join(" | ")}`);
  await reopened.close(); await page.close();
});
