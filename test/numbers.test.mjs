// A number in a script is not decoration: it is the word that carries the meaning of the
// sentence. The shipped voice either refused these lines or said a different one, measured on
// the build this slice started from:
//
//   "The train leaves at 8:30."        refused - `8:30` is not letters or digits
//   "The house was built in 1990."     said "one nine nine zero"
//   "We sold 1,200 copies."            refused
//   "It costs $5."                     said "five", losing the unit
//   "Prices rose 40% last year."       said "four zero"
//   "The 21st century began in 2001."  refused
//
// So the tests below are in two halves, and the second half is the one that matters as much as
// the first: the frozen reading sets must keep producing the bytes their takes sound like. A
// numeral fix that quietly re-read `1990` for a take published last week would turn an honest
// card into a refusal, which is the defect the reading sets were introduced to stop.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { asYear, cardinal, expandNumerals, ordinal } from "../voice/numbers.mjs";
import { audit, pronounce, tokenize, READING_SETS, CURRENT_READINGS } from "../voice/lexicon.mjs";
import { renderParagraph, toWav } from "../voice/synth.mjs";

const root = process.cwd();
const base = mkdtempSync(join(tmpdir(), "hypermaker-numbers-"));
const said = text => tokenize(text).tokens.map(t => t.word).join(" ");

test("a written number is said the way a person reads it", () => {
  // Each case is a line somebody would actually put on a card, and the reading is the words
  // that person would say out loud. Pinned as words rather than as "it returns something":
  // the defect was not a refusal to produce audio, it was producing the wrong sentence.
  assert.equal(expandNumerals("8:30").join(" "), "eight thirty", "a clock time");
  assert.equal(expandNumerals("8:05").join(" "), "eight oh five", "minutes under ten take `oh`");
  assert.equal(expandNumerals("12:00").join(" "), "twelve o clock");
  assert.equal(expandNumerals("1990").join(" "), "nineteen ninety", "a year, not four digits");
  assert.equal(expandNumerals("1905").join(" "), "nineteen oh five");
  assert.equal(expandNumerals("2000").join(" "), "two thousand");
  assert.equal(expandNumerals("2007").join(" "), "two thousand seven");
  assert.equal(expandNumerals("1990s").join(" "), "nineteen nineties");
  assert.equal(expandNumerals("21st").join(" "), "twenty first");
  assert.equal(expandNumerals("1,200").join(" "), "one thousand two hundred", "a count with a separator is not a year");
  assert.equal(expandNumerals("1200").join(" "), "one thousand two hundred", "nor is a round hundred");
  assert.equal(expandNumerals("40%").join(" "), "forty percent");
  assert.equal(expandNumerals("3.5").join(" "), "three point five");
  assert.equal(expandNumerals("0.5").join(" "), "oh point five");
  // Money says the unit, because the unit is the meaning: "five" alone is not what the card says.
  assert.equal(expandNumerals("$5").join(" "), "five dollars");
  assert.equal(expandNumerals("$1").join(" "), "one dollar");
  assert.equal(expandNumerals("$1.50").join(" "), "one dollar fifty");
  assert.equal(expandNumerals("$0.50").join(" "), "fifty cents", "under one unit the cents are the number");
  assert.equal(expandNumerals("$1,200").join(" "), "one thousand two hundred dollars");
  // Card arms for completeness: the pieces the readings are built from.
  assert.equal(cardinal(999).join(" "), "nine hundred ninety nine", "no `and`, which is the form most narration uses");
  assert.equal(cardinal(1000000).join(" "), "one million");
  assert.equal(asYear(1100).join(" "), "eleven hundred");
  assert.equal(ordinal(13).join(" "), "thirteenth");
  assert.equal(ordinal(22).join(" "), "twenty second");
});

test("shapes this reader does not understand are refused by name, not guessed at", () => {
  // The alternative to a wrong guess is a refusal, and a refusal is what a person can fix. A
  // date read as a fraction would be a sentence confidently about a different day, so the
  // reader declines rather than guesses - and the render still fails loudly.
  for (const unsupported of ["km", "ft", "3/4/2024", "1990-1995", "2.5x", "2st", "1,20"]) {
    assert.equal(expandNumerals(unsupported), null, `"${unsupported}" is not a shape this reader claims`);
  }
  assert.deepEqual(audit("He was 6 ft tall.").unreadable, ["ft"], "an abbreviation is still refused, and named");
  assert.deepEqual(audit("The meeting is on 3/4/2024.").unreadable, ["3/4/2024."], "so is a date");
});

test("the render of a sentence with numbers is speech, and the words are the ones written", () => {
  // The end of the chain a creator actually reaches: the script is rendered by the shipped
  // voice and measured by the same judge the server uses, so "it can be narrated" is not a
  // claim about a function's return value.
  const line = "The train leaves at 8:30 and the ticket costs $5.";
  assert.deepEqual(audit(line).unreadable, [], "an ordinary sentence with a time and a price is readable");
  const rendered = renderParagraph([{ text: line }]);
  const wav = join(base, "numbers.wav");
  writeFileSync(wav, toWav(rendered.samples, rendered.rate));
  const report = JSON.parse(execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--check", wav, "--words", line], { encoding: "utf8" }));
  assert.equal(report.verdict, "speech", `the take measures as speech, got: ${report.problems.join("; ")}`);
  // `eight thirty` and `five dollars` are said, not `eight three zero` and `five`: the syllable
  // count is the check that can see the difference, because it counts the vowels the engine
  // will pronounce from the words the script expands to.
  assert.equal(report.syllables, audit(line).syllables, "the judge counts the words the script now expands to");
  assert.ok(report.syllables > audit(line.replace(/8:30/, "8").replace(/\$5/, "5")).syllables,
    "which is more syllables than the same line with bare digits would have had");
});

test("the frozen reading sets read numbers exactly as they always did", () => {
  // `1990` and `8:30` mid-sentence is the case that distinguishes the sets, and `8:30` is the
  // one that must keep *failing* under the old sets: they never had a reading for it, and a
  // take could not have been made with one.
  assert.equal(pronounce("1990", "cmudict-2").join(" "), "W AH N N AY N N AY N Z IH R OW", "cmudict-2 keeps digit-by-digit");
  assert.equal(pronounce("1990", "cmudict-1").join(" "), pronounce("1990", "cmudict-2").join(" "), "both old dictionary sets read it the same way");
  assert.equal(pronounce("1990", "rules-1").join(" "), pronounce("1990", "cmudict-2").join(" "), "and so does the rule engine");
  assert.equal(pronounce("1990", CURRENT_READINGS).join(" "), "N AY N T IY N N AY N T IY", "this build reads it as a year");
  assert.deepEqual(audit("8:30", "cmudict-2").unreadable, ["8:30"], "an old set still cannot say a clock time");
  assert.deepEqual(audit("8:30", CURRENT_READINGS).unreadable, []);
  // The same words outside the numeral shapes must render to the same bytes in both sets. This
  // is the property that lets a take made by either be recognised as the same words: if the
  // new set changed a word's reading incidentally, every take would be mislabelled.
  const plain = "Nothing about the building looks the same in the morning light.";
  const two = renderParagraph([{ text: plain }], { readings: "cmudict-2" });
  const three = renderParagraph([{ text: plain }], { readings: CURRENT_READINGS });
  assert.equal(createHash("sha256").update(toWav(three.samples, three.rate)).digest("hex"),
    createHash("sha256").update(toWav(two.samples, two.rate)).digest("hex"),
    "with no numeral in it, a sentence is byte-for-byte what cmudict-2 made");
});

test("the number a script writes does not change what an older take verifies as", () => {
  // A take made by `cmudict-2` of a sentence containing `1990` must still verify under this
  // build, and must be reported as having been made by `cmudict-2` - not mislabelled as
  // `cmudict-3`, whose reading of that sentence is a different recording.
  const line = "The house was built in 1990.";
  const old = renderParagraph([{ text: line }], { readings: "cmudict-2" });
  const now = renderParagraph([{ text: line }], { readings: CURRENT_READINGS });
  assert.notEqual(old.samples.length, now.samples.length, "the two sets really do make different recordings of this line");
  const dir = mkdtempSync(join(tmpdir(), "hypermaker-number-take-"));
  const wav = join(dir, "narration.wav");
  writeFileSync(wav, toWav(old.samples, old.rate));
  writeFileSync(join(dir, "timeline.json"), JSON.stringify({
    audio: wav, rate: old.rate, seconds: old.samples.length / old.rate, voice: old.voice,
    phrases: old.segments
  }));
  // Through the command line, which is how a person checks a card they already have.
  const out = execFileSync(process.execPath, [join(root, "voice/verify-take.mjs"), dir], { encoding: "utf8" });
  assert.match(out, /^verifies: /, `a cmudict-2 take of a sentence with a year still verifies, got ${out}`);
  assert.match(out, /reading table: cmudict-2/, "and is named as the table that made it");
});

test("the method guide and the command line name every reading table, and say what is refused", () => {
  // A table a build ships and does not mention is a table a person cannot use to check a take.
  // The guide is what an agent reads, so it also has to say which numeral shapes are read and
  // which are refused - an agent that assumes `km` works will write a script that cannot render.
  const usage = (() => {
    try { execFileSync(process.execPath, [join(root, "voice/render.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return ""; }
    catch (error) { return String(error.stderr || ""); }
  })();
  assert.ok(usage.length > 0, `the renderer prints its usage when run with no arguments, got ${JSON.stringify(usage.slice(0, 200))}`);
  for (const name of READING_SETS) assert.match(usage, new RegExp(name), `the renderer's usage names the ${name} table`);
  assert.match(usage, /cmudict-3 is cmudict-2 plus numerals/, "and says what the newest table adds");
  // The agent-facing guide: the shapes it promises, and the shapes it does not.
  const guide = readFileSync(join(root, "types/audio/methods/narration.mjs"), "utf8");
  assert.match(guide, /8:30` as eight thirty/, "the guide says a time is read as words");
  assert.match(guide, /`\$5` as five dollars/, "and that money says its unit");
  assert.match(guide, /abbreviations \(`km`, `ft`\), dates \(`3\/4\/2024`\), ranges/, "and names the shapes that are still refused, so an agent spells them out");
});
