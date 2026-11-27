// Walk the ordinary-user path on a local fake-Codex server and save a
// screenshot after each step, so a person can see what the canvas looks like.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-journey-")), bin = join(base, "codex");
// Screenshots are evidence, not source: default under the ignored .tmp/ and let the
// caller choose a folder with HYPERMAKER_SHOTS.
const shots = process.env.HYPERMAKER_SHOTS || join(root, ".tmp", "journey");
mkdirSync(shots, { recursive: true });
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(root, "test/fake-codex.mjs"))} "$@"\n`); chmodSync(bin, 0o755);
const port = await freePort();
const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: join(base, "ws"), HYPERMAKER_RESET_WORKSPACE: "1", FAKE_CODEX_DELAY: "2500" } });
await waitReady(port);
const browser = await launchBrowser();
const steps = [];
const note = (name, detail) => steps.push({ step: name, ...detail });
const ws = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
const box = (page, id) => page.locator(`.card[data-id="${id}"]`).boundingBox();

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = []; page.on("pageerror", e => errors.push(e.stack || String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.querySelector("#cards"));
  const shot = async name => page.screenshot({ path: join(shots, `${name}.png`) });

  // 1. Create by double-clicking empty canvas.
  await page.mouse.dblclick(220, 160); await page.waitForTimeout(200);
  const a = (await page.locator(".card").evaluateAll(es => es.map(e => e.dataset.id)))[0];
  await shot("01-created-a");
  note("double-click creates a card", { id: a, cards: await page.locator(".card").count() });

  // 2. Write a prompt and see it persisted.
  await page.locator(`.card[data-id="${a}"] [data-prompt]`).click();
  await page.locator(`.card[data-id="${a}"] [data-prompt]`).pressSequentially("写一段程序员小明的人设", { delay: 40 });
  await page.locator(`.card[data-id="${a}"] [data-prompt]`).fill("make a persona for a programmer named Xiaoming");
  await page.waitForTimeout(500);
  note("typing persists", { prompt: (await ws()).nodes[a].prompt });

  // 3. Second card, placed to overlap the first.
  await page.mouse.dblclick(620, 300); await page.waitForTimeout(200);
  const b = (await page.locator(".card").evaluateAll(es => es.map(e => e.dataset.id))).at(-1);
  // Dragging onto another card's body is free placement, so cards can be stacked
  // on purpose; only dropping on a header links.
  const ab0 = await box(page, a), bb0 = await box(page, b);
  await page.mouse.move(bb0.x + 100, bb0.y + 15); await page.mouse.down();
  await page.mouse.move(ab0.x + 190, ab0.y + 120, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(300);
  await shot("02-overlapping");
  const boxes = { a: await box(page, a), b: await box(page, b) };
  note("second card overlaps the first", boxes);

  // 4. The covered card must be raiseable from its exposed edge, then usable.
  const strip = { x: boxes.a.x + 8, y: boxes.a.y + 12 };
  const before = await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest(".card")?.dataset.id ?? null, strip);
  note("exposed edge belongs to the covered card", { point: strip, card: before });
  await page.mouse.click(strip.x, strip.y); await page.waitForTimeout(250);
  const raised = await page.evaluate(() => [...document.querySelectorAll(".card")].find(c => c.classList.contains("raised"))?.dataset.id ?? null);
  note("clicking the exposed edge raises it", { raised });
  await shot("03-raised");
  await page.locator(`.card[data-id="${a}"] [data-field="quality"]`).click({ timeout: 4000 });
  await page.locator(`.card[data-id="${a}"] [data-field="quality"]`).selectOption("artistic");
  await page.waitForTimeout(400);
  note("the raised card's own controls work", { quality: (await ws()).nodes[a].quality });

  // 5. Drop the raised card somewhere free, then move the mouse with no button.
  const ab = await box(page, a), bb = await box(page, b);
  await page.mouse.move(ab.x + 100, ab.y + 15); await page.mouse.down();
  await page.mouse.move(ab.x + 40, bb.y + 400, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(400);
  const dropped = await box(page, a);
  await page.mouse.move(1000, 700); await page.mouse.move(300, 300); await page.waitForTimeout(300);
  const afterHover = await box(page, a);
  note("a dragged card stops where it was dropped", { dropped: { x: dropped.x, y: dropped.y }, afterHover: { x: afterHover.x, y: afterHover.y }, follows: afterHover.x !== dropped.x || afterHover.y !== dropped.y });
  await shot("04-moved");

  // 6. Drag one card onto the other to link, then right-click the link.
  const sb = await box(page, a), tb = await box(page, b);
  await page.mouse.move(sb.x + 100, sb.y + 15); await page.mouse.down();
  await page.mouse.move(tb.x + 100, tb.y + 15, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(500);
  note("drag onto another card links them", { edges: await page.locator(".edge").count(), inputs: (await ws()).nodes[b].inputs, sourceBack: { x: (await box(page, a)).x, y: (await box(page, a)).y }, sourceWas: { x: sb.x, y: sb.y } });
  await shot("05-linked");
  const mid = await page.evaluate(() => {
    const h = document.querySelector(".edge-hit"); if (!h) return null;
    const ctm = h.getScreenCTM(), p = h.getPointAtLength(h.getTotalLength() / 2);
    return { x: p.x * ctm.a + ctm.e, y: p.y * ctm.d + ctm.f };
  });
  if (!mid) throw new Error("no link was drawn to right-click");
  await page.mouse.click(mid.x, mid.y, { button: "right" }); await page.waitForTimeout(500);
  note("right-click removes the link", { edges: await page.locator(".edge").count(), inputs: (await ws()).nodes[b].inputs });
  await shot("06-unlinked");

  // 7. Generate on the source card, watch the preview appear.
  await page.locator(`.card[data-id="${a}"] [data-generate]`).click();
  for (let i = 0; i < 60; i++) { const n = (await ws()).nodes[a]; if (n?.artifact) break; await new Promise(r => setTimeout(r, 100)); }
  await page.waitForFunction(id => !document.querySelector(`.card[data-id="${id}"] .preview pre`)?.textContent.includes("loading"), a, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  note("Generate produces an artifact and a preview", { artifact: (await ws()).nodes[a].artifact, preview: (await page.locator(`.card[data-id="${a}"] .preview`).textContent()).slice(0, 60) });
  await shot("07-generated");

  // 7b. A run a person starts and stops. FAKE_CODEX_DELAY keeps this agent busy
  // long enough for Stop to be a real target; the card must say what happened
  // and must not lose the artifact it already had.
  const beforeStop = (await ws()).nodes[a].artifact;
  await page.locator(`.card[data-id="${a}"] [data-generate]`).click();
  await page.waitForFunction(() => { const b = document.querySelector("[data-cancel]"); return b && !b.hidden; }, null, { timeout: 5000 });
  const stopShown = await page.locator(`.card[data-id="${a}"] [data-cancel]`).isVisible();
  await page.locator(`.card[data-id="${a}"] [data-cancel]`).click({ timeout: 5000 });
  await page.waitForFunction(async id => { const r = await (await fetch("/api/workspace")).json(); return r.nodes[id]?.status !== "running"; }, a, { timeout: 6000 });
  const afterStop = (await ws()).nodes[a];
  note("Stop ends a run and says so", { stopShown, status: afterStop.status, error: afterStop.error, artifact: afterStop.artifact, keptEarlierArtifact: !!beforeStop && afterStop.artifact === beforeStop });
  await shot("07b-stopped");
  // A stopped card can run again, so the journey ends on a real artifact.
  await page.waitForFunction(id => { const b = document.querySelector(`.card[data-id="${id}"] [data-generate]`); return b && !b.disabled; }, a, { timeout: 5000 }).catch(() => {});
  await page.locator(`.card[data-id="${a}"] [data-generate]`).click();
  for (let i = 0; i < 80; i++) { const n = (await ws()).nodes[a]; if (n?.status === "idle" && n?.artifact) break; await new Promise(r => setTimeout(r, 100)); }
  note("the stopped card can be generated again", { status: (await ws()).nodes[a].status, artifact: (await ws()).nodes[a].artifact });

  // 8. Reopen in a new window: cards, prompt, artifact and link state survive.
  const reopened = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const reopenedErrors = []; reopened.on("pageerror", e => reopenedErrors.push(e.stack || String(e)));
  await reopened.goto(`http://127.0.0.1:${port}/`);
  await reopened.waitForSelector(".card"); await reopened.waitForTimeout(400);
  await reopened.screenshot({ path: join(shots, "08-reopened.png") });
  note("reopening restores the canvas", { cards: await reopened.locator(".card").count(), prompts: await reopened.locator("[data-prompt]").evaluateAll(es => es.map(e => e.value)), preview: (await reopened.locator(`.card[data-id="${a}"] .preview`).textContent()).slice(0, 40) });

  // 9. Delete asks first; dismissing keeps the card, accepting removes it.
  const asked = []; reopened.on("dialog", d => { asked.push(d.message()); d.dismiss(); });
  await reopened.locator(`.card[data-id="${b}"] [data-delete]`).click(); await reopened.waitForTimeout(300);
  note("Delete asks before removing", { asked, cards: await reopened.locator(".card").count() });
  reopened.removeAllListeners("dialog"); reopened.on("dialog", d => d.accept());
  await reopened.locator(`.card[data-id="${b}"] [data-delete]`).click(); await reopened.waitForTimeout(400);
  note("Delete removes only the chosen card", { cards: await reopened.locator(".card").count(), remaining: Object.keys((await ws()).nodes) });
  await reopened.screenshot({ path: join(shots, "09-deleted.png") });
  note("browser errors", { errors, reopenedErrors });
  await reopened.close(); await page.close();
} finally {
  console.log(JSON.stringify({ steps, shots }, null, 1));
  await browser.close(); stopServer(app); stopAll();
}
