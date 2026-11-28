// Swap one of the two pictures a film is made of, and watch the film change.
//
//   HYPERMAKER_CHROME=/path/to/chrome HYPERMAKER_ESPEAK=/path/to/espeak-ng \
//   node test/story-replace-material.mjs
//
// WHY THIS WALK EXISTS. The product promises a person control over the material a film is made
// of: "drop a file on a supplied card and that card's material is replaced as a kept version, so
// the links survive and the old picture is one restore away". That promise was checked at the HTTP
// endpoint (`own-material.test.mjs`): the card's bytes change, the link survives, the old file is
// kept. What no check did was the part a person actually judges - press Make again and see the new
// picture in the film. That is a different claim, and this project has been bitten by exactly that
// gap before: a take whose *record* named the right source while the published film showed another
// picture passes every check that reads the record.
//
// A first version of this probe swapped a picture for another *identical* one, and reported success.
// It proved the plumbing (banner, version, link, new cut) and nothing about pixels - the film could
// have gone on showing the old bytes and every assertion would have passed. So the replacement here
// is a genuinely different drawing (`nightferry`: a much lower horizon, empty sky where the caption
// is not, no headland, the boat and gull at opposite ends), and the decisive check decodes the new
// film's own second act and compares it with BOTH pictures.
//
// WHAT IT DOES, as gestures:
//   * blank canvas -> two pictures via + File -> a four-line two-act story -> narration at 150 wpm
//     -> a film of the two pictures;
//   * the film is decoded: act two shows the second picture, and not the first;
//   * a third picture is DROPPED on the second picture card (a real drag-and-drop with a real File,
//     at the card's own coordinates - the path `index.html`'s window listener takes);
//   * the film is pressed again WITHOUT re-wiring anything;
//   * the new film is decoded: act one is still the first picture, act two is now the NEW picture
//     and no longer the one it replaced; the narration is the same take, byte for byte.
//
// WHAT IT DOES NOT ESTABLISH. The pictures are drawn by `test/harbour.mjs`, not photographed, so
// this shows that the person's chosen bytes reach the right scene, not that a photograph composes
// well. No model is in the loop (the agent binary is a probe that must never be called). And no
// person has looked at the result; every number here is a measurement.
//
// Exit 0 only if every step holds. The receipt is written to `$STORY_OUT` or
// `.tmp/story-replace-material/` so a number can be quoted without re-running it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { harbourPng } from "./harbour.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";
import { correlation } from "../voice/bind.mjs";

const root = process.cwd();
const chrome = process.env.HYPERMAKER_CHROME || process.env.CHROME_BIN;
if (!chrome || !existsSync(chrome)) { console.error(`set HYPERMAKER_CHROME to a Chromium build; looked at ${chrome || "nothing"}`); process.exit(1); }
const espeak = process.env.HYPERMAKER_ESPEAK;
if (!espeak || !existsSync(espeak)) {
  // Not a skip: the point is a film a person follows, and a run without the engine would measure
  // the built-in voice while claiming otherwise. `story-own-materials.mjs` is the walk for that.
  console.error(`set HYPERMAKER_ESPEAK to an espeak-ng binary; looked at ${espeak || "nothing"}`);
  process.exit(1);
}
const ff = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");
const ffprobe = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffprobe");
const out = process.env.STORY_OUT || join(root, ".tmp", "story-replace-material");
mkdirSync(out, { recursive: true });
const base = mkdtempSync(join(tmpdir(), "hyper-story-replace-"));

const STORY = [
  "The harbour wakes before the sun.",
  "A gull drops a shell on the stones.",
  "By evening the last boat turns for home.",
  "The water keeps the light a little longer.",
];
const dawn = join(base, "harbour at dawn.png"), dusk = join(base, "harbour at dusk.png");
const ferry = join(base, "ferry crossing at night.png");
writeFileSync(dawn, harbourPng("dawn"));
writeFileSync(dusk, harbourPng("dusk"));
writeFileSync(ferry, harbourPng("nightferry"));
assert.notDeepEqual(readFileSync(ferry), readFileSync(dusk), "the replacement is a different picture, not the same bytes under a new name");

const port = await freePort();
const workdir = join(base, "ws");
// No agent may run. The log proves it was never reached, rather than trusting a comment.
const called = join(base, "called.log"), bin = join(base, "codex");
writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(called)}\nexit 1\n`, { mode: 0o755 });
const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1", HYPERMAKER_CHROME: chrome, HYPERMAKER_ESPEAK: espeak } });
await waitReady(port);
const browser = await chromium.launch({ headless: true, executablePath: chrome });
const receipt = { story: STORY, materials: [dawn, dusk], replacement: ferry, steps: [] };
const note = (name, value) => { receipt.steps.push({ name, value }); console.log(name, JSON.stringify(value)); };
const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1900, height: 1100 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector("#cards");
  const ws = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
  const card = id => page.locator(`.card[data-id="${id}"]`);
  const settle = async (id, tries = 3600) => {
    for (let i = 0; i < tries; i++) {
      const n = (await ws()).nodes[id];
      if (n && n.status !== "running" && (n.artifact || n.error)) return n;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`card ${id} never settled: ${JSON.stringify((await ws()).nodes[id])}`);
  };
  const press = async id => {
    const button = card(id).locator("[data-generate]");
    await button.waitFor({ state: "visible" });
    for (let i = 0; i < 200 && !(await button.isEnabled()); i++) await page.waitForTimeout(50);
    if (!(await button.isEnabled())) throw new Error(`the press on card ${id} never became usable`);
    const before = (await ws()).nodes[id];
    await button.click();
    for (let i = 0; i < 400; i++) {
      const n = (await ws()).nodes[id];
      if (n && (n.status === "running" || n.error || n.artifact !== before.artifact)) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`pressing on card ${id} started nothing`);
  };
  const link = async (from, to) => {
    const a = await card(from).locator("header").boundingBox(), b = await card(to).locator("header").boundingBox();
    await page.mouse.move(a.x + 40, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    assert.ok(((await ws()).nodes[to].inputs || []).includes(from), `dragging card ${from} onto ${to} recorded the input`);
  };
  // A frame's pixels, from a film, as a small grid of the top two-thirds: the band where the two
  // pictures differ and no caption covers them. Same measurement `story-engine-voice.mjs` uses, so
  // the two walks' scene numbers can be read against each other.
  const grid = args => {
    const rgb = join(base, `g-${Math.random().toString(36).slice(2)}.rgb`);
    execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", ...args, "-vf", "crop=iw:ih*0.6667:0:0,scale=24:14:force_original_aspect_ratio=increase,crop=24:14", "-pix_fmt", "rgb24", "-c:v", "rawvideo", "-f", "image2", rgb]);
    return readFileSync(rgb);
  };
  const frameAt = (file, seconds, name) => {
    const still = join(out, name);
    execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(seconds), "-i", file, "-frames:v", "1", still]);
    return still;
  };

  // 1. THE PICTURES: the person's own two files, through + File.
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#add-file").click()]);
  await chooser.setFiles([dawn, dusk]);
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 2, null, { timeout: 30000 });
  const graph = await ws();
  const pics = Object.values(graph.nodes).filter(n => n.type === "image").sort((a, b) => a.x - b.x).map(n => n.id);
  assert.equal(pics.length, 2, `two files became two picture cards: ${JSON.stringify(Object.values(graph.nodes).map(n => [n.id, n.type]))}`);
  // Which card holds which drawing is a fact to read, not to assume: the film's act order follows
  // the drag order below, and this walk drags [first, second].
  const bytesOf = id => readFileSync(join(workdir, String(id), graph.nodes[id].artifact));
  assert.deepEqual(bytesOf(pics[0]), readFileSync(dawn), "the left card holds the first file");
  assert.deepEqual(bytesOf(pics[1]), readFileSync(dusk), "the right card holds the second file");
  note("the walker's two pictures are on the canvas", pics.map(id => ({ id, artifact: graph.nodes[id].artifact })));

  // 2. THE WORDS.
  await page.mouse.dblclick(80, 600); await page.waitForTimeout(300);
  const textCard = page.locator(".card").last();
  await textCard.locator("[data-prompt]").click();
  await textCard.locator("[data-prompt]").pressSequentially(STORY.join("\n"));
  await textCard.locator("[data-prompt]").blur();
  await page.waitForTimeout(300);
  const textId = Number(await textCard.getAttribute("data-id"));
  await press(textId);
  assert.equal((await settle(textId)).error, null, "the words were written");

  // 3. THE NARRATION, at a pace a person asks for on the card.
  await page.mouse.dblclick(420, 600); await page.waitForTimeout(300);
  const voice = page.locator(".card").last();
  await voice.locator("[data-field=type]").selectOption("audio");
  await page.waitForFunction(() => document.querySelector(".card:last-child [data-field=method]")?.value === "readaloud", null, { timeout: 10000 });
  const voiceId = Number(await voice.getAttribute("data-id"));
  await link(textId, voiceId);
  await card(voiceId).locator(".repace input").fill("150");
  await card(voiceId).locator(".repace input").blur();
  await press(voiceId);
  const take = await settle(voiceId);
  assert.equal(take.error, null, `the narration: ${take.error}`);
  const takeFile = join(workdir, String(voiceId), take.artifact);
  const takeDigest = sha(takeFile);
  note("the narration", { artifact: take.artifact, voice: take.narration?.voice, digest: takeDigest });

  // 4. THE FILM, of the two pictures in the order the story is told.
  await page.mouse.dblclick(760, 600); await page.waitForTimeout(300);
  const filmCard = page.locator(".card").last();
  await filmCard.locator("[data-field=type]").selectOption("video");
  await page.waitForFunction(() => document.querySelector(".card:last-child [data-field=method]")?.value === "firstcut", null, { timeout: 10000 });
  const filmId = Number(await filmCard.getAttribute("data-id"));
  for (const source of [voiceId, ...pics]) await link(source, filmId);
  await press(filmId);
  const cut1 = await settle(filmId);
  assert.equal(cut1.error, null, `the first film: ${cut1.error}`);
  assert.equal(cut1.film?.scenes?.length, 2, `two pictures make two acts: ${JSON.stringify(cut1.film?.scenes)}`);
  const film1 = join(workdir, String(filmId), cut1.artifact);

  // The first film shows the pictures it was made from. This is the control for the check that
  // matters later: if the measurement below cannot tell `dawn` from `dusk` here, its verdict on the
  // replacement would mean nothing.
  const mids = cut => cut.film.scenes.map(s => (Number(s.start) + Number(s.end)) / 2);
  const picGrids = new Map([[dawn, grid(["-i", dawn])], [dusk, grid(["-i", dusk])], [ferry, grid(["-i", ferry])]]);
  const actScores = (file, cut, tag) => mids(cut).map((at, i) => {
    const g = grid(["-i", frameAt(file, at, `${tag}-act-${i + 1}.png`)]);
    const scores = Object.fromEntries([...picGrids].map(([f, p]) => [f.split("/").pop(), Number(correlation(g, p).toFixed(3))]));
    return scores;
  });
  const first = actScores(film1, cut1, "first");
  note("the first film, act by act", first);
  assert.ok(first[0]["harbour at dawn.png"] > 0.8, `act one shows the first picture: ${JSON.stringify(first[0])}`);
  assert.ok(first[1]["harbour at dusk.png"] > 0.8, `act two shows the second picture: ${JSON.stringify(first[1])}`);
  assert.ok(first[1]["harbour at dusk.png"] > first[1]["harbour at dawn.png"] + 0.2, `and it is that picture rather than the other: ${JSON.stringify(first[1])}`);

  // 5. THE GESTURE: drop a different picture on the second picture card. A real File, a real
  //    DataTransfer, a real DragEvent at the card's own coordinates - what a person's pointer does.
  //
  //    `dragover` is dispatched first and its `preventDefault` is ASSERTED, because that is the gate
  //    a real file drop has to pass: without it the browser navigates to the file instead of handing
  //    it to the canvas. An earlier version of this walk fired `drop` straight at `window` and
  //    skipped the gate, so the canvas's own listener could have stopped calling
  //    `preventDefault` - and the walk would have gone on passing while a real drop opened the
  //    picture in a tab and lost the canvas. Pairing the two is what makes this a gesture rather
  //    than a call.
  const target = pics[1];
  const box = await card(target).boundingBox();
  const dropped = await page.evaluate(({ b64, name, x, y }) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], name, { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const over = new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt });
    window.dispatchEvent(over);
    const event = new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt });
    window.dispatchEvent(event);
    const el = document.elementFromPoint(x, y);
    return { overPrevented: over.defaultPrevented, defaultPrevented: event.defaultPrevented, over: el ? el.className || el.tagName : null };
  }, { b64: readFileSync(ferry).toString("base64"), name: "ferry crossing at night.png", x: box.x + box.width / 2, y: box.y + box.height / 2 });
  assert.equal(dropped.overPrevented, true, `dragging a file over the canvas is not a page navigation: ${JSON.stringify(dropped)}`);
  assert.equal(dropped.defaultPrevented, true, `the drop was taken by the canvas rather than opening the file in a tab: ${JSON.stringify(dropped)}`);
  note("the drag passed the canvas's own gates", dropped);
  await page.waitForTimeout(2000);

  const after = (await ws()).nodes[target];
  note("the replaced card", { artifact: after.artifact, kept: after.versions?.map(v => v.artifact) });
  assert.equal(sha(join(workdir, String(target), after.artifact)), (() => { const f = join(base, "ferry-check.png"); writeFileSync(f, readFileSync(ferry)); return sha(f); })(), "the card holds the dropped file's own bytes");
  assert.equal(after.versions?.length, 1, `the picture it replaced is kept as one version: ${JSON.stringify(after.versions)}`);
  assert.equal(after.versions[0].artifact, "harbour-at-dusk.png", `and that version is the old picture: ${JSON.stringify(after.versions)}`);
  assert.ok(existsSync(join(workdir, String(target), after.versions[0].file)), "the old picture is still on disk, so the swap is reversible");
  assert.deepEqual((await ws()).nodes[filmId].inputs, [voiceId, ...pics], "the film's links survive the swap - nothing was re-wired");
  // The banner is the sentence the person reads, not the record: a swap that worked while the
  // canvas said nothing is a person left wondering whether anything happened.
  const banner = await page.locator("#banner").innerText().catch(() => "");
  assert.match(banner, /now holds ferry crossing at night\.png/, `the canvas says what the card now holds: ${JSON.stringify(banner)}`);
  note("what the canvas said", banner);

  // And before the press, the card states the change the NEXT press would make: `made from` is the
  // past, `next` is the future, and a person editing material needs both or they are guessing.
  const nextLine = await card(filmId).locator(".meta.next").innerText().catch(() => "");
  // The name is the PUBLISHED one (`ferry-crossing-at-night.png`), which is the safe base name the
  // canvas uses everywhere, and the version beside it is the one the new cut would freeze. Both are
  // what a person needs: which picture, and that it is the one they just dropped rather than the
  // earlier version still sitting on the card.
  assert.match(nextLine, /ferry-crossing-at-night\.png \(v1\)/, `the film says the next cut would use the picture just dropped, by its published name: ${JSON.stringify(nextLine)}`);
  note("what the film card says the next press would use", nextLine);

  // 6. PRESS MAKE AGAIN, with nothing else touched.
  await press(filmId);
  const cut2 = await settle(filmId);
  assert.equal(cut2.error, null, `the second film: ${cut2.error}`);
  assert.notEqual(cut2.artifact, cut1.artifact, `the re-cut is a new version rather than the old film relabelled: ${cut1.artifact} -> ${cut2.artifact}`);
  assert.equal(cut2.film?.scenes?.length, 2, "still two acts");
  const film2 = join(workdir, String(filmId), cut2.artifact);
  note("the re-cut film", { artifact: cut2.artifact, sources: cut2.sources?.map(s => `${s.id}:${s.artifact}${s.file ? ` (frozen ${s.file})` : ""}`) });

  // 7. THE DECISIVE CHECK: the new film's own second act is the NEW picture, and no longer the one
  //    it replaced. Both halves are needed - a frame that stopped matching `dusk` but did not start
  //    matching `ferry` would be a broken scene, not a replaced one.
  const second = actScores(film2, cut2, "second");
  note("the re-cut film, act by act", second);
  assert.ok(second[0]["harbour at dawn.png"] > 0.8, `act one is untouched by a swap in act two: ${JSON.stringify(second[0])}`);
  assert.ok(second[1]["ferry crossing at night.png"] > 0.8, `act two shows the picture the person dropped: ${JSON.stringify(second[1])}`);
  assert.ok(second[1]["ferry crossing at night.png"] > second[1]["harbour at dusk.png"] + 0.2, `and no longer the picture it replaced: ${JSON.stringify(second[1])}`);

  // 8. THE SWAP COST NO VOICE. The narration was not re-rendered, so the take's bytes are the ones
  //    already published - a person swapping a picture must not get a different reading of the same
  //    words. (Re-wiring by hand would re-render it; this is the advantage of replacing in place.)
  assert.equal(sha(takeFile), takeDigest, "the narration is the same take, byte for byte, after the swap");
  assert.equal((await ws()).nodes[voiceId].versions?.length ?? 0, 0, `no new narration version was minted: ${JSON.stringify((await ws()).nodes[voiceId].versions)}`);
  // And the new film still carries that narration: a re-cut that quietly lost its sound would pass
  // every scene check above.
  const probe2 = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", film2], { encoding: "utf8" }));
  const stream2 = probe2.streams.find(s => s.codec_type === "audio");
  assert.equal(stream2?.codec_name, "aac", `the re-cut film has an audio stream: ${JSON.stringify(probe2.streams.map(s => s.codec_type))}`);
  const frozen = join(workdir, String(filmId), cut2.film.soundtrack.file);
  assert.equal(sha(frozen), takeDigest, "the film's frozen narration is the same take that was already published");
  note("the film's frozen narration", { file: cut2.film.soundtrack.file, digest: sha(frozen), sameAsTake: true });

  // 9. THE OLD FILM IS STILL THERE. A swap that made the earlier cut unusable would be a loss, not
  //    an edit: the person who liked the first film must be able to go back to it.
  const films = (await ws()).nodes[filmId].versions || [];
  assert.ok(films.some(v => v.artifact === cut1.artifact), `the first cut is kept as a version: ${JSON.stringify(films.map(v => v.artifact))}`);
  assert.ok(existsSync(join(workdir, String(filmId), cut1.artifact)), "and its file is still on disk");
  assert.ok(existsSync(join(workdir, String(target), after.versions[0].file)), "and so is the picture it replaced");

  // 10. STILL NO MODEL. Two films, a swap and a re-cut, all by the server.
  assert.equal(existsSync(called), false, "no model was run at any point in this walk");
  assert.deepEqual(errors, [], "the canvas raised no script error during the walk");
  note("page errors", errors);
  receipt.films = {
    first: { artifact: cut1.artifact, acts: first },
    recut: { artifact: cut2.artifact, acts: second, sources: cut2.sources },
  };
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 1));
  console.log(`receipt: ${join(out, "receipt.json")}`);
  console.log(`workspace: ${workdir}`);
  await browser.close();
  stopServer(app);
  stopAll();
}
process.exit(code);
