import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { browserPath, launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";
import { wavStats } from "./wav.mjs";
import { CURRENT_READINGS } from "../voice/lexicon.mjs";

// The slice a person actually asked for: a line of text on one card, a narration of it on
// the next, and a film that carries that voice.
//
// The stand-ins here are honest about what they stand in for. The narration agent really runs
// `voice/render.mjs` and really runs the `--check`, so the WAV is the shipped voice's output
// - the only invented part is the choice of which words to read, which is fixed so the test
// can name them. The film is really rendered by Remotion from that WAV.
//
// Each assertion below exists because something cheaper passed while the result was wrong:
//   * a text input could be linked and empty, giving an agent `artifact: (none)` and a film
//     of nothing - the chain asserts the text is in the prompt *and* in the audio;
//   * a WAV file, a timeline and a claim in a JSON are all things an agent can produce
//     without speaking, so the film's embedded track is extracted and measured with the same
//     judge a person would use;
//   * a reopened workspace used to forget how a film was made, so the card's provenance and
//     the measured narration are read after a real restart, not just after a reload.
const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-narration-")), bin = join(base, "codex");
// One stand-in binary, dispatching on the node's type: text is written by a trivial agent,
// audio is narrated with the real CLI, video is rendered by Remotion.
writeFileSync(bin, `#!/bin/sh
case "$HYPERMAKER_NODE_TYPE" in
  text) exec node ${JSON.stringify(join(root, "test/fake-narration-text-codex.mjs"))} "$@" ;;
  audio) exec node ${JSON.stringify(join(root, "test/fake-narration-codex.mjs"))} "$@" ;;
  *) exec node ${JSON.stringify(join(root, "test/fake-film-codex.mjs"))} "$@" ;;
esac
`);
chmodSync(bin, 0o755);

const chrome = browserPath();
const skip = existsSync(chrome) ? null : `no browser for Remotion or the canvas (set HYPERMAKER_CHROME); looked at ${chrome}`;
const ff = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");

const SCRIPT = "The sea at night is never still.\nIt carries every colour of the sky.";

function peakOf(file, scratch) {
  const out = join(scratch, "extracted.wav");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "44100", out]);
  return { peak: wavStats(out).peak, file: out };
}

let app, browser, port, workdir;
before(async () => {
  if (skip) return;
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
async function settle(id, tries = 1200) {
  let node;
  for (let i = 0; i < tries; i++) {
    node = (await workspace()).nodes[id];
    if (node?.artifact || node?.error) return node;
    await new Promise(r => setTimeout(r, 250));
  }
  return node;
}

test("canvas text becomes a narration that measures as speech, and a film that carries it", async t => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack || String(error)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.querySelector("#cards"));
  const generate = async id => {
    await page.waitForSelector(`.card[data-id="${id}"] [data-generate]`);
    await page.locator(`.card[data-id="${id}"] [data-generate]`).click();
    return settle(id);
  };

  // 1. A text card holding the words. It is generated for real so the material has bytes on
  //    disk and a name the narration prompt can name.
  const textId = Number(Object.keys((await post("/api/node", { x: 60, y: 60, type: "text", method: "llm", prompt: SCRIPT, quality: "demo" })).nodes).at(-1));
  await page.reload({ waitUntil: "load" });
  const textNode = await generate(textId);
  assert.equal(textNode.error, null, `the text card was written, got ${textNode.error}`);
  assert.equal(readFileSync(join(workdir, String(textId), textNode.artifact), "utf8").trim(), SCRIPT, "the text card holds the line");

  // 2. An audio card on the *default* method, which is now narration. Asserting the default
  //    is the point: a person who adds an audio card next to text should not have to know a
  //    method name to hear it.
  const created = await post("/api/node", { x: 420, y: 60, type: "audio", prompt: "read the text card aloud", quality: "demo" });
  const narrationId = Number(Object.keys(created.nodes).at(-1));
  assert.equal(created.nodes[narrationId].method, "narration", "a new audio card starts on the offline voice");
  await post("/api/link", { source: textId, target: narrationId });
  await page.reload({ waitUntil: "load" });

  const spoken = await generate(narrationId);
  assert.equal(spoken.error, null, `the narration was published, got ${spoken.error}`);
  assert.match(spoken.artifact, /^versions\/v\d+-narration\.wav$/, "the WAV was published under a versioned name");

  // 3. The published bytes are speech, measured here the same way a listener would judge it.
  const wav = join(workdir, String(narrationId), spoken.artifact);
  const checkReport = JSON.parse(execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--check", wav, "--words", SCRIPT.replace(/\n/g, " ")], { encoding: "utf8" }));
  assert.equal(checkReport.verdict, "speech", `the published WAV is speech, problems: ${checkReport.problems.join("; ")}`);
  assert.equal(checkReport.syllables, 19, "the sentence has 19 syllables, which is the count the check uses");
  assert.ok(checkReport.onsets >= checkReport.syllables, `a rise per syllable, got ${checkReport.onsets}`);
  assert.ok(checkReport.vowelKinds >= 5, `the voice moves between vowels, got ${checkReport.vowelKinds} regions`);

  // 4. The card says what was measured, and where each phrase starts. This is the part that
  //    makes the take checkable tomorrow rather than only believable today.
  const narrationLine = await page.locator(`.card[data-id="${narrationId}"] .narration`).textContent();
  assert.match(narrationLine, /narration: 5\.\d+s, 14 words, \d+ syllable onsets/, `the card reports its measurement, got ${narrationLine}`);
  assert.match(narrationLine, /measured speech/, "and the verdict it earned");
  // This take's record is exact, so it carries no rounding note. The other side - a rounded
  // record showing the samples it was realigned by - is covered in `test/bind.test.mjs`, which
  // can build that take directly; asserting it is absent here is what keeps the note from
  // appearing on every card as noise.
  assert.doesNotMatch(narrationLine, /start times rounded/, `an exact record must not claim its starts were rounded, got ${narrationLine}`);
  const narrationTitle = await page.locator(`.card[data-id="${narrationId}"] .narration`).getAttribute("title");
  assert.match(narrationTitle, /0\.00s {2}The sea at night is never still\./, `the tooltip says when the first phrase starts, got ${narrationTitle}`);
  assert.match(narrationTitle, /2\.\d+s {2}It carries every colour of the sky\./, "and when the second does");

  // 4b. Hearing one sentence instead of the whole take. A creator checking a take has
  //     usually changed one line, and the sentence they want is often not the first one -
  //     so the card has to be able to start the player at a measured phrase. The times come
  //     from the server's measurement of the published bytes, so this also checks that the
  //     card and the record agree about where each sentence is.
  //
  //     A click is not enough to prove it: a button that looked right and did nothing would
  //     pass. The assertion is on the player's own clock after the click, and on the fact
  //     that it stops at the end of that phrase rather than continuing into the next.
  const chips = page.locator(`.card[data-id="${narrationId}"] [data-phrase]`);
  assert.equal(await chips.count(), 2, "one button per phrase of the take");
  assert.equal(await chips.nth(1).textContent(), "2", "the buttons are numbered in the order spoken");
  const record = spoken.narration.phrases;
  assert.equal(record.length, 2, "the take's record has both phrases");
  await page.waitForFunction(() => {
    const a = document.querySelector(".preview audio");
    return a && a.readyState >= 1;
  }, null, { timeout: 20000 });
  // The *first* phrase is the one that proves the stop: it ends in the middle of the file, so
  // a player that merely seeked and went on playing would run past it into sentence two. The
  // second button is checked for the seek, since starting a later sentence is the case the
  // tooltip times could not help with.
  await chips.nth(0).click();
  await page.waitForFunction(() => {
    const a = document.querySelector(".preview audio");
    return a && !a.paused;
  }, null, { timeout: 10000 });
  const startedAt = await page.evaluate(() => document.querySelector(".preview audio").currentTime);
  assert.ok(startedAt <= record[0].start + 0.3, `the first sentence starts at its recorded ${record[0].start}s, player was at ${startedAt.toFixed(2)}s`);
  // The mark is derived from the player, so it can arrive a frame after `paused` flips; what
  // matters is that it arrives, and that it is the sentence the clock is actually in.
  await page.waitForFunction(() => document.querySelectorAll("[data-phrase][data-playing]").length === 1, null, { timeout: 5000 });
  assert.notEqual(await chips.nth(0).getAttribute("data-playing"), null, "the button shows which sentence is playing");
  const end = record[0].start + record[0].duration;
  // A frame is ~16 ms, so the pause should land within a frame or two of the recorded end.
  // The old `timeupdate` watch let it run a quarter second into the next sentence, which is
  // what first made this fail - the window here is deliberately tighter than that.
  await page.waitForFunction(
    seconds => { const a = document.querySelector(".preview audio"); return a && a.paused && a.currentTime <= seconds + 0.15; },
    end, { timeout: 20000 });
  const stopped = await page.evaluate(() => ({ at: document.querySelector(".preview audio").currentTime, duration: document.querySelector(".preview audio").duration }));
  assert.ok(stopped.at >= end - 0.2 && stopped.at <= end + 0.15, `it stops at the end of the first sentence (${end.toFixed(2)}s), stopped at ${stopped.at.toFixed(2)}s`);
  assert.ok(stopped.at < stopped.duration - 0.5, `and that is before the end of the file (${stopped.duration.toFixed(2)}s), so it really stopped rather than finished`);
  assert.equal(await chips.nth(0).getAttribute("data-playing"), null, "and the playing mark is gone when it stops");
  // The second button starts the second sentence where its record says - the case a person
  // actually has, a line that is not the first one.
  await chips.nth(1).click();
  await page.waitForFunction(() => {
    const a = document.querySelector(".preview audio");
    return a && !a.paused;
  }, null, { timeout: 10000 });
  const secondStart = await page.evaluate(() => document.querySelector(".preview audio").currentTime);
  assert.ok(secondStart >= record[1].start - 0.3, `the second sentence starts where its record says (${record[1].start}s), player was at ${secondStart.toFixed(2)}s`);
  // Pausing the way a person does - with the player's own control - must clear the mark too. A
  // supervisor reproduced the opposite: play sentence 2, pause in the player, and the chip
  // stayed lit while the clock sat still, so the card claimed a sentence was playing when
  // nothing was. The cause was that the mark was remembered from the last press instead of read
  // back out of the player; this is the assertion that keeps it derived.
  await page.evaluate(() => document.querySelector(".preview audio").pause());
  await page.waitForFunction(() => document.querySelectorAll("[data-phrase][data-playing]").length === 0, null, { timeout: 5000 });
  const paused = await page.evaluate(() => ({ at: document.querySelector(".preview audio").currentTime, paused: document.querySelector(".preview audio").paused }));
  assert.equal(paused.paused, true, "the player really is paused");
  assert.equal(await chips.nth(1).getAttribute("data-playing"), null, "a paused player lights no sentence: the mark means 'playing now', not 'where you left off'");
  // ...and it must stay that way, which is what the supervisor saw as "progress does not move":
  // a second look a moment later must not drift back into a playing state on its own.
  await page.waitForTimeout(500);
  const later = await page.evaluate(() => ({ at: document.querySelector(".preview audio").currentTime, playing: document.querySelectorAll("[data-phrase][data-playing]").length }));
  assert.equal(later.at, paused.at, "a paused player does not move");
  assert.equal(later.playing, 0, "and nothing on the card claims it is playing");
  // Playing again from the player's own button lights the sentence the clock is in - the same
  // reading, in the other direction, so the card follows a person who never touches a chip.
  await page.evaluate(() => document.querySelector(".preview audio").play());
  await page.waitForFunction(() => document.querySelectorAll("[data-phrase][data-playing]").length === 1, null, { timeout: 5000 });
  assert.equal(await chips.nth(1).getAttribute("data-playing"), "", "playing the player again lights the sentence it is in");
  await page.evaluate(() => document.querySelector(".preview audio").pause());
  // A listen must not cost a generation: the artifact and its record are untouched by it.
  const afterListen = (await workspace()).nodes[narrationId];
  assert.equal(afterListen.artifact, spoken.artifact, "listening to a phrase did not change the take");
  assert.deepEqual(afterListen.narration.phrases, record, "nor its recorded timings");
  assert.ok(errors.length === 0, `no page errors while listening: ${errors.join(" | ")}`);

  // 5. A film card takes the narration as material and really contains that sound.
  const filmId = Number(Object.keys((await post("/api/node", { x: 780, y: 120, type: "video", method: "remotion", prompt: "one film over the narration", quality: "demo" })).nodes).at(-1));
  await post("/api/link", { source: narrationId, target: filmId });
  await page.reload({ waitUntil: "load" });
  const film = await generate(filmId);
  assert.equal(film.error, null, `the film rendered, got ${film.error}`);

  const filmFile = join(workdir, String(filmId), film.artifact);
  const bytes = readFileSync(filmFile);
  assert.equal(bytes.subarray(4, 8).toString("latin1"), "ftyp", "the film is an ISO base media file");
  assert.ok(bytes.includes(Buffer.from("mp4a")), "and declares an audio track");
  // The decisive check is not the track's presence but its content: extract what is really in
  // the container and measure *that*, so a track of silence cannot pass.
  const { peak, file: extracted } = peakOf(filmFile, base);
  assert.ok(peak > 1000, `the film's audio is audible, not a silent track (peak ${peak})`);
  const filmReport = JSON.parse(execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--check", extracted, "--words", SCRIPT.replace(/\n/g, " ")], { encoding: "utf8" }));
  assert.equal(filmReport.verdict, "speech", `the film's own soundtrack is speech, problems: ${filmReport.problems.join("; ")}`);
  assert.ok(filmReport.seconds > 5.5, `the film carries the whole narration, got ${filmReport.seconds.toFixed(2)}s`);

  // 6. The film can be played on the canvas, for at least as long as the voice lasts.
  await page.waitForFunction(() => {
    const video = document.querySelector(".preview video");
    return video && video.readyState >= 1 && video.duration > 0;
  }, null, { timeout: 30000 });
  const shown = await page.evaluate(() => document.querySelector(".preview video").duration);
  assert.ok(shown > 5.5, `the player sees the whole film, got ${shown}`);

  // 7. Reopening: stop the server so the workspace is read back from disk, and check the
  //    film still says what it was made from - and that the narration still carries its
  //    measurement. A reload alone would leave the in-memory graph in place and prove
  //    nothing about what a person sees the next day.
  stopServer(app);
  await new Promise(r => setTimeout(r, 500));
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "0", HYPERMAKER_PROJECT: root } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(`.card[data-id="${filmId}"]`);
  await page.waitForTimeout(800);
  const filmSources = await page.locator(`.card[data-id="${filmId}"] .sources`).textContent();
  assert.match(filmSources, new RegExp(`#${narrationId} audio`), `the film names the narration card, got ${filmSources}`);
  assert.match(filmSources, /narration\.wav/, "and the file it was made from");
  const reopened = await page.locator(`.card[data-id="${narrationId}"] .narration`).textContent();
  assert.match(reopened, /\d+ syllable onsets, \d+ vowel regions, measured speech/, `the narration's evidence outlives the restart, got ${reopened}`);
  // The same numbers the card showed before the restart, not merely a line that looks similar:
  // a record that survives as a stale copy would be as bad as one that vanished.
  assert.equal(reopened, narrationLine, "the reopened card reports the same measurement it did before");
  // And the correspondence the reviewer asked for: the reopened card says which card was
  // read and that the bytes agree with the words. Without these, a restart could keep a
  // measurement that no longer described anything a person can check.
  assert.match(reopened, new RegExp(`read from #${textId}`), `the reopened narration names the card it read, got ${reopened}`);
  assert.match(reopened, /matched 1\.000/, `and says the audio was re-rendered from its script, got ${reopened}`);

  // 8. The take can be re-verified *from disk*, which is what `voice/verify-take.mjs` is for.
  //    Before this, it could not: the timeline lived only in the attempt directory, which is
  //    dropped as soon as the run succeeds, and the published WAV is under `versions/` - so the
  //    command answered "no WAV" for a take the canvas was playing. Found by running it against
  //    a real workspace, not by reading the code. The first attempt at the fix copied the
  //    timeline and the sweep in `pruneVersions` deleted it again moments later as
  //    unreferenced, which is why this asserts on the file *after* a restart.
  const nodeDir = join(workdir, String(narrationId));
  const takeFile = join(nodeDir, spoken.artifact);
  const timelineFile = takeFile.replace(/\.wav$/i, ".timeline.json");
  assert.ok(existsSync(timelineFile), `the published take keeps its own timeline, looked for ${timelineFile}`);
  const verified = execFileSync(process.execPath, [join(root, "voice/verify-take.mjs"), nodeDir], { encoding: "utf8" });
  assert.match(verified, /^verifies: /, `the published card re-verifies from disk, got ${verified}`);
  assert.match(verified, /worst-frame agreement with the words: 1\.000/, "and does so exactly, not approximately");
  assert.match(verified, new RegExp(`reading table: ${CURRENT_READINGS}`), "and names the voice that made it");

  assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);

  // 9. The creator's actual loop, on the same card: change one line, generate again, and keep
  //    both takes. Then hear *that line* in either take without regenerating anything. This is
  //    the path the assignment is about - listen cheaply, change a sentence, keep what worked -
  //    and the phrase buttons are only useful if they follow the take the card is showing.
  const changed = SCRIPT.replace("never still", "never silent");
  await page.locator(`.card[data-id="${textId}"] [data-prompt]`).fill(changed);
  await page.locator(`.card[data-id="${textId}"] [data-prompt]`).blur();
  await page.waitForTimeout(600);
  // `settle` returns as soon as a node *has* an artifact, which the old take already does -
  // so a second run has to be waited for by asking for a different one. Otherwise the check
  // reads the first take a moment after pressing Generate and calls it the second.
  const settled = async (id, notThis) => { for (let i = 0; i < 1200; i++) { const n = (await workspace()).nodes[id]; if ((n?.artifact && n.artifact !== notThis) || n?.error) return n; await new Promise(r => setTimeout(r, 250)); } };
  await page.locator(`.card[data-id="${textId}"] [data-generate]`).click();
  const textAgain = await settled(textId, textNode.artifact);
  assert.equal(textAgain.error, null, `the edited text card was written, got ${textAgain.error}`);
  await page.locator(`.card[data-id="${narrationId}"] [data-generate]`).click();
  const second = await settled(narrationId, spoken.artifact);
  assert.equal(second.error, null, `the second take was published, got ${second.error}`);
  assert.notEqual(second.artifact, spoken.artifact, "the second take is a different file, so the first is still there");
  assert.match(second.narration.phrases[0].text, /never silent/, `the new take says the new line, got ${second.narration.phrases[0].text}`);
  // Both takes are kept, and the card offers a way back to the first one.
  const kept = (await workspace()).nodes[narrationId].versions || [];
  assert.ok(kept.length >= 1, `the replaced take was kept, got ${JSON.stringify(kept.map(v => v.artifact))}`);
  const firstVersion = kept.find(v => v.narration && /v1-/.test(v.artifact || v.file || ""));
  assert.ok(firstVersion, `the kept version carries the measurement of its own take, got ${JSON.stringify(kept.map(v => [v.artifact, !!v.narration]))}`);
  assert.match(firstVersion.narration.phrases[0].text, /never still/, "and the kept version's record is of the words *it* says, not of the newer take");
  // Hear the first take's opening sentence again, from the card, after going back to it.
  await page.locator(`.card[data-id="${narrationId}"] [data-version="${firstVersion.id}"]`).click();
  await page.waitForFunction(
    id => { const a = document.querySelector(`.card[data-id="${id}"] .preview audio`); return a && /v1-/.test(a.getAttribute("src") || ""); },
    narrationId, { timeout: 15000 });
  await page.waitForFunction(() => { const a = document.querySelector(".preview audio"); return a && a.readyState >= 1; });
  const restoredChips = page.locator(`.card[data-id="${narrationId}"] [data-phrase]`);
  assert.equal(await restoredChips.count(), 2, "the take on the card still offers its sentences");
  const restoredTitle = await restoredChips.nth(0).getAttribute("title");
  assert.match(restoredTitle, /never still/, `the button describes the restored take's own words, got ${restoredTitle}`);
  await restoredChips.nth(0).click();
  await page.waitForFunction(() => { const a = document.querySelector(".preview audio"); return a && !a.paused; }, null, { timeout: 10000 });
  const restoredAt = await page.evaluate(() => document.querySelector(".preview audio").currentTime);
  assert.ok(restoredAt <= 0.3, `the restored take plays from its own start, player was at ${restoredAt.toFixed(2)}s`);
  await page.evaluate(() => document.querySelector(".preview audio").pause());
  // And the last thing a person checks: the restored card still verifies, and says which take it
  // is. A kept version that plays but cannot be re-verified would be a recording with no record.
  const restoredNode = (await workspace()).nodes[narrationId];
  assert.match(restoredNode.artifact || "", /v1-/, `the card is showing the first take, got ${restoredNode.artifact}`);
  const reverified = execFileSync(process.execPath, [join(root, "voice/verify-take.mjs"), join(workdir, String(narrationId))], { encoding: "utf8" });
  assert.match(reverified, /^verifies: /, `the restored take re-verifies from disk, got ${reverified}`);
  assert.match(reverified, /this is the take the card is showing/, `and names itself as the one on the card, got ${reverified}`);

  assert.deepEqual(errors, [], `no page errors, got ${errors.join(" | ")}`);
  await page.close();
});

test("a real recording of the wrong words is refused, so the card cannot play one sentence and write another", async t => {
  // The reviewer's report, end to end through the server: an audio card that really runs the
  // shipped renderer, but speaks a different sentence of the same length. Every file-level
  // property holds - it is the voice, it measures as speech, the timeline is contiguous and
  // matches the duration - and the card used to publish it over the material it was given.
  if (skip) return t.skip(skip);
  const wrong = join(base, "wrong-codex.mjs");
  writeFileSync(wrong, `
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR, root = process.env.HYPERMAKER_PROJECT;
// The reviewer's shape: a real recording of the card's own words, published beside a timeline
// left over from a different take. Both files are genuine; they are simply not the same take.
const script = join(dir, "script.txt");
writeFileSync(script, "Open the blue door.\\nClose the red gate.");
execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", script, "--out", join(dir, "narration.wav"), "--timeline", join(dir, "timeline.json")], { stdio: "inherit" });
// Same length to the sample, different sentence: duration cannot tell them apart.
const borrowed = join(dir, "borrowed.txt");
writeFileSync(borrowed, "Open the red gate.\\nClose the blue door.");
execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", borrowed, "--out", join(dir, "borrowed.wav"), "--timeline", join(dir, "timeline.json")], { stdio: "inherit" });
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (out) writeFileSync(out, JSON.stringify({ prompt: "read it", script, artifact: join(dir, "narration.wav"), type: "audio", method: "narration", error: null }));
`);
  const port3 = await freePort(), workdir3 = join(base, "ws-wrong"), binPath3 = join(base, "wrong");
  // The text card is written by the ordinary stand-in; only the audio card misbehaves. A
  // single binary for both would have the material card produce a WAV.
  writeFileSync(binPath3, `#!/bin/sh\ncase "$HYPERMAKER_NODE_TYPE" in\n  text) exec node ${JSON.stringify(join(root, "test/fake-narration-text-codex.mjs"))} "$@" ;;\n  *) exec node ${JSON.stringify(wrong)} "$@" ;;\nesac\n`); chmodSync(binPath3, 0o755);
  const app3 = startServer({ cwd: root, port: port3, env: { CODEX_BIN: binPath3, HYPERMAKER_WORKDIR: workdir3, HYPERMAKER_RESET_WORKSPACE: "1", HYPERMAKER_PROJECT: root } });
  try {
    await waitReady(port3);
    const create = (path, body) => fetch(`http://127.0.0.1:${port3}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
    // The material: a real text card, generated through the same route a person uses, so the
    // frozen copy the narration reads is the one the harness actually makes. Writing the file
    // by hand and setting `artifact` skipped the copy, and the check then read the fallback
    // prompt instead - the failure that made this case assert the wrong thing.
    const material = "Open the blue door. Close the red gate.";
    const madeText = await create("/api/node", { x: 10, y: 10, type: "text", method: "llm", prompt: material, quality: "demo" });
    const tid = Number(Object.keys(madeText.nodes).at(-1));
    await create("/api/generate", { id: tid });
    let textNode;
    for (let i = 0; i < 200; i++) {
      textNode = (await fetch(`http://127.0.0.1:${port3}/api/workspace`).then(r => r.json())).nodes[tid];
      if (textNode?.artifact || textNode?.error) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.match(textNode.artifact || "", /lines\.txt$/, `the material card was written, got ${textNode.artifact} / ${textNode.error}`);
    const made = await create("/api/node", { x: 300, y: 10, type: "audio", method: "narration", quality: "demo", prompt: "read it", inputs: [tid] });
    const id = Number(Object.keys(made.nodes).at(-1));
    await create("/api/generate", { id });
    let node;
    for (let i = 0; i < 400; i++) {
      node = (await fetch(`http://127.0.0.1:${port3}/api/workspace`).then(r => r.json())).nodes[id];
      if (node?.artifact || node?.error) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(node.artifact, null, "a take whose words and audio came from different recordings was published");
    assert.match(node.error || "", /not a narration/, `the card says the take was refused, got ${node.error}`);
    // The decisive check: both files are real speech of the card's own words, so only the
    // rebind can tell that the sentence now written on the card was recorded by another take.
    // Duration, syllable count and pronunciation all agree; the signal does not.
    assert.match(node.error, /not the sound this voice makes from those words/, `and says the audio is not its script, got ${node.error}`);
    assert.equal(node.narration, null, "no evidence was recorded for a refused take");
  } finally { stopServer(app3); stopAll(); }
});

test("a narration that does not measure as speech is refused, and the card says why", async t => {
  // The other direction, and the reason the server check exists at all: an agent that writes
  // a plausible timeline next to a file of noise must not get a card that plays a hiss under a
  // sentence. This stand-in is the one a real agent becomes when it renders badly.
  if (skip) return t.skip(skip);
  const liar = join(base, "liar-codex.mjs");
  writeFileSync(liar, `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR;
// A perfect WAV of a pure tone, with a timeline that describes a spoken sentence of the
// same length. Every file-level check except measuring the audio would pass.
const rate = 22050, seconds = 2, frames = rate * seconds, samples = Buffer.alloc(frames * 2);
for (let i = 0; i < frames; i++) samples.writeInt16LE(Math.round(0.5 * 32767 * Math.sin(2 * Math.PI * 220 * i / rate)), i * 2);
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + samples.length, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(samples.length, 40);
writeFileSync(join(dir, "narration.wav"), Buffer.concat([header, samples]));
writeFileSync(join(dir, "timeline.json"), JSON.stringify({ phrases: [{ text: "The sea at night is never still.", start: 0, duration: seconds }] }));
writeFileSync(join(dir, "make.mjs"), "// tone\\n");
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (out) writeFileSync(out, JSON.stringify({ prompt: "read it", script: "make.mjs", artifact: "narration.wav", type: "audio", method: "narration", error: null }));
`);
  const port2 = await freePort(), workdir2 = join(base, "ws-liar"), binPath = join(base, "liar");
  writeFileSync(binPath, `#!/bin/sh\nexec node ${JSON.stringify(liar)} "$@"\n`); chmodSync(binPath, 0o755);
  const app2 = startServer({ cwd: root, port: port2, env: { CODEX_BIN: binPath, HYPERMAKER_WORKDIR: workdir2, HYPERMAKER_RESET_WORKSPACE: "1" } });
  try {
    await waitReady(port2);
    const create = (path, body) => fetch(`http://127.0.0.1:${port2}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
    const made = await create("/api/node", { x: 10, y: 10, type: "audio", method: "narration", quality: "demo", prompt: "read it" });
    const id = Number(Object.keys(made.nodes).at(-1));
    await create("/api/generate", { id });
    let node;
    for (let i = 0; i < 400; i++) {
      node = (await fetch(`http://127.0.0.1:${port2}/api/workspace`).then(r => r.json())).nodes[id];
      if (node?.artifact || node?.error) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(node.artifact, null, "nothing was published");
    assert.match(node.error || "", /not a narration/, `the card says what failed, got ${node.error}`);
    // The reason is now the correspondence, caught before the acoustic judge could run:
    // these bytes are not the recording the timeline claims, and the words are not in the
    // material either. Both are named, because a person fixing this needs to know which
    // one to fix. Naming only "not speech" would have been true and less useful.
    assert.match(node.error, /not that recording|not the sound this voice makes from those words|not in the material/, `and names the check that failed, got ${node.error}`);
    assert.equal(node.narration, null, "no evidence was recorded for a take that was not speech");
    // The refused take is not reachable from the canvas at all: the attempt directory is
    // kept for inspection, but nothing was published into `versions/`, so there is no file a
    // person could mistake for a result.
    const published = existsSync(join(workdir2, String(id), "versions")) ? readdirSync(join(workdir2, String(id), "versions")).filter(f => f.endsWith(".wav")) : [];
    assert.deepEqual(published, [], `no WAV was published, got ${published}`);
  } finally { stopServer(app2); stopAll(); }
});

test("an honest agent that picks its own speed and pitch still publishes, and the card can say what was recorded", async t => {
  // The reviewer's third report. `voice/render.mjs --rate 1.23456 --pitch 113.45678` used to
  // write a timeline recording `1.235` / `113.457`, so the server re-rendered at a slightly
  // different speed and refused an honest take on its third phrase. The take here is produced
  // by the same stand-in agent as the approved path, with only the extra parameters added, so
  // nothing about it is special except the numbers - which is exactly the point.
  if (skip) return t.skip(skip);
  const port4 = await freePort();
  const workdir4 = join(base, "ws-nonround");
  const app4 = startServer({
    cwd: root, port: port4,
    env: {
      CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir4, HYPERMAKER_RESET_WORKSPACE: "1", HYPERMAKER_PROJECT: root,
      NARRATION_RATE: "1.23456", NARRATION_PITCH: "113.45678"
    }
  });
  const create = (path, body) => fetch(`http://127.0.0.1:${port4}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
  try {
    await waitReady(port4);
    const material = "The sea at night is never still. It carries every colour of the sky.";
    const madeText = await create("/api/node", { x: 10, y: 10, type: "text", method: "llm", prompt: material, quality: "demo" });
    const tid = Number(Object.keys(madeText.nodes).at(-1));
    await create("/api/generate", { id: tid });
    let textNode;
    for (let i = 0; i < 200; i++) {
      textNode = (await fetch(`http://127.0.0.1:${port4}/api/workspace`).then(r => r.json())).nodes[tid];
      if (textNode?.artifact || textNode?.error) break;
      await new Promise(r => setTimeout(r, 100));
    }
    // Without this the narration has nothing to read, and "no source card" would be correct
    // rather than the bug it is being tested for.
    assert.match(textNode.artifact || "", /lines\.txt$/, `the material card was written, got ${textNode.artifact} / ${textNode.error}`);
    const made = await create("/api/node", { x: 300, y: 10, type: "audio", method: "narration", quality: "demo", prompt: "read it", inputs: [tid] });
    const id = Number(Object.keys(made.nodes).at(-1));
    // The same link a person makes by dragging one card onto another. Passing `inputs` at
    // create time is not the wiring the canvas uses, and a card with no link has no material,
    // so without this the narration would legitimately report no source card.
    await create("/api/link", { source: tid, target: id });
    await create("/api/generate", { id });
    let node;
    for (let i = 0; i < 600; i++) {
      node = (await fetch(`http://127.0.0.1:${port4}/api/workspace`).then(r => r.json())).nodes[id];
      if (node?.artifact || node?.error) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(node.error, null, `an honest take at a non-round rate was refused: ${node.error}`);
    assert.ok(node.artifact, "the take was published");
    // The record on the card judged the bytes it describes, exactly. This is the bug the
    // reviewer found, so its absence is asserted rather than assumed.
    assert.equal(node.narration.take.correlation, 1, `the take agrees with its own record exactly, got ${node.narration.take.correlation}`);
    assert.match(node.narration.verdict, /speech/);
    assert.equal(node.narration.source?.id, tid, `and the card says which card it read, got ${JSON.stringify(node.narration.source)}`);
  } finally { stopServer(app4); stopAll(); }
});
