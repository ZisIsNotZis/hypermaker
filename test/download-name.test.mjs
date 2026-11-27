import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserPath, launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

// Taking a take out of the canvas.
//
// Three cuts of one film all downloaded as `film.mp4`: the card's title is deliberately
// the same for every take (the version is shown beside it, on screen), and the download
// name was built from that title alone. Once the files leave the canvas the order they
// were saved in is the only thing telling them apart, which is exactly when a person
// sends the wrong cut to someone else. Found by exporting all three takes of the
// short-film story and reading the suggested filenames.
//
// The subject is the name the browser suggests, not how the media was encoded, so the
// stand-in agent writes a text artifact: a download needs no renderer.
const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-download-")), bin = join(base, "codex");
writeFileSync(join(base, "agent.mjs"), `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR;
mkdirSync(dir, { recursive: true });
const prompt = readFileSync(join(dir, "prompt.txt"), "utf8");
const asked = (/\\n# USER PROMPT\\n([\\s\\S]*)$/.exec(prompt) || [])[1].trim();
const artifact = "result.txt";
writeFileSync(join(dir, artifact), asked + "\\n");
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (out) writeFileSync(out, JSON.stringify({ prompt: asked, script: null, artifact, type: "text", method: "llm", error: null }));
`);
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(base, "agent.mjs"))} "$@"\n`);
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
    if (node && node.status !== "running" && (node.artifact || node.error)) return node;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`node ${id} never settled`);
}

test("every kept take downloads under a name that still says which take it is", async t => {
  if (missingBrowser) return t.skip(missingBrowser);
  const created = await post("/api/node", { x: 0, y: 0, type: "text", method: "llm", prompt: "cut one" });
  const id = Number(Object.keys(created.nodes).at(-1));
  await post("/api/generate", { id });
  assert.equal((await settle(id)).error, null, "the first take rendered");
  await post("/api/generate", { id, prompt: "cut two" });
  const second = await settle(id);
  assert.equal(second.error, null, "the second take rendered");
  assert.equal(second.artifact, "versions/v2-result.txt", "the card now shows the second take");
  assert.equal(second.versions.length, 1, "and keeps the first one");

  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  const suggested = async () => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator(`.card[data-id="${id}"] [data-download]`).click()]);
    return download.suggestedFilename();
  };
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector(`.card[data-id="${id}"] [data-download]`);

    // The take on the card.
    const shownName = await suggested();
    assert.equal(shownName, "result-v2.txt", `the card's take downloads as ${shownName}`);

    // Going back to the first take and downloading it: the same artifact name, and a
    // different file a person can tell from the one above.
    await page.locator(`.card[data-id="${id}"] [data-version]`).first().click();
    await page.waitForFunction(sel => /\(v1\)/.test(document.querySelector(`${sel} .sources`)?.textContent || document.querySelector(sel)?.textContent || ""), `[data-id="${id}"]`, { timeout: 8000 }).catch(() => {});
    await page.waitForFunction(sel => /v1/.test(document.querySelector(`${sel} .meta`)?.textContent || ""), `[data-id="${id}"]`, { timeout: 8000 });
    const keptName = await suggested();
    assert.equal(keptName, "result-v1.txt", `the kept take downloads as ${keptName}`);
    assert.notEqual(keptName, shownName, "two takes of one card arrived under the same filename");

    // Pressing Download twice must not make the name depend on press order either.
    assert.equal(await suggested(), keptName, "the same take downloaded twice under two names");
    assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  } finally {
    await page.close();
  }
});

test("a file that was imported keeps its own name, and a name with no extension is not mangled", async t => {
  if (missingBrowser) return t.skip(missingBrowser);
  // The rule is "add the version when there is one", and the two ends of that rule are
  // easy to get wrong in opposite directions: an imported constant has no version and
  // must keep exactly its own name, while an artifact whose name has no dot must not
  // come back as `notes-v1` with its extension eaten. `saveAs` is a pure function, so it
  // is checked directly as well as through the button above.
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector("#cards");
    const cases = await page.evaluate(() => {
      // The canvas script is one scope, so its helpers are reachable from here.
      return {
        constant: saveAs("holiday.png"),
        published: saveAs("versions/v2-film.mp4"),
        noExtension: saveAs("versions/v3-notes"),
        leadingDot: saveAs("versions/v1-.env"),
        long: saveAs("versions/v12-shot-a.mp4"),
      };
    });
    assert.equal(cases.constant, "holiday.png", "an imported file keeps the name it had");
    assert.equal(cases.published, "film-v2.mp4", "a published take carries its version");
    assert.equal(cases.noExtension, "notes-v3", "a name with no extension gains only the version");
    assert.equal(cases.long, "shot-a-v12.mp4", "the version goes before the extension, not after it");
    assert.ok(cases.leadingDot.length > 0, "a name that begins with a dot is not truncated to nothing");
  } finally {
    await page.close();
  }
});
