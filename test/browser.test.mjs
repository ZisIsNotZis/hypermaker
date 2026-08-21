import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { chromium } from "playwright";

const port = 8917, root = process.cwd(), fakeRoot = mkdtempSync(join(tmpdir(), "hf-browser-"));
const fake = join(fakeRoot, "codex"); writeFileSync(fake, `#!/bin/sh\nnode ${JSON.stringify(join(root, "test/fake-codex.mjs"))}\n`); chmodSync(fake, 0o755);
let app, browser;
function post(path, body) { return new Promise((resolve, reject) => { const r = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } }, res => { let text = ""; res.on("data", x => text += x); res.on("end", () => resolve(JSON.parse(text))); }); r.on("error", reject); r.end(JSON.stringify(body)); }); }
before(async () => { app = spawn("node", ["server/index.mjs"], { cwd: root, env: { ...process.env, PORT: String(port), CODEX_BIN: fake, FAKE_CODEX_DELAY: "180" } }); await new Promise(r => setTimeout(r, 500)); browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); app?.kill(); });

test("browser: create, drag A onto B, scroll controls, generate and show latest trajectory/text", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }); await page.goto(`http://127.0.0.1:${port}/`);
  await page.mouse.dblclick(160, 160); await page.mouse.dblclick(580, 160); await page.waitForTimeout(250);
  const cards = page.locator(".card"); assert.equal(await cards.count(), 2);
  assert.ok((await cards.first().evaluate(el => el.getBoundingClientRect().width)) < 300);
  assert.ok((await cards.first().locator('.preview').evaluate(el => el.getBoundingClientRect().height)) > 120);
  const boxA = await cards.nth(0).boundingBox(), boxB = await cards.nth(1).boundingBox();
  await page.mouse.move(boxA.x + 15, boxA.y + 15); await page.mouse.down(); await page.mouse.move(boxB.x + 20, boxB.y + 20, { steps: 10 }); await page.mouse.up(); await page.waitForTimeout(150);
  const linked = await page.evaluate(() => Object.values([...nodes.values()][1].inputs || {})); assert.equal(linked.length, 1); assert.ok(linked[0].startsWith('draft:')); const drafts = await page.evaluate(() => [...nodes.values()].map(n => n.workdir)); assert.ok(drafts.every(path => !existsSync(path)));
  await cards.nth(0).locator("textarea").fill("中文 prompt"); await cards.nth(0).locator("textarea").evaluate(el => el.scrollTop = 20); await page.mouse.wheel(0, 100); assert.equal(await cards.nth(0).locator("textarea").count(), 1);
  await cards.nth(0).getByRole("button", { name: "Generate" }).click({ force: true }); await page.waitForFunction(() => [...document.querySelectorAll('.trajectory')].some(x => x.textContent.trim()), null, { timeout: 10000 });
  const activeCard = page.locator('.card').first(); assert.ok((await activeCard.locator('.trajectory').textContent()).trim()); assert.equal(await activeCard.locator('.preview-error').count(), 0);
  await page.waitForFunction(() => [...document.querySelectorAll('.card')].some(x => x.querySelector('.meta')?.textContent.includes('idle')), null, { timeout: 10000 });
  const cardWithResult = page.locator('.card').filter({ hasText: 'idle' }).first(); assert.equal(await cardWithResult.locator('.trajectory').count(), 0); assert.match(await cardWithResult.locator(".text-preview").textContent(), /程序员小明/); assert.equal(await cardWithResult.locator('iframe').count(), 0);
});

test("browser: arrows stay above cards, cards raise, and unrelated events preserve editor focus", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }); await page.goto(`http://127.0.0.1:${port}/`);
  await page.mouse.dblclick(160, 160); await page.mouse.dblclick(580, 160); await page.waitForTimeout(150);
  const cards = page.locator('.card'), a = cards.nth(0), b = cards.nth(1);
  const aBox = await a.boundingBox(), bBox = await b.boundingBox();
  await page.mouse.move(aBox.x + 15, aBox.y + 15); await page.mouse.down(); await page.mouse.move(bBox.x + 20, bBox.y + 20, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(100);
  assert.equal(await page.locator('.edge').count(), 1); assert.equal(await page.locator('.edge').getAttribute('marker-end'), 'url(#arrow)');
  assert.ok(await page.locator('.edge').evaluate(el => { const s = getComputedStyle(el); return s.stroke !== 'none' && parseFloat(s.strokeWidth) >= 5 && document.querySelector('#arrow').getAttribute('markerUnits') === 'userSpaceOnUse'; }));
  assert.ok(await page.locator('#arrow path').evaluate(el => getComputedStyle(el).fill !== 'none'));
  assert.ok(await page.locator('.edges').evaluate(el => +getComputedStyle(el).zIndex > +getComputedStyle(document.querySelector('.cards')).zIndex));
  await b.evaluate(el => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  assert.equal(await b.evaluate(el => el.parentElement.lastElementChild === el), true);
  const editor = a.locator('textarea'); await editor.fill('keep cursor'); await editor.focus(); await editor.press('End');
  await page.evaluate(() => { const n = [...nodes.values()][1]; n.latest = 'unrelated event'; window.updateCard(n); });
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'prompt');
  assert.equal(await editor.inputValue(), 'keep cursor');
  assert.equal(await editor.evaluate(el => getComputedStyle(el).overflowX), 'hidden');
  await page.evaluate(() => { const n = [...nodes.values()][0]; n.status = 'running'; n.latest = 'latest message'; window.updateCard(n); });
  assert.equal(await page.locator('.trajectory').first().evaluate(el => getComputedStyle(el).overflowWrap), 'anywhere');
  await page.evaluate(() => { const n = [...nodes.values()][0]; n.status = 'error'; n.error = 'generation failed'; window.updateCard(n); });
  assert.equal(await a.locator('.preview-error').count(), 1); assert.match(await a.locator('.preview').textContent(), /generation failed/); assert.equal(await a.locator('.error').count(), 0);
  await page.close();
});

test("browser: method options expose only implemented methods", async () => {
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${port}/`); await page.mouse.dblclick(160, 160); const card = page.locator('.card').first();
  assert.deepEqual(await card.locator('[data-field="method"] option').allTextContents(), ['llm']);
  await card.locator('[data-field="type"]').selectOption('audio'); assert.equal(await card.locator('[data-field="method"] option').count(), 0); await page.close();
});

test("browser: Remotion appears for image and video cards", async () => {
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${port}/`); await page.mouse.dblclick(160, 160); const card = page.locator('.card').first();
  await card.locator('[data-field="type"]').selectOption('image'); assert.deepEqual(await card.locator('[data-field="method"] option').allTextContents(), ['hyperframe', 'remotion']);
  await card.locator('[data-field="type"]').selectOption('video'); assert.deepEqual(await card.locator('[data-field="method"] option').allTextContents(), ['hyperframe', 'remotion']); await page.close();
});

test("browser: draft stays diskless until Generate; download and image popup work", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }); await page.goto(`http://127.0.0.1:${port}/`); await page.mouse.dblclick(160, 160); const card = page.locator('.card').first();
  const draft = await page.evaluate(() => { const n = [...nodes.values()][0]; return { workdir: n?.workdir || null }; }); assert.ok(draft); assert.equal(await page.locator('[data-action="download"]').isDisabled(), true); assert.equal(draft.workdir, null);
  await card.locator('textarea').fill('download test'); await card.getByRole('button', { name: 'Generate' }).click({ force: true }); await page.waitForFunction(() => [...document.querySelectorAll('.card')].some(x => x.querySelector('.meta')?.textContent.includes('idle')), null, { timeout: 20000 });
  const generated = await page.evaluate(() => [...nodes.values()][0]); assert.equal(existsSync(generated.workdir), true); assert.equal(await card.locator('[data-action="download"]').isDisabled(), false);
  const download = page.waitForEvent('download'); await card.locator('[data-action="download"]').click(); assert.match((await download).suggestedFilename(), /xiaoming_persona\.txt/); await page.close();
});

test("browser: image preview opens artifact in new tab", async () => {
  const image = join(tmpdir(), `hypermaker-preview-${Date.now()}.png`); writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }); await page.goto(`http://127.0.0.1:${port}/`); await page.evaluate(path => nodes.set(path, { id: path, path, type: 'image', method: 'hyperframe', status: 'idle', inputs: {}, position: { x: 80, y: 80 } }), image); await page.evaluate(() => render());
  const popup = page.waitForEvent('popup'); await page.locator('[data-preview-image]').click(); assert.match((await popup).url(), /\/api\/file\?path=/); await page.close();
});

test("browser: link drop restores source, empty drop moves source", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }); await page.goto(`http://127.0.0.1:${port}/`); await page.mouse.dblclick(160, 160); await page.mouse.dblclick(580, 160); await page.waitForTimeout(100);
  const source = page.locator('.card').first(), target = page.locator('.card').nth(1), before = await source.boundingBox(), targetBox = await target.boundingBox();
  await page.mouse.move(before.x + 20, before.y + 20); await page.mouse.down(); await page.mouse.move(targetBox.x + 20, targetBox.y + 20, { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(100); const linked = await source.boundingBox(); assert.equal(Math.round(linked.x), Math.round(before.x)); assert.equal(Math.round(linked.y), Math.round(before.y));
  await page.mouse.move(linked.x + 20, linked.y + 20); await page.mouse.down(); await page.mouse.move(1000, 700, { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(100); const moved = await source.boundingBox(); assert.notEqual(Math.round(moved.x), Math.round(before.x)); assert.notEqual(Math.round(moved.y), Math.round(before.y)); await page.close();
});
