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
// The canvas now starts a text card on `plain`, which writes the person's own words. These tests
// are about the agent path - the prompt, the spawn, the artifact contract - so they say so instead
// of relying on a default that changed under them, and the default itself is pinned in
// `test/first-cut.test.mjs`.
async function useAgent(page, id) {
  await page.locator(`.card[data-id="${id}"] [data-field=method]`).selectOption("llm");
  await page.waitForFunction(cardId => document.querySelector(`.card[data-id="${cardId}"] [data-field=method]`)?.value === "llm", id);
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
  await useAgent(page, id);
  await card.locator("[data-generate]").click();
  const node = await waitForNode(id);
  assert.match(node.artifact, /xiaoming_persona\.txt$/, JSON.stringify(node));
  await page.waitForFunction(() => !document.querySelector(".preview pre")?.textContent.includes("loading"), null, { timeout: 5000 });
  assert.match(await page.locator(".preview pre").textContent(), /程序员小明/);
  await page.close();
});

canvasTest("the link under the pointer and the link nearest to it can differ, and the nearest one is what a right-click removes", async () => {
  // A supervisor reported this twice from a real two-scene film, and the second report is why this
  // test is shaped as it is.
  //
  //   1. Four links left the film card's edge at the same point and drew as one line, so a
  //      right-click on "the line" removed whichever link happened to be on top. Fanning the anchors
  //      along the edge makes them separate lines.
  //   2. Even with the lines apart, right-clicking nearer picture #4's line unlinked text card #1 -
  //      measured at (1327,164) on their canvas. Two causes: the pick was paint order rather than
  //      distance, and every hit path carried its own `oncontextmenu`, so the path under the pointer
  //      answered before a smarter rule ran.
  //
  // Testing this honestly turned out to be most of the work, and two earlier versions of this test
  // were wrong in a way worth recording:
  //   * clicking exactly *on* a line proves nothing - measured on that layout, at every curve's
  //     midpoint the topmost stroke is the right one, so a paint-order bug passes;
  //   * scanning along a line can never disagree, because the line's distance to itself is zero, so
  //     that search found nothing and the test failed on its own precondition rather than on the
  //     product.
  // What does distinguish the rules is a point where one stroke is under the pointer and a different
  // curve is nearer - which needs a screen area free of cards, so the links spread out instead of
  // being packed into three short parallel runs. Hence sources in a column, one target far right.
  // The point is found by measurement and its disagreement asserted before the click, and with the
  // per-path handler restored this test fails - the only reason to believe it tests anything.
  const page = await blankPage({ width: 1400, height: 1000 });
  for (const y of [100, 380, 660]) await post("/api/node", { x: 20, y, type: "text" });
  const sources = Object.keys((await workspace()).nodes).map(Number);
  await post("/api/node", { x: 900, y: 380, type: "video" });
  const target = Math.max(...Object.keys((await workspace()).nodes).map(Number));
  for (const source of sources) await post("/api/link", { source, target });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".edge").length === 3);

  // The fan: each link leaves its own point on the source's edge, far enough apart to aim at.
  const starts = await edgeEnds(page);
  assert.equal(new Set(starts.map(s => Math.round(s.start.y))).size, 3, `each link leaves from its own point, got ${JSON.stringify(starts.map(s => Math.round(s.start.y)))}`);

  // Find a point where the two rules name different links, by scanning the card-free band.
  const found = await page.evaluate(() => {
    const paths = [...document.querySelectorAll(".edge-hit")].map(p => {
      const ctm = p.getScreenCTM(), total = p.getTotalLength();
      const samples = Array.from({ length: 801 }, (_, i) => { const q = p.getPointAtLength(total * i / 800); return { x: q.x * ctm.a + ctm.e, y: q.y * ctm.d + ctm.f }; });
      return { source: Number(p.dataset.source), samples };
    });
    const nearestAt = (x, y) => paths.map(s => ({ source: s.source, d: Math.min(...s.samples.map(q => Math.hypot(q.x - x, q.y - y))) })).sort((a, b) => a.d - b.d);
    let scanned = 0, withHit = 0;
    for (let x = 300; x <= 890; x += 3) {
      for (let y = 100; y <= 700; y += 2) {
        scanned++;
        const hits = [...document.elementsFromPoint(x, y)].map(e => e.closest && e.closest('.edge-hit')).filter(Boolean).map(h => Number(h.dataset.source));
        if (!hits.length) continue;
        withHit++;
        const nearest = nearestAt(x, y)[0];
        if (hits[0] !== nearest.source && nearest.d <= 10) return { x, y, topmost: hits[0], nearest: nearest.source, d: nearest.d, hits, scanned, withHit };
      }
    }
    return { scanned, withHit, none: true };
  });
  assert.ok(!found.none, `the layout must contain a point where the stroke under the pointer and the nearest curve disagree, or this test proves nothing; scanned ${found.scanned} points, ${found.withHit} of them on a stroke`);

  const before = [...(await workspace()).nodes[target].inputs];
  assert.equal(before.length, 3);
  // A real right-click, the way the supervisor made it - not a call to the selection function. The
  // broken layer was the event wiring, so a test of the picker alone would pass with the bug standing.
  await page.mouse.click(found.x, found.y, { button: "right" });
  await page.waitForTimeout(400);
  const after = [...(await workspace()).nodes[target].inputs];
  assert.deepEqual(after, before.filter(id => id !== found.nearest),
    `at (${found.x},${found.y}) the nearest link is #${found.nearest} (${found.d.toFixed(2)}px) and the strokes under the pointer start with #${found.topmost}; the nearest must go. Inputs were ${JSON.stringify(before)}, are ${JSON.stringify(after)}`);
  // What went is said on the canvas, so nobody has to infer it from the line count.
  const said = await page.locator("#canvas-note").innerText();
  assert.match(said, new RegExp(`#${found.nearest}\\b`), `the canvas says which link went: ${said}`);

  // The remaining links are still individually removable at their own midpoints - the ordinary case
  // has to keep working, not just the awkward one.
  for (const victim of after) {
    const aim = await page.evaluate(s => {
      const path = [...document.querySelectorAll(".edge-hit")].find(p => Number(p.dataset.source) === s);
      const ctm = path.getScreenCTM();
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      return { x: point.x * ctm.a + ctm.e, y: point.y * ctm.d + ctm.f };
    }, victim);
    await page.mouse.click(aim.x, aim.y, { button: "right" });
    await page.waitForTimeout(300);
  }
  assert.deepEqual((await workspace()).nodes[target].inputs, [], "every link was removable by right-clicking its own line");
  await page.close();
});

canvasTest("two links out of one card to cards at the same height do not share a line, and a right-click removes the one aimed at", async () => {
  // The supervisor's third report, and the commonest canvas there is: one text card feeding both a
  // narration and a film, three cards at one height. Both links left the text card at the same point
  // and ran on top of each other for their first stretch, so a right-click at (325,160) removed the
  // narration without saying which link it meant.
  //
  // The earlier fix fanned a card's *incoming* links, which handled four sources into one film and
  // left this shape untouched: the two links here share a source, not a target. A link's offset is
  // now decided against both ends, so no two links can share an anchor at either.
  //
  // Asserted the way the person measures it - on the drawing and on what a right-click does - with
  // the aimed-at link taken from geometry, so it holds whichever end carries the wider spread.
  const page = await blankPage({ width: 1200, height: 700 });
  await post("/api/node", { x: 40, y: 120, type: "text" });
  const [text] = Object.keys((await workspace()).nodes).map(Number);
  await post("/api/node", { x: 420, y: 120, type: "audio" });
  const audio = Math.max(...Object.keys((await workspace()).nodes).map(Number));
  await post("/api/node", { x: 820, y: 120, type: "video" });
  const film = Math.max(...Object.keys((await workspace()).nodes).map(Number));
  await post("/api/link", { source: text, target: audio });
  await post("/api/link", { source: text, target: film });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".edge").length === 2);

  // The two links leave different points on the text card's edge.
  const ends = await page.evaluate(() => [...document.querySelectorAll(".edge")].map(path => {
    const ctm = path.getScreenCTM();
    const at = length => { const p = path.getPointAtLength(length); return { x: p.x * ctm.a + ctm.e, y: p.y * ctm.d + ctm.f }; };
    return { start: at(0), end: at(path.getTotalLength()) };
  }));
  const startYs = ends.map(e => e.start.y).sort((a, b) => a - b);
  assert.ok(startYs[1] - startYs[0] >= 6, `the two links must leave the text card at different points, got ${JSON.stringify(startYs)}`);

  // Aim at each link's own quarter-length point and require that link - and only it - to go. The
  // quarter is used rather than the middle because the near stretch is where they used to overlap.
  const sources = { [audio]: "audio", [film]: "video" };
  const said = [];
  for (const [target, kind] of Object.entries(sources)) {
    const point = await page.evaluate(t => {
      const paths = [...document.querySelectorAll(".edge-hit")].map(p => {
        const ctm = p.getScreenCTM(), total = p.getTotalLength();
        const samples = Array.from({ length: 401 }, (_, i) => { const q = p.getPointAtLength(total * i / 400); return { x: q.x * ctm.a + ctm.e, y: q.y * ctm.d + ctm.f }; });
        return { target: Number(p.dataset.target), samples };
      });
      const mine = paths.find(p => p.target === t);
      const at = mine.samples[100];
      const nearest = paths.map(p => ({ target: p.target, d: Math.min(...p.samples.map(q => Math.hypot(q.x - at.x, q.y - at.y))) })).sort((a, b) => a.d - b.d)[0];
      return { x: at.x, y: at.y, nearest: nearest.target, distance: nearest.d };
    }, Number(target));
    assert.equal(point.nearest, Number(target), `the point aimed at on the ${kind} link must be nearest that link, not #${point.nearest}`);
    const before = (await workspace()).nodes[target].inputs;
    assert.ok(before.includes(text));
    await page.mouse.click(point.x, point.y, { button: "right" });
    await page.waitForTimeout(350);
    const after = (await workspace()).nodes[target].inputs;
    assert.deepEqual(after, [], `right-clicking the ${kind} link at (${Math.round(point.x)},${Math.round(point.y)}) removes that link, got ${JSON.stringify(after)}`);
    const line = await page.locator("#canvas-note").innerText();
    // BOTH ends are named. A supervisor removed these two links and got two identical notes - "card
    // #1" both times - so the receipt could not tell the narration's link from the film's even
    // though the clicks had. A sentence that is the same for two different actions is not a receipt.
    assert.match(line, new RegExp(`#${text}\\b`), `the canvas says which link went: ${line}`);
    assert.match(line, new RegExp(`#${target}\\b`), `and names the card it came off, not only the one it came from: ${line}`);
    said.push(line.trim());
  }
  assert.equal(said.length, 2);
  assert.notEqual(said[0], said[1], `two links out of one card must not produce the same sentence: ${JSON.stringify(said)}`);
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
  await useAgent(page, first);
  await page.locator(`.card[data-id="${first}"] [data-generate]`).click({ timeout: 5000 });
  const node = await waitForNode(first);
  assert.match(node.artifact, /xiaoming_persona\.txt$/, JSON.stringify(node));
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
  await useAgent(page, a);
  await page.locator(`.card[data-id="${a}"] [data-generate]`).click();
  assert.match((await waitForNode(a)).artifact, /xiaoming_persona\.txt$/);
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
