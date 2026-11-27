#!/usr/bin/env node
// Re-verify a take that is already on disk - including one made by an older build.
//
//   node voice/verify-take.mjs /path/to/node-dir          # the take the card currently shows
//   node voice/verify-take.mjs versions/v2-narration.wav  # one named take, its own record beside it
//   node voice/verify-take.mjs narration.wav timeline.json
//   node voice/verify-take.mjs /path/to/node-dir --timeline /path/to/file.json
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
// Which take it reads, in order of what a person most likely meant:
//
//   * a directory: the take the *card is showing*, read from the workspace record, not from
//     filenames. This was the defect a supervisor found on a real two-version card: the command
//     sorted the files and verified `v2` while the canvas had `v1` selected, so it answered
//     confidently about a recording the person was not looking at. A verification that answers
//     about the wrong take is worse than no verification.
//   * a named WAV: that file with *its own* record beside it. The supervisor's second finding
//     was that `versions/v1-narration.wav` reported "no timeline" while `v1-narration.timeline.json`
//     sat next to it - the lookup assumed the attempt directory's name.
//   * only when the workspace record cannot be read does it fall back to the newest *publish*,
//     and it says so rather than implying it knew which take was on the card. A supervisor
//     copied two takes with their timelines into a directory with no record and found this
//     branch checking the wrong one: the files were sorted as strings, where `v9-` comes after
//     `v10-`, so it verified v9 on a card whose newest take was v10 and called v9 the newest.
//     The publish number is an ordinal, so it is compared as a number, and the line names the
//     take it picked and how many there were - a guess a reader can check at a glance.
//
// What it can tell apart, which is the whole point:
//   * the words and the sound match, made by the table this build uses - the ordinary case;
//   * the words and the sound match, made by an *older* reading table - honest, still passes,
//     and says which table made it so the two cases are never confused;
//   * the words and the sound match, but the timeline wrote its start times to fewer decimal
//     places than the audio resolves - honest, still passes, and reports the samples it had to
//     move so nobody is told a rounded record was an exact one;
//   * the words are right but the start time is wrong - the audio holds the phrase somewhere
//     else at an exact match. This fails, and the reason says the *record* is what disagrees,
//     because a person told "the words are wrong" would rewrite a sentence that is already
//     right;
//   * the sound is not those words at all - one take's audio under another take's script. This
//     fails, and the reason names the moment that disagrees.
//
// Exit codes: 0 the take verifies, 1 the files are missing or unreadable, 3 the audio is not
// the script's recording.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { bindTake } from "./bind.mjs";
import { READING_SETS, CURRENT_READINGS } from "./lexicon.mjs";

const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : (argv[i + 1] ?? null); };
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--timeline"));

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node voice/verify-take.mjs <node-dir | narration.wav> [timeline.json] [--timeline file.json]");
  process.exit(1);
}

// The artifact the card is showing, out of its own workspace record.
//
// The record is YAML and this is not a YAML parser: it needs one field of one node, and pulling
// in a dependency to read `artifact: "versions/v1-narration.wav"` would be a cost this tool does
// not need. It finds the node's block by its id (the directory's name), then the first
// `artifact:` line in it. A record that does not parse simply yields null, and the caller says
// it could not tell which take the card shows rather than guessing silently.
function selectedArtifact(nodeDir) {
  const id = basename(resolve(nodeDir));
  const record = join(nodeDir, "..", "workspace.yml");
  if (!existsSync(record)) return null;
  let text;
  try { text = readFileSync(record, "utf8"); } catch { return null; }
  // Blocks start at a line `N:` at column 0. Everything until the next one belongs to node N.
  const start = new RegExp(`^${id}:\\s*$`, "m").exec(text);
  if (!start) return null;
  const from = start.index + start[0].length;
  const rest = text.slice(from);
  const next = /^[^\s#-][^:]*:\s*$/m.exec(rest);
  const block = next ? rest.slice(0, next.index) : rest;
  const artifact = /^\s+artifact:\s*"?([^"\n]+)"?\s*$/m.exec(block)?.[1]?.trim();
  return artifact && artifact !== "null" ? artifact : null;
}

// The timeline that belongs to `wav`: its own name with `.timeline.json`, which is how the
// server names it (`v2-narration.wav` -> `v2-narration.timeline.json`), then the attempt
// directory's plain `timeline.json`.
function timelineBeside(wav) {
  const stem = wav.replace(/\.wav$/i, "");
  for (const candidate of [`${stem}.timeline.json`, join(dirname(wav), "timeline.json")]) {
    if (existsSync(candidate)) return candidate;
  }
  return `${stem}.timeline.json`;
}

// The publish ordinal in `v12-narration.wav`, as a number. Sorting these names as strings is
// wrong the moment a card reaches ten takes, and a file with no `vN-` prefix (an artifact from
// before publishing existed) has no ordinal at all, so it sorts first rather than last.
const ordinalOf = file => { const n = /^v(\d+)-/.exec(file)?.[1]; return n == null ? -1 : Number(n); };
const byOrdinal = (a, b) => ordinalOf(a) - ordinalOf(b) || a.localeCompare(b);

function locate() {
  if (!positional.length) usage();
  const first = positional[0];
  const explicit = flag("timeline") || positional[1] || null;

  if (existsSync(first) && !first.endsWith(".wav")) {
    // An attempt directory, which is what a run writes while it is working.
    const attempt = { wav: join(first, "narration.wav"), timeline: explicit || join(first, "timeline.json"), how: "attempt" };
    if (existsSync(attempt.wav)) return attempt;
    // A published card: ask the record which take is on the canvas.
    const shown = selectedArtifact(first);
    if (shown) {
      const wav = join(first, shown);
      if (existsSync(wav)) return { wav, timeline: explicit || timelineBeside(wav), how: "card", shown };
    }
    // No usable record. Fall back to the newest published take and *say* that is what happened,
    // because a person asking about "the card" is owed the truth about which take was checked.
    const versions = join(first, "versions");
    const wavs = existsSync(versions) ? readdirSync(versions).filter(f => /\.wav$/i.test(f)).sort(byOrdinal) : [];
    if (wavs.length) {
      const wav = join(versions, wavs.at(-1));
      return { wav, timeline: explicit || timelineBeside(wav), how: "newest", picked: wavs.at(-1), total: wavs.length, reason: shown ? `the card's record names ${shown}, which is not on disk` : "the workspace record could not be read for this card" };
    }
    return attempt;
  }
  // A named WAV: its own record beside it, not a name guessed from an attempt directory.
  return { wav: first, timeline: explicit || timelineBeside(first), how: "file" };
}

const { wav, timeline: timelinePath, how, shown, reason, picked, total } = locate();
if (!existsSync(wav)) usage(`no WAV at ${wav}`);
if (!existsSync(timelinePath)) usage(`no timeline at ${timelinePath} - a take without one records nothing about what it says, so there is nothing to check it against`);

let timeline;
try { timeline = JSON.parse(readFileSync(timelinePath, "utf8")); }
catch (error) { usage(`${timelinePath} is not readable JSON (${error.message})`); }

const report = bindTake({ file: wav, timeline });
const phrases = Array.isArray(timeline?.phrases) ? timeline.phrases : [];

// The human answer first, in the words a person would use, then the numbers.
console.log(`${report.ok ? "verifies" : "DOES NOT VERIFY"}: ${wav}`);
// Say which take this is when and only when it was a choice. On a card with two versions the
// first question a reader has is "which one did you check?", and answering it is what made this
// command trustworthy again after it verified the wrong one.
if (how === "card") console.log(`  this is the take the card is showing (${shown}); the record beside it is ${basename(timelinePath)}.`);
// A fallback has to be as specific as what it replaces. "The newest take" was a claim an earlier
// build got wrong (v9 for v10), so this names the file it picked and how many takes there were:
// a reader can see in one line that it chose, which one, and what it chose among.
if (how === "newest") console.log(`  NOT the take the card is showing: ${reason}, so the newest published take (${picked}, of ${total} take${total === 1 ? "" : "s"} on this card) was checked instead. Pass a WAV to choose a particular take.`);
console.log(`  ${phrases.length} phrase(s), ${report.seconds}s of audio`);
for (const p of phrases) console.log(`    ${Number(p.start).toFixed(2)}s  ${String(p.text).trim()}`);

if (report.ok) {
  const recorded = report.voice?.recorded || {};
  const matched = report.voice?.matched || {};
  console.log(`  worst-frame agreement with the words: ${Number(report.correlation).toFixed(3)} (1.000 is the same recording)`);
  // When the audio had to be realigned, say so. A record written to two decimal places is not
  // a precise record of where each phrase begins, and the take is accepted on the sound, not
  // on the number - a reader should not be left believing the file was exact.
  const moved = (report.phrases || []).filter(p => p.slip);
  if (moved.length) console.log(`  ${moved.length} of ${phrases.length} phrase(s) were found up to ${Math.max(...moved.map(p => Math.abs(p.slip)))} samples from where the record puts them: this timeline rounded its start times, and the audio is these words at the recorded settings regardless.`);
  // What the *file* says, not what `bindTake` assumed for it: an old timeline has no such
  // field, and it must not be reported as having claimed the wrong table.
  const claimed = timeline?.voice?.readings ?? null;
  if (matched.readings && claimed == null) {
    // A record from before `readings` existed says nothing, which is not the same as saying
    // something wrong. Report what the evidence supports and no more: the audio is the words,
    // and the table was *recovered* from the sound rather than named by the record.
    console.log(`  the audio was made with the ${matched.readings} reading table. This timeline predates the field, so it names no table; ${matched.readings} is the one that reproduces these bytes exactly.`);
    console.log("  The words are right and the sound is theirs. Nothing is wrong with this take.");
    if (matched.readings !== CURRENT_READINGS) console.log(`  It is an older recording: this build reads with ${CURRENT_READINGS}, so regenerating it would not sound the same. Either is a fair choice - keeping it loses nothing, and this is how you know which you have.`);
  } else if (matched.readings && matched.readings !== claimed) {
    console.log(`  the audio was made with the ${matched.readings} reading table, but the timeline says ${claimed}.`);
    console.log("  The words are right and the sound is theirs; only the label is off, which is a defect in whatever wrote the timeline.");
  } else if (matched.readings) {
    console.log(`  reading table: ${matched.readings} (this build reads with ${CURRENT_READINGS})`);
    if (matched.readings !== CURRENT_READINGS) console.log(`  It is an older recording: this build reads with ${CURRENT_READINGS}.`);
  }
  if (recorded.rate !== matched.rate) console.log(`  the timeline records rate ${recorded.rate}; the audio was made at ${matched.rate}`);
  process.exit(0);
}

console.error(`  ${report.problems.join("\n  ")}`);
process.exit(3);
