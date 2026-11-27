// The report: draw two empty cards, wire one into the other, press Generate on the
// downstream one. The button greyed out and the card said nothing - the reason was a
// 400 in the browser console. Worse, the server crashed while assembling the run and
// left an attempt directory and a run marker behind, so a run that never started
// looked like one that had.
//
// What has to be true instead: the card says which input has nothing in it yet and
// what would fix it; the button comes back so the person can act on that; nothing is
// created on disk; and doing what the message says makes the same press work.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";
import { browserPath, launchBrowser } from "./browser.mjs";

const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-drafts-")), bin = join(base, "codex");
writeFileSync(join(base, "agent.mjs"), `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR;
mkdirSync(dir, { recursive: true });
const asked = readFileSync(join(dir, "prompt.txt"), "utf8");
writeFileSync(join(dir, "note.txt"), "made by the stand-in agent\\n");
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (out) writeFileSync(out, JSON.stringify({ prompt: "p", script: null, artifact: "note.txt", type: "text", method: "llm", error: null }));
`);
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(base, "agent.mjs"))} "$@"\n`); chmodSync(bin, 0o755);

const missingBrowser = existsSync(browserPath()) ? null
  : `no Chromium at ${browserPath()}: run \`npx playwright install chromium\` or set HYPERMAKER_CHROME`;

let browser;
before(async () => { if (!missingBrowser) browser = await launchBrowser(); });
after(async () => { await browser?.close(); stopAll(); });

test("pressing Generate on a card whose input is still empty says why, and leaves nothing behind", missingBrowser ? { skip: missingBrowser } : {}, async () => {
  const port = await freePort(), workdir = join(base, "ws");
  const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  app.stderr.on("data", c => process.stderr.write(c));
  await waitReady(port);
  const api = (method, path, payload) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
  const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
  const errors = []; page.on("pageerror", e => errors.push(String(e)));
  try {
    // Two cards and a link, as the canvas builds them: a person drags one header onto
    // another. Then Generate on the downstream one, which has no material.
    const upstream = Number(Object.keys((await api("POST", "/api/node", { x: 40, y: 60, type: "text", method: "llm", prompt: "upstream" })).nodes).at(-1));
    // Deliberately low on the canvas: the card's own message lands below the fold, so
    // this checks the case a person actually hits after dragging a card down there.
    const downstream = Number(Object.keys((await api("POST", "/api/node", { x: 400, y: 700, type: "text", method: "llm", prompt: "downstream" })).nodes).at(-1));
    await api("POST", "/api/link", { source: upstream, target: downstream });
    await page.goto(`http://127.0.0.1:${port}/`);
    const sel = `.card[data-id="${downstream}"]`;
    await page.waitForSelector(sel);

    await page.locator(`${sel} [data-generate]`).click();
    await page.waitForSelector(`${sel} .notice`, { timeout: 5000 });
    // A card can sit anywhere on an infinite canvas, so its own message can be below
    // the bottom of the window. The reason has to be visible where the person's eyes
    // are, or a greyed-out button is still the silence this report was about.
    const banner = page.locator("#banner");
    await banner.waitFor({ state: "visible", timeout: 3000 });
    const inView = await banner.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(inView && inView.y >= 0 && inView.y + inView.height <= viewport.height, `the reason is inside the window, got ${JSON.stringify(inView)}`);
    const said = await page.locator(`${sel} .notice`).textContent();
    assert.equal(await banner.textContent(), said, "the banner and the card say the same thing");
    assert.match(said, new RegExp(`#${upstream}`), `the message names the card with nothing in it, got ${said}`);
    assert.match(said, /unlink|Generate/i, `and says what would fix it, got ${said}`);

    // A refusal is not a run: the button is usable again, and the card does not claim
    // a failure that never happened.
    assert.equal(await page.locator(`${sel} [data-generate]`).isDisabled(), false, "Generate is usable again after a refusal");
    assert.equal(await page.locator(`${sel} .error`).count(), 0, "a refused press is not shown as a failed run");
    const after = (await api("GET", "/api/workspace")).nodes[downstream];
    assert.equal(after.status, "draft", "the card is still a draft");
    assert.equal(after.error, null, "and records no error");

    // Nothing was created for a run that never started.
    assert.equal(existsSync(join(workdir, String(downstream), "run.json")), false, "no attempt marker was left");
    const made = existsSync(join(workdir, String(downstream))) ? readdirSync(join(workdir, String(downstream)), { recursive: true }) : [];
    assert.deepEqual(made, [], `nothing was written for a refused press, got ${made}`);

    // Do what the message says: generate the input, then press again. It works, and
    // the notice is gone rather than sitting on the card about an old attempt.
    await page.locator(`.card[data-id="${upstream}"] [data-generate]`).click();
    await page.waitForFunction(id => document.querySelector(`.card[data-id="${id}"] .meta`)?.textContent.includes("idle"), upstream, { timeout: 20000 });
    await page.locator(`${sel} [data-generate]`).click();
    await page.waitForFunction(id => document.querySelector(`.card[data-id="${id}"] .meta`)?.textContent.includes("idle"), downstream, { timeout: 20000 });
    assert.equal(await page.locator(`${sel} .notice`).count(), 0, "the notice is cleared once a run really starts");
    const finished = (await api("GET", "/api/workspace")).nodes[downstream];
    assert.equal(finished.status, "idle");
    assert.ok(finished.artifact, "the downstream card has a result");
    assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  } finally {
    await page.close();
    stopServer(app);
  }
});
