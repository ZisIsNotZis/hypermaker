// A short film, made the way a person makes one: a line of text becomes a spoken
// narration, a poster becomes the title card, and one more card turns both into a film
// you can play with sound. Then the interesting part - the script and the poster are
// rewritten, a second cut is made, the two are compared, and the *first* cut is picked
// up again and continued on purpose.
//
//   HYPERMAKER_CHROME=/path/to/chrome node test/film-story.mjs
//
// Everything is rendered for real: Remotion for the pictures and the film, the project's
// own voice for the narration, ffmpeg for the checks. Only the "creative decisions" are
// a stand-in (`test/film-story-agent.mjs`), and it makes them from the prompt the server
// assembled, so each published file carries the words and the material it was given.
//
// Not part of `npm test`: it renders three films and takes a couple of minutes. What it
// leaves behind is the point - `receipt.json` (every fact, including what changed between
// takes and which frozen material each take used), the screenshots, and the workspace
// itself, so the films can be opened and played afterwards.
//
// Every published film is checked three ways, because a caption is not evidence:
//   * it is an h264 film with a real duration (ffprobe);
//   * its embedded audio is not silence, and it is *this* narration - the extracted
//     track is correlated against the frozen narration the take says it used, so a film
//     playing the previous take's voice is caught;
//   * the take it was published as names the material version it froze, and that copy
//     is still on disk beside it.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";
import { wavStats } from "./wav.mjs";
import { correlation } from "../voice/bind.mjs";
import { wavSamples } from "../voice/wav.mjs";

const root = process.cwd();
const ff = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");
const ffprobe = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffprobe");
const base = mkdtempSync(join(tmpdir(), "hyper-film-story-"));
const bin = join(base, "codex");
writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(join(root, "test", "film-story-agent.mjs"))} "$@"\n`);
chmodSync(bin, 0o755);
const chrome = process.env.HYPERMAKER_CHROME || process.env.CHROME_BIN;
if (!chrome) throw new Error("set HYPERMAKER_CHROME (or CHROME_BIN) to a Chromium build; Remotion and the canvas both need one");
const port = await freePort();
const workdir = process.env.STORY_WORKDIR || join(base, "ws");
const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1", HYPERMAKER_CHROME: chrome } });
const log = [];
app.stdout.on("data", c => log.push(c.toString()));
app.stderr.on("data", c => log.push(c.toString()));
await waitReady(port);
const browser = await chromium.launch({ headless: true, executablePath: chrome });
const shots = process.env.HYPERMAKER_SHOTS || join(root, ".tmp", "film-story");
mkdirSync(shots, { recursive: true });
const ws = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
const out = { steps: [], films: [] };
const note = (name, value) => { out.steps.push({ name, value }); console.log(name, JSON.stringify(value)); };
// Waits for a run to finish *and* to have produced something. Returning as soon as the
// status is not `running` treated a card that never started as a finished one: a press
// that landed while the method list was still refilling hit a disabled button, nothing
// was claimed, and the story went on to read a draft's `null` artifact.
async function settle(id, tries = 2400) {
  for (let i = 0; i < tries; i++) {
    const n = (await ws()).nodes[id];
    if (n && n.status !== "running" && (n.artifact || n.error)) return n;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`node ${id} never settled: ${JSON.stringify((await ws()).nodes[id])}`);
}
// Pressing Generate the way a person does, and refusing to go on unless a run really
// started. The Generate button is disabled until the card's method list has loaded, which
// is asynchronous after a type change - clicking too early is a no-op, not an error the
// page reports anywhere.
async function press(id) {
  const button = page.locator(`.card[data-id="${id}"] [data-generate]`);
  await button.waitFor({ state: "visible" });
  for (let i = 0; i < 200 && !(await button.isEnabled()); i++) await page.waitForTimeout(50);
  if (!(await button.isEnabled())) throw new Error(`Generate on card ${id} never became usable`);
  const before = (await ws()).nodes[id];
  await button.click();
  for (let i = 0; i < 200; i++) {
    const n = (await ws()).nodes[id];
    if (n && (n.status === "running" || n.error || n.artifact !== before.artifact)) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`pressing Generate on card ${id} started nothing (still ${JSON.stringify((await ws()).nodes[id])})`);
}
const nodeDir = (id, file) => join(workdir, String(id), file);
// A take that did not publish must stop the story where it happened, naming the card and
// the server's reason - not fall through into a `join(null)` three steps later.
const expectTake = (what, node) => {
  if (node.error) throw new Error(`${what} failed: ${node.error}`);
  if (!node.artifact) throw new Error(`${what} published nothing: ${JSON.stringify(node)}`);
  return node;
};

// Where a copied track actually starts relative to its source, in samples. The search is
// bounded to ±150 ms: an encoder delay is a few hundred samples, while a film playing the
// wrong take is not a small offset and must not be rescued by a wide search.
function bestLag(a, b) {
  const window = Math.min(a.length, b.length, 11025);
  const mid = Math.floor((Math.min(a.length, b.length) - window) / 2);
  let best = { lag: 0, score: -2 };
  for (let lag = -3300; lag <= 3300; lag += 1) {
    const bStart = mid + lag;
    if (bStart < 0 || bStart + window > b.length) continue;
    const score = correlation(a.subarray(mid, mid + window), b.subarray(bStart, bStart + window));
    if (score > best.score) best = { lag, score };
  }
  return best.lag;
}
function correlationAt(a, b, lag) {
  const aStart = Math.max(0, -lag), bStart = Math.max(0, lag);
  const n = Math.min(a.length - aStart, b.length - bStart);
  if (n <= 0) return 0;
  return correlation(a.subarray(aStart, aStart + n), b.subarray(bStart, bStart + n));
}

// The checks above, in one place, for a film card that has just settled. `other` is
// another take's frozen narration copy in the same card, used to prove the check can tell
// two narrations apart.
function filmFacts(take, other = null) {
  const file = nodeDir(take.id, take.artifact);
  const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" }));
  const video = probe.streams.find(s => s.codec_type === "video");
  const audio = probe.streams.find(s => s.codec_type === "audio");
  const seconds = Number(probe.format.duration);
  // The narration this take says it used: the frozen copy named in its own record.
  const spoken = (take.sources || []).find(s => s.type === "audio");
  if (!spoken || !spoken.file) throw new Error(`take ${take.artifact} records no frozen narration: ${JSON.stringify(take.sources)}`);
  const frozen = nodeDir(take.id, spoken.file);
  if (!existsSync(frozen)) throw new Error(`the frozen narration ${spoken.file} is not beside the take`);
  const extracted = join(base, `extract-${Date.now()}-${basename(take.artifact)}.wav`);
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "22050", extracted]);
  const { peak, nonzero } = wavStats(extracted);
  const heard = wavSamples(readFileSync(extracted)), wanted = wavSamples(readFileSync(frozen));
  // The track is a straight copy of the narration, so it should *be* the narration - but
  // only after lining up the AAC encoder's delay. Comparing at zero lag measured -0.05 on
  // an honest film the first time this ran: every AAC stream starts a few hundred samples
  // later than the source, and a correlation of two offset signals says "unrelated" about
  // audio that is exactly right. So the offset is searched, and the zero-lag number is
  // kept beside the aligned one - a bar that silently moves to the best lag would also
  // accept a film whose sound starts a second late.
  const lag = bestLag(heard.samples, wanted.samples);
  const agree = correlationAt(heard.samples, wanted.samples, lag);
  return {
    artifact: take.artifact,
    codec: video && video.codec_name, pix: video && `${video.width}x${video.height}`,
    audioCodec: audio && audio.codec_name, seconds: Math.round(seconds * 100) / 100,
    peak, nonzero,
    narration: { id: spoken.id, artifact: spoken.artifact, copy: spoken.file },
    agreement: Math.round(agree * 1000) / 1000,
    lagSamples: lag, lagMs: Math.round(lag / 22.05) / 10,
    unalignedAgreement: Math.round(correlationAt(heard.samples, wanted.samples, 0) * 1000) / 1000,
    // What the same measurement says about a *different* take's narration. If this were
    // not clearly below the aligned score, the check would be measuring loudness rather
    // than which words were spoken.
    againstOtherTake: spoken.artifact && other ? Math.round(correlationAt(heard.samples, wavSamples(readFileSync(nodeDir(take.id, other))).samples, lag) * 1000) / 1000 : null,
  };
}

let page;
try {
  page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector("#cards");
  const card = id => page.locator(`.card[data-id="${id}"]`);

  // Dragging a card's title onto another card's title is how the canvas makes a link;
  // walking that gesture rather than calling /api/link is the point of the story.
  const linkTitles = async (src, dst) => {
    const a = await card(src).boundingBox(), b = await card(dst).boundingBox();
    await page.mouse.move(a.x + 100, a.y + 15); await page.mouse.down();
    await page.mouse.move(b.x + 100, b.y + 15, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(250);
  };
  // A missing `next` line is the card saying the live links and the take agree, which is a
  // fact worth recording - not a locator to time out on.
  const nextLine = async id => (await card(id).locator(".next").count()) ? await card(id).locator(".next").innerText() : "(silent: the next press would freeze the same material)";

  // 1. The words. A real person writes the line the film is about.
  await page.mouse.dblclick(80, 80); await page.waitForTimeout(200);
  const lines = page.locator(".card").last();
  await lines.locator("[data-prompt]").click();
  await lines.locator("[data-prompt]").pressSequentially("The tide comes in at six. The boat waits.");
  await lines.locator("[data-prompt]").blur();
  await page.waitForTimeout(300);
  const linesId = await lines.getAttribute("data-id");
  await press(linesId);
  note("lines take 1", { artifact: expectTake("the words", await settle(linesId)).artifact });

  // 2. The narration, from the words. The link comes first: a narration card with no
  //    text to read is refused, and that refusal is the app being right - the words the
  //    person wrote are the material, so dragging them onto the voice card is the gesture
  //    this step exists to walk.
  await page.mouse.dblclick(420, 80); await page.waitForTimeout(200);
  const voice = page.locator(".card").last();
  await voice.locator("[data-field=type]").selectOption("audio");
  await page.waitForTimeout(300);
  await voice.locator("[data-field=method]").selectOption("narration");
  await page.waitForTimeout(300);
  const voiceId = await voice.getAttribute("data-id");
  await linkTitles(linesId, voiceId);
  note("narration input", (await ws()).nodes[voiceId].inputs);
  // The pace is asked for in the card's own instruction, the way a person would write it, and
  // the card has to come back saying what was asked and what it got. This is the half of pace
  // control that is a fact about this build: whether a *model* obeys the same sentence is not
  // established - a real run was attempted and stopped at workspace discovery (451), so the
  // model turn never began (see docs/evidence/) - and the guide test pins only that the
  // instruction reaches the agent's prompt.
  await card(voiceId).locator("[data-prompt]").click();
  await card(voiceId).locator("[data-prompt]").fill("Read this at 200 words a minute, brisk but clear.");
  await card(voiceId).locator("[data-prompt]").blur();
  await page.waitForTimeout(300);
  await press(voiceId);
  const voice1 = expectTake("the narration", await settle(voiceId));
  note("narration take 1", { artifact: voice1.artifact, error: voice1.error, pace: voice1.narration && voice1.narration.pace, narration: voice1.narration && { words: voice1.narration.words, seconds: voice1.narration.seconds, verdict: voice1.narration.verdict, correlation: voice1.narration.take && voice1.narration.take.correlation } });
  const paceLine = await card(voiceId).locator(".narration").innerText();
  note("the card states the pace", paceLine);
  assert.ok(/asked 200 words\/min/.test(paceLine), `the card does not say what pace was asked for: ${paceLine}`);
  assert.ok(/reads at 19[0-9]|reads at 20[0-9]/.test(paceLine), `the card does not report the pace it reached: ${paceLine}`);
  assert.ok(Math.abs(voice1.narration.pace.wpm - 200) <= 4, `asked for 200 words a minute, the take is ${voice1.narration.pace.wpm}`);

  // 3. The picture.
  await page.mouse.dblclick(760, 80); await page.waitForTimeout(200);
  const poster = page.locator(".card").last();
  await poster.locator("[data-field=type]").selectOption("image");
  await page.waitForTimeout(300);
  const posterId = await poster.getAttribute("data-id");
  await poster.locator("[data-prompt]").click();
  await poster.locator("[data-prompt]").pressSequentially("the boat at dawn");
  await poster.locator("[data-prompt]").blur();
  await page.waitForTimeout(300);
  await press(posterId);
  note("poster take 1", { artifact: expectTake("the poster", await settle(posterId)).artifact });

  // 4. The film, linked from the narration and the poster by dragging titles.
  await page.mouse.dblclick(1100, 520); await page.waitForTimeout(200);
  const film = page.locator(".card").last();
  await film.locator("[data-field=type]").selectOption("video");
  await page.waitForTimeout(300);
  const filmId = await film.getAttribute("data-id");
  for (const src of [voiceId, posterId]) await linkTitles(src, filmId);
  note("links", (await ws()).nodes[filmId].inputs);
  await film.locator("[data-prompt]").click();
  await film.locator("[data-prompt]").pressSequentially("cut one: wide, quiet");
  await film.locator("[data-prompt]").blur();
  await page.waitForTimeout(300);
  await press(filmId);
  const cut1 = expectTake("the first cut", await settle(filmId));
  const cut1Facts = filmFacts(cut1);
  note("film take 1", { error: cut1.error, promptUsed: cut1.promptUsed, sources: cut1.sources, facts: cut1Facts });
  out.films.push({ step: "cut one", ...cut1Facts });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, "1-cut-one.png") });

  // 5. The person rewrites the words - and the picture along with them.
  const linesNow = card(linesId);
  await linesNow.locator("[data-prompt]").click();
  await linesNow.locator("[data-prompt]").fill("The storm comes in at six. The boat stays.");
  await linesNow.locator("[data-prompt]").blur();
  await page.waitForTimeout(400);
  await press(linesId);
  const lines2 = expectTake("the rewritten words", await settle(linesId));
  note("lines take 2", { artifact: lines2.artifact });
  await press(voiceId);
  const voice2 = expectTake("the second narration", await settle(voiceId));
  note("narration take 2", { artifact: voice2.artifact, narration: voice2.narration && { words: voice2.narration.words, seconds: voice2.narration.seconds } });
  const posterNow = card(posterId);
  await posterNow.locator("[data-prompt]").click();
  await posterNow.locator("[data-prompt]").fill("the boat in the storm");
  await posterNow.locator("[data-prompt]").blur();
  await page.waitForTimeout(400);
  await press(posterId);
  note("poster take 2", { artifact: expectTake("the second poster", await settle(posterId)).artifact });

  // What changed, read from the card rather than remembered: the material each take froze.
  note("the card says what changed", {
    madeFrom: await card(filmId).locator(".sources").innerText(),
    next: await nextLine(filmId),
    liveNarration: (await ws()).nodes[filmId].sources[0].artifact,
  });

  // 6. The second cut, with a new instruction.
  await card(filmId).locator("[data-prompt]").click();
  await card(filmId).locator("[data-prompt]").fill("cut two: close on the storm");
  await card(filmId).locator("[data-prompt]").blur();
  await page.waitForTimeout(400);
  await press(filmId);
  const cut2 = expectTake("the second cut", await settle(filmId));
  const cut2Facts = filmFacts(cut2, cut2.versions[0].sources.find(s => s.type === "audio").file);
  note("film take 2", { error: cut2.error, promptUsed: cut2.promptUsed, sources: cut2.sources, kept: cut2.versions.map(v => ({ artifact: v.artifact, file: v.file, prompt: v.prompt, sources: v.sources })), facts: cut2Facts });
  out.films.push({ step: "cut two", ...cut2Facts });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, "2-cut-two.png") });

  // 7. Both cuts, side by side. The material line is what tells them apart.
  await card(filmId).locator("[data-compare]").click();
  await page.waitForSelector(".cmp .pane section[data-side=right] video");
  await page.waitForTimeout(900);
  const panes = await page.locator(".cmp .pane section").evaluateAll(es => es.map(e => ({
    side: e.dataset.side,
    caption: e.querySelector(".caption")?.innerText,
    src: e.querySelector("video,audio,img")?.getAttribute("src"),
  })));
  note("compare", panes);
  // A container that ffprobe likes is not a film a person can watch. Each pane is played
  // here, in the browser, on its own, and its clock has to advance.
  //
  // The first version of this started both panes at once and sampled them together. That
  // was a wrong reading of the product, not just of the test: the canvas deliberately stops
  // a second player, so starting both left the first one paused at 0 s and the story
  // recorded "did not advance" about a pane it had just silenced itself. A supervisor hit
  // the same thing in an independent copy. Each pane is therefore sampled alone, and the
  // hand-off between them is a separate, stated check.
  const playedPanes = await page.locator(".cmp .pane video").evaluateAll(async vs => {
    const facts = [];
    for (const v of vs) {
      v.muted = true; // autoplay rules apply to unmuted media
      v.currentTime = 0;
      await v.play().catch(() => {});
      await new Promise(r => setTimeout(r, 900));
      facts.push({
        duration: Number.isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : null,
        at: Math.round(v.currentTime * 100) / 100,
        paused: v.paused, error: v.error && v.error.code,
      });
      v.pause();
      v.currentTime = 0;
    }
    return facts;
  });
  note("each compare pane plays on its own", playedPanes);
  // Comparing two *narrated* cuts by ear needs one voice at a time. Start the newer take,
  // then press the older one: the newer one has to stop. Then press the newer one again,
  // because handing the sound back is the other half of comparing - the gesture is "this
  // one, no wait, that one", not one direction only.
  const takeover = await page.locator(".cmp .pane video").evaluateAll(async vs => {
    for (const v of vs) v.muted = true;
    await vs[0].play().catch(() => {});
    await new Promise(r => setTimeout(r, 400));
    const firstPlaying = !vs[0].paused;
    await vs[1].play().catch(() => {});
    await new Promise(r => setTimeout(r, 700));
    const facts = {
      firstWasPlaying: firstPlaying,
      left: { paused: vs[0].paused, at: Math.round(vs[0].currentTime * 100) / 100 },
      right: { paused: vs[1].paused, at: Math.round(vs[1].currentTime * 100) / 100 },
    };
    const beforeBack = facts.left.paused;
    await vs[0].play().catch(() => {});
    await new Promise(r => setTimeout(r, 700));
    facts.back = {
      leftPaused: vs[0].paused, leftAt: Math.round(vs[0].currentTime * 100) / 100,
      rightPaused: vs[1].paused, rightAt: Math.round(vs[1].currentTime * 100) / 100,
      rightHadStopped: beforeBack,
    };
    for (const v of vs) v.pause();
    return facts;
  });
  note("two cuts, one voice at a time", takeover);
  assert.equal(takeover.firstWasPlaying, true, "the left pane never started playing, so the hand-off was not tested");
  assert.equal(takeover.right.paused, false, "the pane just pressed did not play");
  // This is the one that failed the first time it was written: both panes played at once,
  // so two narrations spoke over each other and the panel could compare pictures but not
  // sound. The canvas now stops any other player when one starts; the assertion stays
  // here because it is the behaviour, not the fix, that has to keep being true.
  assert.equal(takeover.left.paused, true, `both cuts were playing at once (left at ${takeover.left.at}s), so two narrations overlap and cannot be compared by ear`);
  assert.equal(takeover.back.rightHadStopped, true, "the right pane never stopped, so handing the sound back was not tested");
  assert.equal(takeover.back.leftPaused, false, "pressing the other pane again did not start it");
  assert.equal(takeover.back.rightPaused, true, `handing the sound back left both playing (right at ${takeover.back.rightAt}s)`);
  await page.screenshot({ path: join(shots, "3-compare.png") });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".cmp", { state: "detached" });

  // 8. Continue from the first cut on purpose: back to it, then make its material live
  //    again by restoring the narration and the poster upstream, and change only the
  //    instruction. That is the gesture the story is about - "that one, but nearer".
  await card(filmId).locator("[data-version]").first().click();
  await page.waitForFunction(id => /\(v1\)/.test(document.querySelector(`.card[data-id="${id}"] .sources`)?.textContent || ""), filmId, { timeout: 8000 });
  const restored = (await ws()).nodes[filmId];
  note("back to cut one", {
    artifact: restored.artifact, promptUsed: restored.promptUsed,
    box: await card(filmId).locator("[data-prompt]").inputValue(),
    madeFrom: await card(filmId).locator(".sources").innerText(),
    next: await nextLine(filmId),
  });
  await page.screenshot({ path: join(shots, "4-back-to-one.png") });

  // The narration and the poster go back to the takes cut one used. This is the person
  // saying "these were the ones I meant", and it is reversible: the newer takes stay.
  for (const id of [voiceId, posterId]) {
    await card(id).locator("[data-version]").first().click();
    await page.waitForTimeout(700);
  }
  const upstream = { voice: (await ws()).nodes[voiceId], poster: (await ws()).nodes[posterId] };
  // Restoring upstream should make the `next` line go silent: the take on the film card
  // and the material the next press would freeze describe the same bytes again.
  note("upstream restored", {
    voice: upstream.voice.artifact, poster: upstream.poster.artifact,
    voiceNext: await nextLine(voiceId),
    filmNext: await nextLine(filmId),
  });

  // A deliberate edit on top of the older take: same words, same picture, different cut.
  await card(filmId).locator("[data-prompt]").click();
  await card(filmId).locator("[data-prompt]").fill("cut three: same take, nearer still");
  await card(filmId).locator("[data-prompt]").blur();
  await page.waitForTimeout(400);
  await press(filmId);
  const cut3 = expectTake("the third cut", await settle(filmId));
  const cut3Facts = filmFacts(cut3, cut3.versions[0].sources.find(s => s.type === "audio").file);
  note("film take 3", { error: cut3.error, promptUsed: cut3.promptUsed, sources: cut3.sources, kept: cut3.versions.map(v => ({ artifact: v.artifact, prompt: v.prompt })), facts: cut3Facts });
  out.films.push({ step: "cut three", ...cut3Facts });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, "5-cut-three.png") });

  // The kept films are three different, playable things, and the card says its own
  // material after a reload, so nothing here is a session artifact.
  await page.reload();
  await page.waitForSelector(`.card[data-id="${filmId}"] .sources`);
  const after = (await ws()).nodes[filmId];
  const played = [after.artifact, ...after.versions.map(v => v.file)].map(f => {
    const file = nodeDir(filmId, f);
    const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" }));
    return {
      file, bytes: statSync(file).size,
      seconds: Math.round(Number(probe.format.duration) * 100) / 100,
      streams: probe.streams.map(s => `${s.codec_type}:${s.codec_name}`),
    };
  });
  note("after reload", {
    artifact: after.artifact, promptUsed: after.promptUsed,
    madeFrom: await card(filmId).locator(".sources").innerText(),
    next: await nextLine(filmId),
    kept: after.versions.map(v => ({ artifact: v.artifact, prompt: v.prompt, sources: (v.sources || []).map(s => ({ id: s.id, artifact: s.artifact, copy: s.file })) })),
  });

  // Taking the cuts out of the canvas. Every take of one card is titled `film.mp4`, so
  // three downloads used to arrive with three identical names, told apart only by the
  // order they were saved in - which is how the wrong cut gets sent to someone. Each take
  // is downloaded here, oldest first, and the suggested name has to say which take it is.
  // Reported by an operator who tried exactly this after the first cut of this slice. Each
  // kept take is reached through its own version button, labelled with the take it restores
  // (`v1`, `v2`), so the loop asserts against a label a person reads rather than a guess
  // about which take a prompt belongs to.
  const exports = [];
  const download = async label => {
    const [saved] = await Promise.all([
      page.waitForEvent("download"),
      card(filmId).locator("[data-download]").click(),
    ]);
    exports.push({ restoredThrough: label, suggested: saved.suggestedFilename() });
    await saved.cancel();
  };
  const labels = await card(filmId).locator("[data-version]").allInnerTexts();
  await download("the take on the card");
  for (const label of labels) {
    await card(filmId).locator("[data-version]", { hasText: label }).first().click();
    // Wait on the record, which is what the download is built from, rather than on the
    // title bar: an earlier version of this parsed `.meta` with a regular expression and
    // the escape for a word boundary was eaten by the template literal, so the wait could
    // never match and the story timed out on a restore that had in fact worked.
    for (let i = 0; i < 200; i++) {
      const now = (await ws()).nodes[filmId];
      if ((now.artifact || "").includes(`${label}-`)) break;
      await page.waitForTimeout(50);
    }
    const restoredTo = (await ws()).nodes[filmId].artifact;
    assert.ok((restoredTo || "").includes(`${label}-`), `pressing ${label} did not put that take on the card; it shows ${restoredTo}`);
    await download(label);
  }
  // Each download names the take that was on screen when the button was pressed.
  const newest = (after.artifact.match(/v([0-9]+)-/) || [])[1];
  for (const e of exports) {
    const wanted = e.restoredThrough === "the take on the card" ? `v${newest}` : e.restoredThrough;
    e.expected = wanted;
    assert.ok(e.suggested.includes("-" + wanted), `after restoring ${e.restoredThrough} the file downloads as ${e.suggested}, which does not name ${wanted}`);
  }
  note("exported cuts", exports);
  note("every kept film plays", played);
  // And the card's own preview - the thing a person presses on - plays the take it shows.
  const preview = await card(filmId).locator(".preview video").evaluate(async v => {
    v.muted = true;
    await v.play().catch(() => {});
    await new Promise(r => setTimeout(r, 900));
    const fact = { duration: Number.isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : null, at: Math.round(v.currentTime * 100) / 100, paused: v.paused, error: v.error && v.error.code, src: decodeURIComponent(v.currentSrc.split("path=")[1] || "") };
    v.pause();
    return fact;
  });
  note("the card's preview plays", preview);
  note("page errors", errors);

  // ---- What the story has to have proved, stated so a later run fails loudly ----
  // Each film is a real h264 file with a real AAC track that is this take's narration.
  for (const film of out.films) {
    assert.equal(film.codec, "h264", `${film.step} is not an h264 film: ${film.codec}`);
    assert.equal(film.audioCodec, "aac", `${film.step} carries no AAC track: ${film.audioCodec}`);
    assert.ok(film.seconds > 2.5, `${film.step} is ${film.seconds}s, shorter than the narration it carries`);
    assert.ok(film.peak > 3000 && film.nonzero > 20000, `${film.step} sounds silent or near-silent (peak ${film.peak}, ${film.nonzero} non-zero samples)`);
    assert.ok(film.agreement >= 0.8, `${film.step}'s embedded track is not the narration it records (agreement ${film.agreement} at lag ${film.lagSamples})`);
    assert.ok(Math.abs(film.lagSamples) <= 2205, `${film.step}'s sound starts ${film.lagMs} ms away from where the narration would put it`);
    if (film.againstOtherTake !== null) {
      assert.ok(film.againstOtherTake <= 0.3, `${film.step} would also pass against another take's narration (${film.againstOtherTake}), so the check cannot tell them apart`);
    }
  }
  // The difference between cut one and cut two is real: different words, different picture.
  const [one, two, three] = out.films;
  assert.notEqual(one.narration.copy, two.narration.copy, "cut two was not made from a different narration");
  assert.notEqual(one.artifact, two.artifact, "the two cuts are the same file");
  // Cut three continues cut one on purpose: the same words and picture, a different instruction.
  assert.equal(three.narration.artifact, one.narration.artifact, `cut three was meant to reuse cut one's narration, got ${three.narration.artifact} vs ${one.narration.artifact}`);
  assert.notEqual(three.artifact, one.artifact, "cut three overwrote cut one instead of publishing beside it");
  for (const film of [one, two, three]) {
    assert.ok(statSync(nodeDir(filmId, film.artifact)).size > 0, `${film.step} has no bytes on disk`);
    assert.ok(existsSync(nodeDir(filmId, film.narration.copy)), `${film.step}'s frozen narration ${film.narration.copy} is not beside it`);
  }
  assert.equal(new Set([one.artifact, two.artifact, three.artifact]).size, 3, "the three cuts are not three separate films");
  // Every kept take names the material it froze, so a reopened card can still explain itself.
  assert.equal(after.versions.length, 2, `the card kept ${after.versions.length} earlier takes, expected 2`);
  for (const kept of after.versions) {
    assert.ok(kept.sources.some(s => s.type === "audio" && s.file), `kept take ${kept.artifact} records no frozen narration`);
    assert.equal(typeof kept.prompt, "string", `kept take ${kept.artifact} records no instruction`);
  }
  // The two compare panes named the material they were each made from, and disagreed
  // exactly because the material changed between the takes.
  const versionTag = text => (text.match(/\(v[0-9]+\)/) || [""])[0];
  const left = panes.map(p => p.caption).find(c => /on the card/.test(c));
  const right = panes.map(p => p.caption).find(c => /kept v/.test(c));
  assert.ok(left && right, `both compare panes were captioned: ${JSON.stringify(panes)}`);
  assert.notEqual(versionTag(left), versionTag(right), `the two panes named the same material version: ${left} | ${right}`);
  // Each pane, played on its own, is a film that really runs - and the two hand over, so
  // the panel answers "which of these two takes do I want" in sound as well as picture.
  assert.equal(playedPanes.length, 2, `the compare panel showed ${playedPanes.length} players`);
  for (const pane of playedPanes) {
    assert.ok(pane.duration > 2.5, `a compare pane reported duration ${pane.duration}`);
    assert.ok(pane.at > 0.4, `a compare pane did not advance when played on its own (at ${pane.at}s)`);
    assert.equal(pane.error, null, `a compare pane failed to decode: media error ${pane.error}`);
  }
  assert.ok(takeover.left.at > 0.2, `the pane that was handed the sound did not advance (at ${takeover.left.at}s)`);
  assert.ok(preview.at > 0.3, `the card's own preview did not play (at ${preview.at}s)`);
  // Compared with the card as it stands *now*: the export loop deliberately ended on an
  // older take, so the record read before it is no longer what the card shows.
  const nowShown = (await ws()).nodes[filmId].artifact;
  assert.ok(preview.src.endsWith(nowShown), `the card previewed ${preview.src}, not the take it shows (${nowShown})`);
  assert.ok(nowShown.endsWith("v1-film.mp4"), `the export loop left the card on ${nowShown}, expected the v1 take it restored last`);
  // Three kept cuts, three filenames, each saying which take it is, none losing its extension.
  assert.equal(exports.length, 3, `downloaded ${exports.length} takes, expected 3`);
  assert.equal(new Set(exports.map(e => e.suggested)).size, 3, `the exported cuts shared a filename: ${JSON.stringify(exports)}`);
  for (const e of exports) assert.ok(e.suggested.endsWith(".mp4"), `${e.restoredThrough} downloads as ${e.suggested}, losing its extension`);
  console.log("assertions: all passed");
  out.workdir = workdir; out.shots = shots; out.serverLog = log.join("").slice(-4000);
  if (errors.length) throw new Error(`the canvas raised: ${errors.join(" | ")}`);
} finally {
  writeFileSync(join(shots, "receipt.json"), JSON.stringify(out, null, 2));
  await page?.close();
  await browser.close();
  stopServer(app); stopAll();
  console.log("receipt:", join(shots, "receipt.json"), "shots:", shots, "workspace:", workdir);
}
