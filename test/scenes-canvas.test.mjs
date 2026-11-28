import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserPath, launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

// A person makes a two-scene film from a blank canvas, with no model and no account.
//
// This walks the entry the way a first-time person does - add a card, pick the method, type, press
// the button - rather than posting to the API. The point of the slice is that a second picture is
// *reachable*: before it, an image card's only methods handed the work to an agent, so a film could
// only ever show the pictures a person already had on disk. Nothing here is a shortcut, and the
// agent binary is a probe that records any call, so "it ran anyway" is caught rather than assumed.
const root = process.cwd();
const chrome = browserPath();
const skip = existsSync(chrome) ? null : `no browser (set HYPERMAKER_CHROME); looked at ${chrome}`;

test("two pictures made on the canvas become a film of two scenes, and the card says what was measured", async t => {
  if (skip) return t.skip(skip);
  const base = mkdtempSync(join(tmpdir(), "hypermaker-scenes-ui-"));
  const workdir = join(base, "ws");
  const called = join(base, "called.log");
  const bin = join(base, "codex");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(called)}\necho '{"artifact":null,"error":"the agent path was entered"}' > "$4"\nexit 1\n`, { mode: 0o755 });
  let app;
  try {
    const port = await freePort();
    app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1", HYPERMAKER_CHROME: chrome } });
    await waitReady(port);
    const workspace = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
    const settle = async (id, tries = 2400) => {
      for (let i = 0; i < tries; i++) {
        const n = (await workspace()).nodes[id];
        if (n && n.status !== "running" && (n.artifact || n.error)) return n;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error(`node ${id} never settled: ${JSON.stringify((await workspace()).nodes[id])}`);
    };
    const browser = await launchBrowser();
    try {
      // Wide and tall enough that five cards fit without overlapping, because every one of them has
      // to be reachable for a drag: a card hidden under another is not something a person could use.
      const page = await browser.newPage({ viewport: { width: 2000, height: 1100 } });
      // ANY uncaught error in the canvas fails this test. A real workspace lost its film card this
      // way - `Cannot access 'shown' before initialization`, a local variable shadowing a helper -
      // and every assertion here still passed while the card was simply absent from the DOM, because
      // nothing was watching the page's own errors. The server was right, the file was on disk, and
      // only the browser could see the defect.
      const pageErrors = [];
      page.on("pageerror", error => pageErrors.push(String(error)));
      await page.goto(`http://127.0.0.1:${port}/`);
      // Each card is created where it should stay, by double-clicking an empty part of the canvas -
      // the gesture the product documents for making a card. That is both what a person does and
      // the only way to avoid a fixture problem this test hit twice: cards added with "+ Card"
      // all land at the same point and stack, and moving them afterwards with a synthetic drag is
      // fragile - a drag aimed at a card that has since re-rendered misses it, and the failure then
      // surfaces two steps later as a mysterious failed link.
      //
      // Spaced 300 apart at y=150, below the page's own toolbar: a card at the very top has its
      // title bar under that toolbar, where a drop lands on the toolbar rather than on the card.
      const spots = [[120, 200], [420, 200], [720, 200], [1020, 200], [1320, 200]];
      let next = 0;
      const addAt = async type => {
        const [x, y] = spots[next++];
        await page.mouse.dblclick(x, y);
        await page.waitForFunction(count => document.querySelectorAll(".card").length === count, next, { timeout: 10000 });
        const id = Number(Object.keys((await workspace()).nodes).at(-1));
        if (type && type !== "text") {
          await page.locator(`.card[data-id="${id}"] [data-field=type]`).selectOption(type);
          await page.waitForFunction(cardId => {
            const method = document.querySelector(`.card[data-id="${cardId}"] [data-field=method]`);
            return method && !method.disabled && method.value;
          }, id, { timeout: 10000 });
        }
        // The card really is where it was asked to be, and its title bar is clear of the toolbar -
        // asserted rather than assumed, because a stacked or hidden card makes every later drag
        // miss and the reason is invisible in the failure that follows.
        const box = await page.locator(`.card[data-id="${id}"]`).boundingBox();
        assert.ok(Math.abs(box.x - x) < 8 && Math.abs(box.y - y) < 8, `card ${id} was not created where it was double-clicked (${x},${y}) but at ${box.x},${box.y}`);
        assert.ok(box.y > 48, `card ${id}'s title bar is under the toolbar at y=${box.y}`);
        return id;
      };
      // A link is a drag from one card's title bar onto another's, which is the only way the canvas
      // offers. It is done here with the mouse rather than by posting to `/api/link`, because this
      // test's claim is that a person can reach a two-scene film *through the canvas*: a test that
      // wired the graph over HTTP would pass even if the gesture were broken, and would be evidence
      // for a path nobody walks. The source card returns to where it started - asserted below - so
      // linking does not disturb the layout.
      const link = async (from, to) => {
        const before = await page.locator(`.card[data-id="${from}"]`).boundingBox();
        const a = await page.locator(`.card[data-id="${from}"] header`).boundingBox();
        const b = await page.locator(`.card[data-id="${to}"] header`).boundingBox();
        await page.mouse.move(a.x + 40, a.y + a.height / 2);
        await page.mouse.down();
        await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 8 });
        await page.mouse.up();
        await page.waitForFunction(count => document.querySelectorAll(".edge").length >= count, 1, { timeout: 5000 });
        const after = await page.locator(`.card[data-id="${from}"]`).boundingBox();
        assert.deepEqual({ x: after.x, y: after.y }, { x: before.x, y: before.y }, `dragging card ${from} onto card ${to} must leave it where it was`);
        const inputs = ((await workspace()).nodes[to]?.inputs) || [];
        assert.ok(inputs.includes(from), `dragging card ${from} onto card ${to} must be recorded as that input`);
      };

      // The words: a three-line script, so the take has phrase times to cut on.
      const textId = await addAt();
      await page.locator(`.card[data-id="${textId}"] [data-prompt]`).fill("The harbour lights come on one by one.\nA gull complains about the weather.\nThe last boat turns for home.");
      await page.locator(`.card[data-id="${textId}"] [data-generate]`).click();
      await page.waitForFunction(id => !!document.querySelector(`.card[data-id="${id}"] pre`), textId, { timeout: 30000 });

      // The narration.
      const audioId = await addAt("audio");
      await page.waitForFunction(id => document.querySelector(`.card[data-id="${id}"] [data-field=method]`)?.value === "readaloud", audioId);
      await link(textId, audioId);
      await page.locator(`.card[data-id="${audioId}"] [data-generate]`).click();
      const spoken = await settle(audioId);
      assert.equal(spoken.error, null, `the narration: ${spoken.error}`);
      assert.ok(spoken.narration?.phrases?.length >= 2, `the take has phrase times to cut on: ${spoken.narration?.phrases?.length}`);

      // FIRST PICTURE. An image card, and its method list must offer one that runs here.
      const firstId = await addAt("image");
      await page.waitForFunction(id => document.querySelector(`.card[data-id="${id}"] [data-field=method]`)?.value === "titlecard", firstId, { timeout: 10000 });
      // The press on a card the server runs says Make, not Generate: the two cost different things.
      assert.match(await page.locator(`.card[data-id="${firstId}"] [data-generate]`).innerText(), /make/i, "a server-run card does not offer a model press");
      await page.locator(`.card[data-id="${firstId}"] [data-prompt]`).fill("The harbour lights\ncome on one by one.");
      await page.locator(`.card[data-id="${firstId}"] [data-generate]`).click();
      const picture = await settle(firstId);
      assert.equal(picture.error, null, `the first picture: ${picture.error}`);
      assert.equal(picture.picture.width, 1280, "the picture is the size of the frame a film will show it in");

      // SECOND PICTURE, the same way - the thing that needed a model before.
      const secondId = await addAt("image");
      await page.waitForFunction(id => document.querySelector(`.card[data-id="${id}"] [data-field=method]`)?.value === "titlecard", secondId, { timeout: 10000 });
      await page.locator(`.card[data-id="${secondId}"] [data-prompt]`).fill("The last boat turns\nfor home before the rain.");
      await page.locator(`.card[data-id="${secondId}"] [data-generate]`).click();
      const second = await settle(secondId);
      assert.equal(second.error, null, `the second picture: ${second.error}`);

      // THE FILM. Both pictures and the narration, linked in the order the scenes should appear.
      const filmId = await addAt("video");
      await page.waitForFunction(id => document.querySelector(`.card[data-id="${id}"] [data-field=method]`)?.value === "firstcut", filmId);
      // Linked in the order the scenes should appear: the narration first, then the pictures left to
      // right, then the words. `inputs` is an ordered list, so this order is what puts picture one
      // before picture two in the film.
      for (const source of [audioId, firstId, secondId, textId]) await link(source, filmId);
      // Four links are on the card before the press, and the press is the only thing that starts a
      // render. Waiting for a video *or* an error is deliberate: a refusal leaves the card in error,
      // and a wait that only watched for a video would sit until its own timeout and then blame the
      // product for a refusal it was told about in the first second.
      await page.locator(`.card[data-id="${filmId}"] [data-generate]`).click();
      await page.waitForFunction(id => {
        const card = document.querySelector(`.card[data-id="${id}"]`);
        return card && (card.querySelector("video") || card.querySelector(".error"));
      }, filmId, { timeout: 240000 });
      const cut = await settle(filmId);
      assert.equal(cut.error, null, `the film: ${cut.error}`);

      // The record: two scenes, each with its own window and its own words, and each measured.
      assert.equal(cut.film.scenes.length, 2, `two pictures should make two scenes: ${JSON.stringify(cut.film.scenes)}`);
      assert.match(cut.film.scenes[0].caption, /harbour lights/i);
      assert.match(cut.film.scenes[1].caption, /last boat/i, "the second scene carries its own words, not the first line again");
      for (const scene of cut.film.scenes) assert.ok(scene.shown > 0.8, `scene ${scene.index + 1} was measured against its own picture: ${scene.shown}`);

      // And the card says it, in the browser, without the file being opened by hand.
      const line = page.locator(`.card[data-id="${filmId}"] .scenes`);
      await line.waitFor({ state: "visible", timeout: 10000 });
      const text = await line.innerText();
      assert.match(text, /2 scenes/, `the card says how many scenes there are: ${text}`);
      assert.match(text, /scene 1 .*scene 2/s, `and names each one: ${text}`);
      assert.match(text, /worst picture match 0\.\d+/, `and the picture measurement: ${text}`);

      // The film plays, and it is longer than either scene: a film that only showed one scene would
      // still play, so the scene windows are what say the second one is on screen at all.
      const playing = await page.locator(`.card[data-id="${filmId}"] video`).evaluate(async v => {
        v.currentTime = 0;
        await v.play();
        await new Promise(r => setTimeout(r, 400));
        const at = v.currentTime;
        v.pause();
        return { at, duration: v.duration, paused: v.paused };
      });
      assert.ok(playing.at > 0, `the film plays: ${JSON.stringify(playing)}`);
      assert.ok(playing.duration >= cut.film.scenes[1].end - 0.2, `the film runs at least to the end of scene two (${playing.duration}s vs ${cut.film.scenes[1].end}s)`);

      // A LINKED PICTURE WHOSE FILE IS GONE. A supervisor deleted one picture's published file from
      // a real two-scene workspace, left the link in place, and pressed Make: the run went ahead,
      // the missing picture was left out, and a one-scene film was published over the two-scene
      // take. Nothing failed, so nothing said anything.
      //
      // The refusal has to arrive at the press, name the picture, and leave the approved take
      // exactly as it was - the supervisor's own words: "when the picture it names cannot be found,
      // say which one, on the spot, and keep the two-scene film."
      const filmFile = join(workdir, String(filmId), cut.artifact);
      const approvedBytes = readFileSync(filmFile);
      const secondLatest = (await workspace()).nodes[secondId].artifact;
      rmSync(join(workdir, String(secondId), secondLatest), { force: true });
      // The link is still there - that is the state a person is in when this happens - and the
      // press goes through the canvas, not the API, because that is where they are.
      await page.locator(`.card[data-id="${filmId}"] [data-generate]`).click();
      await page.waitForFunction(id => !!document.querySelector(`.card[data-id="${id}"] .notice, .card[data-id="${id}"] .error`), filmId, { timeout: 20000 });
      const said = await page.locator(`.card[data-id="${filmId}"] .notice, .card[data-id="${filmId}"] .error`).first().innerText();
      assert.match(said, new RegExp(`#${secondId}\\b`), `the refusal names the card whose file is gone: ${said}`);
      assert.match(said, /no longer in the workspace/, `and says what is wrong with it: ${said}`);
      assert.match(said, /unchanged/, `and that the take on the card is untouched: ${said}`);
      // The two-scene film is still the current one: same bytes, same record, still two scenes.
      const after = (await workspace()).nodes[filmId];
      assert.equal(after.artifact, cut.artifact, "the refused run must not publish over the approved film");
      assert.deepEqual(readFileSync(filmFile), approvedBytes, "and must not rewrite its bytes");
      assert.equal(after.film.scenes.length, 2, "the card still describes the two-scene film it holds");
      assert.equal(after.status, "idle", `a refused press is not a failed run: ${after.status} / ${after.error}`);
      // Only now, having unlinked that picture, may the person generate what the remaining pictures
      // describe - which is the same rule as every other refusal here: the next press is theirs to
      // decide, and the run they get is the one they asked for.
      await page.evaluate(({ s, t }) => fetch("/api/unlink", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: +s, target: +t }) }), { s: secondId, t: filmId });
      await page.reload();
      await page.waitForFunction(() => document.querySelector("#cards").children.length > 0);
      // The canvas never threw while painting any of this. Checked here, after the last reload, so a
      // card carrying the newest record fields - a film with scenes, captions and placements - is
      // painted from scratch by a client that has never seen it.
      assert.deepEqual(pageErrors, [], "the canvas painted every card without an uncaught error");
    } finally {
      await browser.close();
    }
    // No model was asked for any of it, which is the whole claim of this path.
    assert.equal(existsSync(called), false, "the agent path was never entered for a two-scene film");
  } finally {
    stopServer(app);
    stopAll();
  }
});
