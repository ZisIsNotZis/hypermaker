// The pace control, walked in a real browser: the thing the operator asked for.
//
// The server route can be tested without a canvas (`test/repace.test.mjs`), but the question the
// operator will actually put to it is a sequence of gestures - find the control on the card, change
// the number, wait, then compare the two takes and see which one the card is showing. Each of those
// can fail on its own while the route is perfect:
//
//   * the control may not appear on a card that can use it, or appear on one that cannot;
//   * the box may lose what a person typed because the card re-syncs while they type - the same
//     bug the prompt box had;
//   * the card may not say the take is a re-read, so two takes look like two unrelated ones;
//   * the earlier take may be unreachable, or the card may not say which of the two is selected.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserPath, launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

const missingBrowser = existsSync(browserPath()) ? null
  : `no Chromium at ${browserPath()}: run \`npx playwright install chromium\` or set HYPERMAKER_CHROME`;
const canvasTest = (name, fn) => test(name, missingBrowser ? { skip: missingBrowser } : {}, fn);

const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-repace-ui-")), bin = join(base, "codex");
writeFileSync(bin, `#!/bin/sh
case "$HYPERMAKER_NODE_TYPE" in
  text) exec node ${JSON.stringify(join(root, "test/fake-narration-text-codex.mjs"))} "$@" ;;
  audio) exec node ${JSON.stringify(join(root, "test/fake-narration-codex.mjs"))} "$@" ;;
  video) exec node ${JSON.stringify(join(root, "test/fake-film-codex.mjs"))} "$@" ;;
  *) exit 3 ;;
esac
`);
chmodSync(bin, 0o755);

const SCRIPT = "The tide comes in at six.\nThe boat waits.";
let app, browser, port, workdir;
before(async () => {
  if (missingBrowser) return;
  port = await freePort();
  workdir = join(base, "ws");
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1", HYPERMAKER_PROJECT: root } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); stopServer(app); stopAll(); });

const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const workspace = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
async function settle(id, tries = 900) {
  for (let i = 0; i < tries; i++) {
    const n = (await workspace()).nodes[id];
    if (n && n.status !== "running" && (n.artifact || n.error)) return n;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`node ${id} never settled`);
}

canvasTest("a person can ask for another pace from the card, and see and hear both takes", async () => {
  // A narration card with a published take, made through the API so the walk starts where a
  // person would find it: their film already made, one card approved.
  const text = Math.max(...Object.keys((await post("/api/node", { x: 40, y: 40, type: "text", method: "llm", prompt: SCRIPT })).nodes).map(Number));
  await post("/api/generate", { id: text, prompt: SCRIPT });
  await settle(text);
  const audio = Math.max(...Object.keys((await post("/api/node", { x: 400, y: 40, type: "audio", method: "narration", prompt: "Read this." })).nodes).map(Number));
  await post("/api/link", { source: text, target: audio });
  await post("/api/generate", { id: audio, prompt: "Read this." });
  const first = await settle(audio);
  assert.ok(first.artifact, `the first take did not publish: ${first.error}`);

  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors = []; page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  const card = page.locator(`.card[data-id="${audio}"]`);
  await card.locator(".repace").waitFor({ state: "visible" });

  // 1. The control is on the card, labelled, and starts at what this take actually reads at - so
  //    pressing it without an edit is a no-op a person can recognise.
  const box = card.locator(".repace input");
  assert.equal(await box.count(), 1, "the pace box is on a narration card");
  assert.equal(Number(await box.inputValue()), Math.round(first.narration.pace.wpm), "the box starts at the pace this take reads at");
  assert.match(await card.locator(".repace").innerText(), /words\/min/, "the control says what the number means");
  assert.equal(await card.locator("[data-repace]").isEnabled(), true, "Read again is usable on a settled take");

  // 2. Typing survives the card's own refresh. The card re-syncs on every workspace change, and
  //    an earlier control of this shape was rebuilt under the caret. A typing pause long enough to
  //    cross one refresh is what a person does naturally.
  await box.click();
  await box.fill("120");
  await page.waitForTimeout(700);
  assert.equal(await box.inputValue(), "120", "the number a person typed survived the card re-syncing");

  // 3. Ask for it, and let the card settle on the new take.
  await card.locator("[data-repace]").click();
  // Wait on the *record*, not on the status text: the press is a request, and a check that only
  // looks for "not running" is satisfied by the card the moment before it starts. That race made
  // an earlier version of this test read the old take and call it a failure.
  await page.waitForFunction(id => {
    const el = document.querySelector(`.card[data-id="${id}"] .meta`);
    return el && !el.textContent.includes("running") && /v[0-9]+/.test(el.textContent);
  }, audio, { timeout: 30000 });
  for (let i = 0; i < 300; i++) {
    const now = (await workspace()).nodes[audio];
    if (now.status !== "running" && now.artifact !== first.artifact) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const second = (await workspace()).nodes[audio];
  assert.equal(second.error, null, `the re-read failed from the canvas: ${second.error}`);
  assert.notEqual(second.artifact, first.artifact, "the card did not move onto the re-read take");
  // 120.7 is 120 read at the tool's own precision; the tolerance is the same 2% the pace tests
  // hold the renderer to, so this asserts the pace that was asked for, not a rounding.
  assert.ok(Math.abs(second.narration.pace.wpm - 120) / 120 < 0.02, `the new take should read at about 120 wpm, got ${second.narration.pace.wpm}`);

  // 4. The card says this take is a re-read of the previous one, and that only the pace moved. Two
  //    takes that just look like two takes are the thing a reader cannot tell apart later.
  const note = card.locator(".repace-note");
  assert.equal(await note.count(), 1, "the card says the take was re-read");
  assert.match(await note.innerText(), /re-read of/, `the note does not name the earlier take: ${await note.innerText()}`);
  assert.match(await note.innerText(), /same voice, only the pace changed/, `the note does not make the claim the record supports: ${await note.innerText()}`);

  // 5. The earlier take is one click away, and both compare panes play - the two things the
  //    operator said they would look for. The compare panel is the same one the film story uses,
  //    and the card names which take is selected in its own title.
  // The version strip reads `kept` then one button per take (`v1`); the earlier take has to be one
  // of those buttons, with the number the restored take would be, not a bare label.
  const versions = await card.locator(".versions").innerText();
  assert.match(versions, /kept/, `the earlier take is offered as a kept version: ${versions}`);
  assert.equal(await card.locator(".versions [data-version]").count(), 1, `one earlier take should be offered, got ${await card.locator(".versions [data-version]").count()}`);
  assert.match(await card.locator("header .meta").innerText(), new RegExp(`v${(second.artifact.match(/^versions\/v(\d+)-/) || [])[1]}`), "the card says which take is selected");
  await card.locator("[data-compare]").click();
  await page.waitForSelector(".cmp .pane section[data-side=right] audio");
  const panes = await page.locator(".cmp .pane audio").count();
  assert.equal(panes, 2, `the compare panel shows both takes, got ${panes}`);
  const played = await page.locator(".cmp .pane audio").evaluateAll(async as => {
    const facts = [];
    for (const a of as) {
      a.muted = true; a.currentTime = 0;
      await a.play().catch(() => {});
      await new Promise(r => setTimeout(r, 500));
      facts.push({ at: Math.round(a.currentTime * 100) / 100, paused: a.paused, duration: Number.isFinite(a.duration) ? Math.round(a.duration * 100) / 100 : null });
      a.pause(); a.currentTime = 0;
    }
    return facts;
  });
  for (const fact of played) {
    assert.ok(fact.duration > 0.5, `a compare pane reported no length: ${JSON.stringify(fact)}`);
    assert.ok(fact.at > 0.2, `a compare pane did not advance when played on its own: ${JSON.stringify(fact)}`);
  }
  // The two takes are the lengths the paces imply, so the pane on each side is the take it says.
  assert.ok(Math.abs(played[0].duration - played[1].duration) > 0.2,
    `both panes have the same length (${JSON.stringify(played)}), so the pace did not change the recording`);
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, [], `the canvas raised: ${errors.join(" | ")}`);
  await page.close();
});

canvasTest("a film is not re-cut by re-reading its narration, and the card says which take it used", async () => {
  // The distinction a person has to be able to see, in their own project: re-recording the voice
  // and re-making the film are two actions. An operator asked for exactly this after walking the
  // pace control on a card that feeds a film, so it is pinned here with a real Remotion render.
  //
  // The film card's own bytes must not move when the narration upstream is re-read: it was made
  // from the take it froze, and that take is still on disk and still what the film carries. What
  // does move is what the card says - `made from ... (v1)` for the film that exists, and a `next
  // Generate uses ... (v2)` line, because the person has deliberately changed the material and the
  // next cut is theirs to ask for.
  const { readFileSync } = await import("node:fs");
  const text = Math.max(...Object.keys((await post("/api/node", { x: 40, y: 40, type: "text", method: "llm", prompt: SCRIPT })).nodes).map(Number));
  await post("/api/generate", { id: text, prompt: SCRIPT });
  await settle(text);
  const audio = Math.max(...Object.keys((await post("/api/node", { x: 400, y: 40, type: "audio", method: "narration", prompt: "Read this." })).nodes).map(Number));
  await post("/api/link", { source: text, target: audio });
  await post("/api/generate", { id: audio, prompt: "Read this." });
  const first = await settle(audio);
  assert.ok(first.artifact, `the narration did not publish: ${first.error}`);

  const film = Math.max(...Object.keys((await post("/api/node", { x: 760, y: 40, type: "video", method: "remotion", prompt: "a quiet cut" })).nodes).map(Number));
  await post("/api/link", { source: audio, target: film });
  await post("/api/generate", { id: film, prompt: "a quiet cut" });
  const cut = await settle(film);
  assert.ok(cut.artifact, `the film did not render: ${cut.error}`);
  const filmPath = join(workdir, String(film), cut.artifact);
  const filmBytes = readFileSync(filmPath);

  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = []; page.on("pageerror", e => errors.push(String(e)));
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    const voiceCard = page.locator(`.card[data-id="${audio}"]`);
    await voiceCard.locator(".repace input").fill("120");
    await voiceCard.locator("[data-repace]").click();
    for (let i = 0; i < 300; i++) {
      const now = (await workspace()).nodes[audio];
      if (now.status !== "running" && now.artifact !== first.artifact) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const second = (await workspace()).nodes[audio];
    assert.notEqual(second.artifact, first.artifact, `the re-read did not publish: ${second.error}`);

    // The film is untouched on disk and in its record.
    const after = (await workspace()).nodes[film];
    assert.equal(after.artifact, cut.artifact, `re-reading the narration re-cut the film into ${after.artifact}`);
    assert.deepEqual(after.sources, cut.sources, "the film's own provenance changed without a new cut");
    assert.ok(readFileSync(filmPath).equals(filmBytes), "the film's bytes changed without a new cut");

    // And the card says both facts: what this cut used, and what the next one would use.
    await page.waitForTimeout(500);
    const card = page.locator(`.card[data-id="${film}"]`);
    const madeFrom = await card.locator(".sources").innerText();
    assert.match(madeFrom, /v1/, `the film does not say which narration take it used: ${madeFrom}`);
    const next = await card.locator(".next").innerText();
    assert.match(next, /v2/, `the film does not say the next cut would use the newer narration: ${next}`);
    assert.deepEqual(errors, [], `the canvas raised: ${errors.join(" | ")}`);
  } finally { await page.close(); }
});

canvasTest("a card that cannot be re-read offers no pace control at all", async () => {
  // A tone card has no words. Offering it a box that only ever answers with a refusal is worse than
  // not offering it: the control exists to say it cannot be used.
  const tone = Math.max(...Object.keys((await post("/api/node", { x: 40, y: 500, type: "audio", method: "synth", prompt: "a low hum" })).nodes).map(Number));
  await post("/api/generate", { id: tone, prompt: "a low hum" });
  await settle(tone);
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector(`.card[data-id="${tone}"]`);
    assert.equal(await page.locator(`.card[data-id="${tone}"] .repace`).count(), 0, "a tone card was offered a pace control");
  } finally { await page.close(); }
});
