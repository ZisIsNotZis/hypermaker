#!/usr/bin/env node
// Re-verify a take that is already on disk - including one made by an older build.
//
//   node voice/verify-take.mjs /path/to/node-dir
//   node voice/verify-take.mjs narration.wav timeline.json
//   node voice/verify-take.mjs /path/to/narration.wav --timeline /path/to/timeline.json
//
// Publishing checks a take once, at the moment it is made. Opening a workspace later does not
// check it again - the bytes are served as they are, which is the right default: a person who
// approved a take should be able to play it tomorrow without a build change deciding it was
// never valid. But that leaves a gap a reviewer hit: after upgrading the voice, a person has no
// way to ask "is this older card still honest?" other than trusting it.
//
// This is that question, asked of the files rather than of the record. It reads the WAV and the
// timeline beside it and answers with `bindTake` - the same code the server refuses a bad take
// with, so the command line cannot disagree with the app.
//
// What it can tell apart, which is the whole point:
//   * the words and the sound match, made by the table this build uses - the ordinary case;
//   * the words and the sound match, made by an *older* reading table - honest, still passes,
//     and says which table made it so the two cases are never confused;
//   * the sound is not those words at all - one take's audio under another take's script. This
//     fails, and the reason names the moment that disagrees.
//
// Exit codes: 0 the take verifies, 1 the files are missing or unreadable, 3 the audio is not
// the script's recording.
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { bindTake } from "./bind.mjs";
import { READING_SETS } from "./lexicon.mjs";

const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : (argv[i + 1] ?? null); };
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--timeline"));

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node voice/verify-take.mjs <node-dir | narration.wav> [timeline.json] [--timeline file.json]");
  process.exit(1);
}

// A directory means the conventional layout a run writes: `narration.wav` + `timeline.json`.
// A file means the WAV, with its timeline either named beside it or given with `--timeline`.
function locate() {
  if (!positional.length) usage();
  const first = positional[0];
  if (existsSync(first) && !first.endsWith(".wav")) {
    return { wav: join(first, "narration.wav"), timeline: flag("timeline") || join(first, "timeline.json") };
  }
  return { wav: first, timeline: flag("timeline") || positional[1] || join(dirname(first), "timeline.json") };
}

const { wav, timeline: timelinePath } = locate();
if (!existsSync(wav)) usage(`no WAV at ${wav}`);
if (!existsSync(timelinePath)) usage(`no timeline at ${timelinePath} - a take without one records nothing about what it says, so there is nothing to check it against`);

let timeline;
try { timeline = JSON.parse(readFileSync(timelinePath, "utf8")); }
catch (error) { usage(`${timelinePath} is not readable JSON (${error.message})`); }

const report = bindTake({ file: wav, timeline });
const phrases = Array.isArray(timeline?.phrases) ? timeline.phrases : [];

// The human answer first, in the words a person would use, then the numbers.
console.log(`${report.ok ? "verifies" : "DOES NOT VERIFY"}: ${wav}`);
console.log(`  ${phrases.length} phrase(s), ${report.seconds}s of audio`);
for (const p of phrases) console.log(`    ${Number(p.start).toFixed(2)}s  ${String(p.text).trim()}`);

if (report.ok) {
  const recorded = report.voice?.recorded || {};
  const matched = report.voice?.matched || {};
  console.log(`  worst-frame agreement with the words: ${Number(report.correlation).toFixed(3)} (1.000 is the same recording)`);
  // What the *file* says, not what `bindTake` assumed for it: an old timeline has no such
  // field, and it must not be reported as having claimed the wrong table.
  const claimed = timeline?.voice?.readings ?? null;
  if (matched.readings && matched.readings !== claimed) {
    // A record from before `readings` existed says nothing, which is not the same as saying
    // something wrong. Reporting it as a false claim would be this tool inventing a defect.
    console.log(claimed == null
      ? `  the audio was made with the ${matched.readings} reading table; this timeline predates the field, so it does not name one.`
      : `  the audio was made with the ${matched.readings} reading table, but the timeline says ${claimed}.`);
    console.log(claimed == null
      ? `  The words are right and the sound is theirs. Nothing is wrong with this take.`
      : `  The words are right and the sound is theirs; only the label is off, which is a defect in whatever wrote the timeline.`);
  } else if (matched.readings) {
    console.log(`  reading table: ${matched.readings} (this build reads with ${READING_SETS.at(-1)})`);
  }
  if (recorded.rate !== matched.rate) console.log(`  the timeline records rate ${recorded.rate}; the audio was made at ${matched.rate}`);
  process.exit(0);
}

console.error(`  ${report.problems.join("\n  ")}`);
process.exit(3);
