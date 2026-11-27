// Two takes on one screen, and only one of them sounding.
//
// The compare panel exists so a person can choose between two takes without relying on
// memory. For pictures that worked. For *narrated* films it did not: pressing play on one
// pane left the other one playing, so two voices spoke over each other and the panel could
// compare pictures but not sound - on a product whose films carry narration, found by
// walking the short-film story (`test/film-story.mjs`) rather than by reading the code.
//
// The canvas now stops any other player when one starts, and this test is the gate: the
// audio takes here are the cheap fixture (`test/fake-audio-codex.mjs`, a real 6 s WAV,
// nothing installed), because the subject is which element is playing, not how the file
// was encoded - the film-specific shape of the same question is in the story.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserPath, launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-compare-")), bin = join(base, "codex");
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(root, "test", "fake-audio-codex.mjs"))} "$@"\n`);
chmodSync(bin, 0o755);

const missingBrowser = existsSync(browserPath()) ? null
  : `no Chromium at ${browserPath()}: run \`npx playwright install chromium\` or set HYPERMAKER_CHROME`;

let app, port, browser;
before(async () => {
  if (missingBrowser) return;
  port = await freePort();
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: join(base, "ws"), HYPERMAKER_RESET_WORKSPACE: "1" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); stopServer(app); stopAll(); });

const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const workspace = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
async function settle(id, tries = 400) {
  for (let i = 0; i < tries; i++) {
    const node = (await workspace()).nodes[id];
    if (node && node.status !== "running") return node;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`node ${id} never settled`);
}

test("comparing two narrated takes plays one at a time, so they can be told apart by ear", async t => {
  if (missingBrowser) return t.skip(missingBrowser);
  const created = await post("/api/node", { x: 0, y: 0, type: "audio", method: "synth", prompt: "first take" });
  const id = Number(Object.keys(created.nodes).at(-1));
  await post("/api/generate", { id });
  const first = await settle(id);
  assert.equal(first.error, null, `the first take rendered, got ${first.error}`);
  await post("/api/generate", { id, prompt: "second take" });
  const second = await settle(id);
  assert.equal(second.error, null, `the second take rendered, got ${second.error}`);
  assert.equal(second.versions.length, 1, "there are two takes to compare");

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector(`.card[data-id="${id}"] [data-compare]`);
    await page.locator(`.card[data-id="${id}"] [data-compare]`).click();
    await page.waitForSelector(".cmp .pane audio");
    const players = page.locator(".cmp .pane audio");
    assert.equal(await players.count(), 2, "the panel shows both takes");

    // Headless Chromium will not autoplay with sound, so the elements are muted for the
    // test - `paused` is the fact being checked, and muting does not change it.
    const handoff = await players.evaluateAll(async audios => {
      for (const a of audios) a.muted = true;
      await audios[1].play().catch(() => {});
      await new Promise(r => setTimeout(r, 300));
      const rightStarted = !audios[1].paused;
      await audios[0].play().catch(() => {});
      await new Promise(r => setTimeout(r, 500));
      const facts = {
        rightStarted,
        left: { paused: audios[0].paused, at: Math.round(audios[0].currentTime * 100) / 100 },
        right: { paused: audios[1].paused, at: Math.round(audios[1].currentTime * 100) / 100 },
      };
      for (const a of audios) a.pause();
      return facts;
    });
    assert.equal(handoff.rightStarted, true, "the right pane never played, so nothing was handed over from");
    assert.equal(handoff.left.paused, false, "the pane just pressed did not play");
    assert.equal(handoff.right.paused, true, `both takes played at once (right at ${handoff.right.at}s): two narrations over each other cannot be compared`);
    assert.ok(handoff.left.at > 0, "the pane that was pressed did not advance");

    // The same rule holds between a card's own preview and the panel: a card left playing
    // behind the overlay is one more voice. Closing the panel must not leave the paused
    // take silently marked as playing either - the player owns that state.
    await page.keyboard.press("Escape");
    await page.waitForSelector(".cmp", { state: "detached" });
    const after = await page.evaluate(() => [...document.querySelectorAll("audio,video")].map(m => ({ paused: m.paused, at: Math.round(m.currentTime * 100) / 100 })));
    assert.ok(after.every(m => m.paused), `closing the panel left something playing: ${JSON.stringify(after)}`);
    assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  } finally {
    await page.close();
  }
});
