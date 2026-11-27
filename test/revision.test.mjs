import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserPath, launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

// The story this checks, walked through the real browser entry:
//
//   I make a thing from a line of text and a picture, change one of those materials,
//   make a second take, then look at both and ask which material and which
//   instruction actually went into which take - and go back to the first take's
//   meaning and keep editing it.
//
// The app already kept every fact needed to answer that: each version records its own
// prompt and a frozen copy of each source, and each source names the artifact it came
// from, publish prefix included (`versions/v2-poster.png`). What it did not do was
// *show* the material half. `shown()` strips the publish prefix, so the card read
// `poster.png` - the name a material card keeps across every take - so two takes made
// from two different posters printed the same `made from #2 image poster.png`, and the
// compare panes named no material at all. A person comparing two takes was told what
// each was asked for, never what each was made of.
//
// All three cards here are text so the stand-in agent needs no renderer: the subject is
// what the canvas says, not how a film is encoded, and the media path has its own
// tests. Each artifact's bytes carry the instruction and the material it was given, so
// a caption can be checked against the bytes instead of against the record being
// displayed.
const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-revision-")), bin = join(base, "codex");

// The stand-in agent. Written as an array of lines joined at the end so this test file
// holds no nested template literal: an earlier version did, and every edit inside it
// had two layers of escaping to get wrong.
const standIn = [
  'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'const dir = process.env.HYPERMAKER_NODE_DIR;',
  'mkdirSync(dir, { recursive: true });',
  'const prompt = readFileSync(join(dir, "prompt.txt"), "utf8");',
  'const section = name => {',
  '  const at = prompt.indexOf("\\n# " + name + "\\n");',
  '  if (at < 0) return "";',
  '  const from = at + name.length + 4;',
  '  const next = prompt.indexOf("\\n\\n# ", from);',
  '  return (next < 0 ? prompt.slice(from) : prompt.slice(from, next)).trim();',
  '};',
  '// A text input arrives as its contents, not as a path: reading only the path made',
  '// every downstream take say "(no material)", which is the difference this test has',
  '// to be able to see in the bytes.',
  'const inputs = section("INPUTS");',
  'const material = (/artifact content:\\n```\\n([\\s\\S]*?)```/.exec(inputs) || [])[1] || "(no material)";',
  'const asked = section("USER PROMPT").split("\\n")[0].trim();',
  'const artifact = "result.txt";',
  'writeFileSync(join(dir, artifact), "asked: " + asked + "\\nmaterial: " + material.trim() + "\\n");',
  'const out = process.argv[process.argv.indexOf("--output-last-message") + 1];',
  'if (out) writeFileSync(out, JSON.stringify({ prompt: asked, script: null, artifact, type: "text", method: "llm", error: null }));',
  ''
].join("\n");
writeFileSync(join(base, "agent.mjs"), standIn);
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(base, "agent.mjs"))} "$@"\n`);
chmodSync(bin, 0o755);

const missingBrowser = existsSync(browserPath()) ? null
  : `no Chromium at ${browserPath()}: run \`npx playwright install chromium\` or set HYPERMAKER_CHROME`;
const canvasTest = (name, fn) => test(name, missingBrowser ? { skip: missingBrowser } : {}, fn);

let app, port, workdir, browser;
before(async () => {
  if (missingBrowser) return;
  port = await freePort();
  workdir = join(base, "ws");
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
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
const bytesOf = (id, file) => readFileSync(join(workdir, String(id), file), "utf8").trim();
const versionIn = text => (/#\d+ text result\.txt \(v(\d+)\)/.exec(text) || [])[1];

canvasTest("a take says which material version it was made from, and each compare pane says it for its own take", async () => {
  // The material card, generated twice, so its takes are `v1-` and `v2-`.
  const material = Number(Object.keys((await post("/api/node", { x: 0, y: 0, type: "text", method: "llm", prompt: "the sea" })).nodes).at(-1));
  await post("/api/generate", { id: material });
  const first = await settle(material);
  assert.equal(first.error, null, `the material rendered, got ${first.error}`);
  assert.equal(first.artifact, "versions/v1-result.txt", "the first material take is v1");
  await post("/api/generate", { id: material, prompt: "the storm" });
  const second = await settle(material);
  assert.equal(second.artifact, "versions/v2-result.txt", "the second material take is v2");

  // The card that is made from it.
  const card = Number(Object.keys((await post("/api/node", { x: 300, y: 0, type: "text", method: "llm", prompt: "first cut" })).nodes).at(-1));
  await post("/api/link", { source: material, target: card });
  await post("/api/generate", { id: card });
  const take1 = await settle(card);
  assert.equal(take1.error, null, `the first take rendered, got ${take1.error}`);
  assert.equal(take1.sources.length, 1);
  assert.equal(take1.sources[0].artifact, "versions/v2-result.txt", "it was made from the material card's second version");

  // A third material version, then a second take.
  await post("/api/generate", { id: material, prompt: "the harbour" });
  const third = await settle(material);
  assert.equal(third.artifact, "versions/v3-result.txt", "the third material take is v3");
  await post("/api/generate", { id: card, prompt: "second cut" });
  const take2 = await settle(card);
  assert.equal(take2.error, null, `the second take rendered, got ${take2.error}`);
  assert.equal(take2.sources[0].artifact, "versions/v3-result.txt", "and from the newer material");
  assert.equal(take2.versions.length, 1);

  // The bytes really differ, so a caption printing the same material twice would be
  // visible as a lie rather than as a rendering nuance.
  const keptFile = take2.versions[0].file, cardFile = take2.artifact;
  assert.notEqual(keptFile, cardFile);
  assert.match(bytesOf(card, keptFile), /material: asked: the storm/, "the kept take carries the words of the material it saw");
  assert.match(bytesOf(card, cardFile), /material: asked: the harbour/, "and the new take carries the newer ones");

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = []; page.on("pageerror", e => errors.push(String(e)));
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    const sel = `.card[data-id="${card}"]`;
    await page.waitForSelector(`${sel} .sources`);

    // 1. The card's own line names the version of the material it used, not the name
    //    the material card keeps across every take.
    const cardSources = await page.locator(`${sel} .sources`).innerText();
    assert.equal(versionIn(cardSources), "3", `the card names the material version it used, got ${JSON.stringify(cardSources)}`);

    // 2. Each pane names its own take's material, and they disagree when the material
    //    changed between the two takes.
    await page.locator(`${sel} [data-compare]`).click();
    await page.waitForSelector(".cmp .pane section[data-side=right] pre[data-text]");
    await page.waitForFunction(() => !document.querySelector(".cmp .pane section[data-side=right] pre").textContent.includes("loading"), null, { timeout: 8000 });
    const captions = await page.locator(".cmp .caption").allInnerTexts();
    const left = captions.find(c => /on the card/.test(c)), right = captions.find(c => /kept v/.test(c));
    assert.ok(left && right, `both panes are captioned, got ${JSON.stringify(captions)}`);
    assert.match(left, /asked for: second cut/, `the card pane names its instruction, got ${left}`);
    assert.match(right, /asked for: first cut/, `the kept pane names its instruction, got ${right}`);
    assert.equal(versionIn(left), "3", `the card pane names the material it used, got ${left}`);
    assert.equal(versionIn(right), "2", `the kept pane names the material *it* used, got ${right}`);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".cmp", { state: "detached" });

    // 3. Going back restores the older take's meaning; the card then names that take's
    //    material too, so the line and the bytes still agree.
    await page.locator(`${sel} [data-version]`).first().click();
    // Wait on the card's own material line, not on an "asked for" note: once the older
    // take is back, its instruction and the box agree and that note is correctly gone.
    await page.waitForFunction(sel => /\(v2\)/.test(document.querySelector(`${sel} .sources`)?.textContent || ""), sel, { timeout: 8000 });
    const restored = (await workspace()).nodes[card];
    assert.equal(restored.promptUsed, "first cut", "the instruction came back with the bytes");
    assert.equal(await page.locator(`${sel} [data-prompt]`).inputValue(), "first cut", "and so did the box, so the next edit continues that take");
    assert.equal(versionIn(await page.locator(`${sel} .sources`).innerText()), "2", "after going back the card names that take's material");

    // 3b. ...and the next press is not a surprise. The card upstream has already been
    //     generated again, so `made from (v2)` above describes the past while the next
    //     run would freeze v3. A supervisor went back to this older take, edited its
    //     prompt, pressed Generate, and only found out afterwards which material the new
    //     take had eaten. The card has to say that before the press.
    const upcoming = await page.locator(`${sel} .next`).innerText();
    assert.equal(versionIn(upcoming), "3", `the card says what the next Generate would use, got ${JSON.stringify(upcoming)}`);
    assert.match(upcoming, /^next Generate uses/, `and says it in those terms, got ${JSON.stringify(upcoming)}`);
    assert.equal(versionIn(await page.locator(`${sel} .sources`).innerText()), "2", "while `made from` keeps describing the take on the card");

    // 4. Reopening the page keeps all of it: the history is the workspace, not a session.
    await page.reload();
    await page.waitForSelector(`${sel} .sources`);
    assert.equal(versionIn(await page.locator(`${sel} .sources`).innerText()), "2", "the reopened card still names the material of the take it shows");
    assert.match(await page.locator(`${sel} [data-version]`).first().getAttribute("title"), /asked for: second cut/, "and the other take still says what it was asked");
    assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  } finally {
    await page.close();
  }
});
