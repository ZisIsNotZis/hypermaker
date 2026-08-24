import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = process.cwd(), port = 8951, workdir = mkdtempSync(join(tmpdir(), "hypermaker-e2e-")), bin = join(workdir, "codex");
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(root, "test/fake-codex.mjs"))}\n`); chmodSync(bin, 0o755);
let app, browser;
before(async () => { app = spawn("node", ["server/index.mjs"], { cwd: root, env: { ...process.env, PORT: String(port), CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1" } }); await new Promise(r => setTimeout(r, 400)); browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); app?.kill(); });

test("canvas creates, links, persists and generates concurrently", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } }); await page.goto(`http://127.0.0.1:${port}/`);
  await page.mouse.dblclick(150, 150); await page.mouse.dblclick(520, 150); await page.waitForTimeout(100);
  assert.equal(await page.locator(".card").count(), 2);
  const first = page.locator(".card").first(), second = page.locator(".card").nth(1), a = await first.boundingBox(), b = await second.boundingBox();
  await first.locator(".prompt").fill("first"); await second.locator(".prompt").fill("second");
  await page.mouse.move(a.x + 15, a.y + 15); await page.mouse.down(); await page.mouse.move(b.x + 15, b.y + 15, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(100);
  assert.equal(await page.locator(".edge").count(), 1); assert.equal((await page.evaluate(() => Object.values(state.nodes)[1].inputs)).length, 1);
  await page.locator(".card").first().locator('[data-action="generate"]').click(); await page.waitForTimeout(1000);
  const workspace = await (await fetch(`http://127.0.0.1:${port}/api/workspace`)).json(); assert.equal(workspace.nodes[1].artifact, "xiaoming_persona.txt");
  const reloaded = await browser.newPage(); await reloaded.goto(`http://127.0.0.1:${port}/`); assert.equal(await reloaded.locator(".card").count(), 2); assert.equal(await reloaded.locator(".edge").count(), 1); await page.close(); await reloaded.close();
});
