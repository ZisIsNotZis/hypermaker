#!/usr/bin/env node
// Can a person understand the lines a film needs them to understand?
//
//   node voice/listening-test.mjs --out listen-out
//   node voice/listening-test.mjs --script my-lines.txt --out listen-out --no-film
//   node voice/listening-test.mjs --score listen-out
//
// Every other check in this project measures a signal. They can show that the formants move,
// that the syllables are there, and that the bytes are the recording of the words written on
// the card - none of them can show that a listener understood a sentence, and there is no
// recogniser on this machine to stand in for one. So the only honest way to answer the
// question is to ask a person, and the least this tool can do is make that ask fair:
//
//   * the audio is the real voice, rendered by the same code the app publishes with, and the
//     film is really rendered by Remotion carrying that audio - the thing being judged is the
//     thing a creator would ship, not a test fixture;
//   * the sheet is BLANK. `transcript.md` has a number per line and no words, so the listener
//     writes down what they heard rather than choosing among options somebody else wrote.
//     A multiple-choice sheet would leak the answer: with three options the chance of scoring
//     well by guessing is one in three, and an option set chosen by the engine's author is
//     chosen by the person being graded;
//   * the lines are written to `key.txt` in a separate file, and this tool reminds you not to
//     open it until the sheet is filled in. `--score` reads both and reports word accuracy -
//     a number that means the same thing tomorrow and can be compared with a later build.
//
// The score is not adjusted for what is impossible to hear (a proper noun nobody could know,
// a homograph): an honest low score on a bad line is the finding, and editing the lines after
// seeing it is how this measurement would be turned back into a proxy.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { renderParagraph, toWav } from "./synth.mjs";
import { audit, pronounce } from "./lexicon.mjs";
import { wavSamples } from "./wav.mjs";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1] ?? null; };
const flag = name => argv.includes(`--${name}`);

// Eight lines of the kind a real narration has: ordinary English with the words that used to
// break (colour, science, machine, wanted, building) mixed in, so the test measures the voice
// a creator actually gets rather than a sentence chosen because the engine says it well.
export const DEFAULT_SCRIPT = `The sea at night is never still.
It carries every colour of the sky.
The picture on the wall is a photograph of the ocean at sunrise.
Science and music change how we hear the world.
He wanted to know what the machine was doing.
Nothing about the building looks the same in the morning light.
Walk slowly down toward the house.
The garden is quiet in the rain.`;

// Words, lowercased and stripped the same way on both sides, so a listener who writes
// "colour" for "colour." is not marked wrong for the full stop.
const words = text => String(text).toLowerCase().replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter(Boolean);

// What a word *sounds* like, for comparing a transcript with the key. Letters would mark a
// listener wrong for spelling the same sound differently: `color` for `colour` is the same
// word heard, and scoring it a miss punishes spelling, not hearing - it dragged a perfect
// transcript down to 86% in the first run of this tool. Pronouncing both and comparing the
// phonemes handles that family without a hand-written variant table, and uses the same
// dictionary the voice does. A word the engine cannot say (a scribble, a name) falls back to
// its letters, which is the strictest honest choice.
const soundsLike = word => {
  try { return pronounce(word).join(" ") || word; } catch { return word; }
};

// Word accuracy of a filled-in sheet against the key. A line left blank counts as every word
// missed, which is why `unfilled` is reported separately: a half-finished sheet and a voice
// nobody can follow are different findings, and averaging them into one number would hide
// whichever came second.
export function scoreSheet(keyLines, answerLines) {
  const lines = keyLines.map((want, i) => {
    const said = answerLines[i] ?? "";
    const target = words(want), heard = words(said);
    // Compared by sound, not spelling (see `soundsLike`), and aligned by position: a listener
    // writes what they heard in order, and their own punctuation or a filler word should not
    // shift every following word into a miss. The cost of positional alignment is that one
    // inserted word marks its neighbour; the benefit is that the `missed` list points at the
    // words that were actually misheard rather than at everything after the first gap.
    const at = new Set();
    let hit = 0;
    const n = Math.max(target.length, heard.length);
    for (let k = 0; k < n; k++) if (target[k] !== undefined && heard[k] !== undefined && soundsLike(target[k]) === soundsLike(heard[k])) { hit++; at.add(k); }
    return {
      line: i + 1, text: want, heard: said.trim(),
      // The words a listener missed, in order. This is the actionable part: "3 of 9" says the
      // voice is bad, `["every", "colour"]` says which sound to fix.
      missed: target.filter((_, k) => !at.has(k)),
      filled: heard.length > 0,
      accuracy: target.length ? hit / target.length : 0
    };
  });
  const totalWords = lines.reduce((n, l) => n + words(l.text).length, 0);
  const hits = lines.reduce((n, l) => n + Math.round(l.accuracy * words(l.text).length), 0);
  return {
    lines,
    accuracy: totalWords ? Number((hits / totalWords).toFixed(3)) : 0,
    unfilled: lines.filter(l => !l.filled).map(l => l.line)
  };
}

// The sheet a person fills in: a number per line, no words. Deliberately not a table with a
// blank column next to the sentence - seeing the sentence is the whole thing being tested.
function sheet(keyCount) {
  const rules = [
    "Listen once, all the way through, without stopping. Then listen again and write down what",
    "you heard, line by line. Write the words you think were spoken - if a word is unclear,",
    "write your best guess rather than leaving it blank; a blank scores as a miss and a guess",
    "tells us which sound was mistaken for which. Do not open `key.txt` until the sheet is done.",
    "",
    "How does it sound? Note it after the transcript: is it robotic, choppy, slurred, too fast?",
    "That judgement is the one no measurement here can make. If you could make out nothing at",
    "all, write that under Notes and leave the lines blank - 'only machine noise' is a result,",
    "and this sheet is kept exactly as you leave it."
  ].join("\n");
  return [
    "# Listening sheet", "", rules, "", "## Transcript", "",
    ...Array.from({ length: keyCount }, (_, i) => `**Line ${i + 1}.** `),
    "", "## Notes", "", ""
  ].join("\n");
}

// The sheet has two sections and they mean different things: `## Transcript` is what the listener
// heard, and `## Notes` is what they think about how it sounded. They have to be read apart.
// A listener who could make out nothing wrote "I could hear a machine and not one word of it"
// under Notes - a result, which a re-run used to overwrite because a guard reading only the line
// bodies found the sheet empty. The other direction is worse: a listener who quotes line 2 under
// Notes to comment on it, written in the sheet's own `**Line 2.** ...` shape, was read as having
// answered line 2, and a half-heard sheet scored 50% rose to 100%. Commentary is commentary;
// only the transcript decides what was heard.
function sections(text) {
  const notesAt = /^## Notes[ \t]*\r?$/m.exec(text);
  const body = notesAt ? text.slice(0, notesAt.index) : text;
  const head = /^## Transcript[ \t]*\r?$/m.exec(body);
  return {
    transcript: head ? body.slice(head.index + head[0].length) : body,
    notes: notesAt ? text.slice(notesAt.index + notesAt[0].length).trim() : ""
  };
}

const readNotes = text => sections(text).notes;

// Read a filled-in sheet back into one string per line. The markdown shape is fixed by
// `sheet()` above, so this is a parser for one format rather than a hope about markdown.
//
// A line left empty is the commonest real answer - "I could not make that out" - and the first
// version lost it: the line marker and an empty body do not match an anchored `(.*)$`, so the
// next line's text was read as this one's answer and every empty line shifted the rest by one.
// That is a bug that silently invents a transcript, so empty bodies are matched explicitly.
function readSheet(text) {
  const found = [...sections(text).transcript.matchAll(/^\*\*Line (\d+)\.\*\*[ \t]*(.*)$/gm)]
    .map(m => ({ n: Number(m[1]), said: m[2].trim() }))
    .sort((a, b) => a.n - b.n);
  // Indexed by the line number written on the sheet, not by order of appearance, so a listener
  // who skipped a line in a text editor gets their answer on the line they wrote it for.
  const out = [];
  for (const { n, said } of found) out[n - 1] = said;
  return out.map(v => v ?? "");
}

async function film(wav, dir, seconds) {
  // The same shape the app's film path uses: copy the track into `public/`, reference it with
  // `staticFile`, render h264 with an AAC track, then measure the embedded track so a silent
  // film cannot be handed to a listener as evidence about sound.
  const { bundle } = await import("@remotion/bundler");
  const { renderMedia, selectComposition } = await import("@remotion/renderer");
  const fps = 30, durationInFrames = Math.max(1, Math.ceil(seconds * fps));
  const entry = join(dir, "listening-film.jsx");
  writeFileSync(entry, `
import React from 'react';
import { AbsoluteFill, Audio, Composition, registerRoot, staticFile, useCurrentFrame } from 'remotion';
const Film = () => {
  const frame = useCurrentFrame();
  // Deliberately says nothing from the script. The first version of this film put the lines
  // themselves on screen as captions, which handed the listener the answer the sheet exists
  // to withhold - a listening test that shows the words measures reading, not hearing.
  const beats = ['ONE', 'TWO', 'THREE'];
  return <AbsoluteFill style={{ background: '#0f1116', justifyContent: 'center', alignItems: 'center', flexDirection: 'column', gap: 18 }}>
    <div style={{ color: '#53e0c1', fontSize: 54, fontFamily: 'Arial' }}>{beats[Math.floor(frame / 60) % beats.length]}</div>
    <div style={{ color: '#7f8a99', fontSize: 20, fontFamily: 'Arial' }}>listening test</div>
    <Audio src={staticFile('track.wav')} />
  </AbsoluteFill>;
};
const Root = () => <Composition id="Film" component={Film} width={720} height={404} fps={30} durationInFrames={${durationInFrames}} />;
registerRoot(Root);
`);
  const chrome = process.env.HYPERMAKER_CHROME || process.env.CHROME_BIN;
  const browserArgs = chrome ? { browserExecutable: chrome, chromiumOptions: { executablePath: chrome } } : {};
  // Everything the renderer needs and leaves behind - the `public/` copy of the track and the
  // ~20 MB webpack build - happens in a scratch directory of this run's own making, outside the
  // listener's output directory. Left to itself `bundle()` writes that build into the system temp
  // directory and never removes it (19 stale bundles, 395 MB, were found); but building it inside
  // the output directory means deleting `build/` and `public/` there, and a supervisor had real
  // files of their own under both names. A tool may clean up after itself; it may not clean up
  // after its user. The finished film and the measured track are copied out, the scratch goes.
  const scratch = mkdtempSync(join(tmpdir(), "hypermaker-listen-"));
  const out = join(dir, "listen.mp4");
  let peak;
  try {
    const publicDir = join(scratch, "public");
    mkdirSync(publicDir, { recursive: true });
    copyFileSync(wav, join(publicDir, "track.wav"));
    const serveUrl = await bundle({ entryPoint: entry, publicDir, rspack: true, outDir: join(scratch, "build") });
    const composition = await selectComposition({ serveUrl, id: "Film", ...browserArgs });
    const rendered = join(scratch, "listen.mp4");
    await renderMedia({ serveUrl, composition, codec: "h264", outputLocation: rendered, audioCodec: "aac", concurrency: 1, ...browserArgs });
    peak = measureTrack(rendered, join(scratch, "film-track.wav"));
    copyFileSync(rendered, out);
    copyFileSync(join(scratch, "film-track.wav"), join(dir, "film-track.wav"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { out, peak, track: join(dir, "film-track.wav") };
}

// Measure the film's own track, not the source WAV: the point of listening to the film is that
// the audio survived the container. Kept beside the film rather than thrown away, because it is
// the bytes the peak was measured on.
function measureTrack(out, check) {
  const ff = join(process.cwd(), "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", out, "-map", "0:a:0", "-ac", "1", "-ar", "22050", check]);
  const { samples } = wavSamples(readFileSync(check));
  // `wavSamples` returns floats in -1..1, not int16 counts. Comparing against 1000 here (the
  // int16 scale) refused a perfectly audible film at peak 0.64 - a bug in the check, caught by
  // running it on real output rather than by reasoning about the units.
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  if (peak < 0.03) throw new Error(`the rendered film's audio track is silent (peak ${peak.toFixed(4)} of 1), so it is not something a person can judge`);
  return peak;
}

function score(outDir) {
  const keyPath = join(outDir, "key.txt"), sheetPath = join(outDir, "transcript.md");
  for (const p of [keyPath, sheetPath]) if (!existsSync(p)) { console.error(`missing ${p}`); process.exit(1); }
  const sheetText = readFileSync(sheetPath, "utf8");
  const result = scoreSheet(readFileSync(keyPath, "utf8").split("\n").filter(Boolean), readSheet(sheetText));
  const notes = readNotes(sheetText);
  // Every sentence here has to agree with the number beside it and with the denominator it is
  // actually divided by. Three versions got that wrong in three ways, each found by reading the
  // receipt next to the score: "50% covers only the lines you wrote down" (it does not - the
  // blank line's words are in the denominator and count as missed, which is why a half-heard
  // sheet scores 50% of the whole script, not 100% of what was attempted); "every line was left
  // blank, so the note is the whole result" on a blank template that had no note; and "finish
  // the sheet" to a listener who had already reported hearing nothing.
  const total = result.lines.reduce((n, l) => n + words(l.text).length, 0);
  const missed = result.lines.reduce((n, l) => n + l.missed.length, 0);
  const hits = total - missed;
  const percent = `${(result.accuracy * 100).toFixed(1)}%`;
  console.log(`word accuracy: ${percent} (${hits} of ${total} words heard; words on a blank line count as missed)`);
  const blank = result.unfilled.join(", ");
  const allBlank = result.unfilled.length === result.lines.length;
  if (allBlank && notes) console.log(`unfilled lines: ${blank} - every line was left blank, so the note under Notes is the whole result: 0 of ${total} words heard`);
  else if (allBlank) console.log(`unfilled lines: ${blank} - nothing has been written on the sheet yet, so ${percent} is only the template's own emptiness (0 of ${total} words heard)`);
  else if (result.unfilled.length) console.log(`unfilled lines: ${blank} - those lines' words are counted as missed, so ${percent} is a score for the whole ${total}-word script (${hits} heard), not for the ${total - result.lines.filter(l => !l.filled).reduce((n, l) => n + words(l.text).length, 0)} words you wrote down`);
  if (notes && !allBlank) console.log("the note under Notes is kept with the result, but it does not change the score");
  for (const l of result.lines) {
    console.log(`\nline ${l.line}  ${(l.accuracy * 100).toFixed(0)}%`);
    console.log(`  said: ${l.text}`);
    console.log(`  heard: ${l.heard || "(blank)"}`);
    if (l.missed.length) console.log(`  missed: ${l.missed.join(", ")}`);
  }
  const report = {
    at: new Date().toISOString(), accuracy: result.accuracy, hits, total, unfilled: result.unfilled,
    lines: result.lines.map(l => ({ line: l.line, accuracy: Number(l.accuracy.toFixed(2)), missed: l.missed, heard: l.heard })),
    // The listener's own words, verbatim. When the sheet is blank this is the entire finding,
    // and a report holding only 0% would record that something failed without saying what the
    // person reported - the same loss as overwriting the note, one step later.
    notes
  };
  writeFileSync(join(outDir, "score.json"), JSON.stringify(report, null, 2));
  if (notes) console.log(`\nnotes: ${notes.split("\n").map(l => l.trim()).filter(Boolean).join(" / ")}`);
  console.log(`\nwrote ${join(outDir, "score.json")}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("listening-test.mjs")) {
  if (flag("score")) { score(arg("score") || arg("out") || "listen-out"); process.exit(0); }

  const out = resolve(arg("out") || "listen-out");
  // A second run into the same directory used to overwrite `transcript.md` without a word. The
  // sheet is the one artifact in this project a person makes by listening, and it cannot be
  // remade by re-running anything - so an answered sheet is treated as a deliverable and not as
  // scratch. `--fresh` is the explicit way to say the old one may go.
  const sheetPath = join(out, "transcript.md");
  if (existsSync(sheetPath) && !flag("fresh")) {
    // Both halves of the sheet count. A transcript and a note are different findings and equally
    // impossible to remake by re-running anything; the earlier guard read only the line bodies,
    // so a listener who wrote "I heard a machine and no words" under Notes looked unanswered and
    // the next run replaced the file - the result was lost as if it had never been written.
    const text = readFileSync(sheetPath, "utf8");
    const answered = readSheet(text).map((said, i) => (said ? i + 1 : 0)).filter(Boolean);
    const wrote = readNotes(text);
    if (answered.length || wrote) {
      const what = [answered.length ? `an answer on line ${answered.join(", ")}` : null, wrote ? "a note under Notes" : null].filter(Boolean).join(" and ");
      console.error(`${sheetPath} already holds what a listener wrote (${what}), so this run would throw away the only listening evidence there is;\n` +
        `score it (node voice/listening-test.mjs --score ${out}), or pass --fresh with a sheet you mean to discard`);
      process.exit(3);
    }
  }
  mkdirSync(out, { recursive: true });
  const script = arg("script") ? readFileSync(arg("script"), "utf8") : DEFAULT_SCRIPT;
  const lines = script.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const unreadable = lines.flatMap(l => audit(l).unreadable);
  if (unreadable.length) {
    // Refused here rather than rendered as noise: a listening test of words the voice cannot
    // say would measure the wrong thing and blame the listener.
    console.error(`this voice has no way to say: ${[...new Set(unreadable)].join(", ")}; rewrite those lines before testing`);
    process.exit(2);
  }

  const rendered = renderParagraph(lines.map(text => ({ text })), {});
  const wav = join(out, "listen.wav");
  writeFileSync(wav, toWav(rendered.samples, rendered.rate));
  const seconds = rendered.samples.length / rendered.rate;

  writeFileSync(sheetPath, sheet(lines.length));
  writeFileSync(join(out, "key.txt"), lines.join("\n") + "\n");

  console.log(`wrote ${wav} (${seconds.toFixed(2)} s, ${lines.length} lines)`);
  if (!flag("no-film")) {
    try {
      const made = await film(wav, out, seconds);
      console.log(`wrote ${made.out} (the same audio, inside a real h264 film; its own track peaks at ${made.peak})`);
    } catch (error) {
      // A film is the thing a creator opens, so failing to make one is worth saying loudly -
      // but it does not stop the listening test, because the WAV is the same voice.
      console.error(`could not render a film (${error.message}); the WAV is still valid for listening`);
    }
  }
  console.log([
    "",
    "Now: listen to the film (or the WAV) once through without stopping, then again writing",
    `what you heard into ${sheetPath}. Do not open ${join(out, "key.txt")} first -`,
    "it is the answer, and the whole value of this test is that the sheet did not contain it.",
    "",
    `Then: node voice/listening-test.mjs --score ${out}`,
    ""
  ].join("\n"));
}
