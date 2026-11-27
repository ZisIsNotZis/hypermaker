// Four ordinary lines read back wrong - found by synthesizing them with the real reader and
// comparing the chosen words and published bytes with the line, not by listening. Each one
// changed what the line meant, which is worse than a refusal: the card plays, the voice is
// clear, and the sentence is about a different amount or a different number.
//
//   "The ticket costs $1250."          "twelve fifty dollars"  - a price read as a year
//   "It costs £0.50."                  "fifty cents"           - the currency was replaced
//   "1,000,000,000,000 dollars"        "one dollars"           - the magnitude was dropped
//   "It is -3.5 degrees outside."      "three point five"      - the sign was dropped
//
// The tests below are in three parts, and all three matter:
//
//   1. the corrected reading, pinned as the words a person would say;
//   2. the *old* readings, pinned as well - they are what `cmudict-3` already published, and a
//      take made with that table has to keep reproducing from it, mistakes included;
//   3. the shapes that are still refused, refused by name rather than read as their leftover
//      letters. A number whose reading is a guess is the defect this whole file is about.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expandNumerals } from "../voice/numbers.mjs";
import { audit, pronounce, tokenize, CURRENT_READINGS, READING_SETS } from "../voice/lexicon.mjs";
import { renderParagraph, toWav } from "../voice/synth.mjs";

const root = process.cwd();
const base = mkdtempSync(join(tmpdir(), "hypermaker-fidelity-"));
// `writeFileSync` does not create the parent, and the take's directory is made by `render.mjs`
// only when it renders - which is not what this test does.
mkdirSync(join(base, "frozen-take"), { recursive: true });
const said = (text, readings = CURRENT_READINGS) => tokenize(text, readings).tokens.map(t => t.word).join(" ");

test("an amount of money is read as money, and keeps its currency", () => {
  // A price is not a year. `$1250` was read as `twelve fifty`, which is what `1250` sounds like
  // as a year and is not what the number says.
  assert.equal(expandNumerals("$1250").join(" "), "one thousand two hundred fifty dollars");
  assert.equal(expandNumerals("$1,250.00").join(" "), "one thousand two hundred fifty dollars", "trailing zero cents are whole units");
  assert.equal(expandNumerals("$2,500").join(" "), "two thousand five hundred dollars");
  // The subunit belongs to the currency. `pence` for £ and `cents` for $ are different sentences,
  // and saying one for the other is exactly the failure a listener reported.
  assert.equal(expandNumerals("£0.50").join(" "), "fifty pence");
  assert.equal(expandNumerals("$0.50").join(" "), "fifty cents");
  assert.equal(expandNumerals("€0.50").join(" "), "fifty cents");
  assert.equal(expandNumerals("£0.01").join(" "), "one penny");
  assert.equal(expandNumerals("£1250").join(" "), "one thousand two hundred fifty pounds");
  // A price with hundredths still says the whole unit and then the cents, singular when there is
  // one whole unit - and no amount of decimal places loses the unit.
  assert.equal(expandNumerals("$1.50").join(" "), "one dollar fifty");
  assert.equal(expandNumerals("$2.50").join(" "), "two dollars fifty");
  assert.equal(expandNumerals("$1.00").join(" "), "one dollar");
  assert.equal(expandNumerals("$1.234").join(" "), "one point two three four dollars", "an amount that is not in hundredths keeps the number as written");
  // A negative price is a refund or a loss, and the sign is the meaning.
  assert.equal(expandNumerals("-$5").join(" "), "minus five dollars");
  assert.equal(expandNumerals("-$0.50").join(" "), "minus fifty cents");
});

test("the number a line says is 1,000,000,000,000 when it says 1,000,000,000,000", () => {
  // The scale table stopped at a billion and dropped the rest without a sound: a trillion was
  // read as "one". A listener has no way to hear a digit that was never said.
  assert.equal(expandNumerals("1,000,000,000,000").join(" "), "one trillion");
  assert.equal(expandNumerals("2,500,000,000,000").join(" "), "two trillion five hundred billion");
  assert.equal(expandNumerals("$1,000,000,000,000").join(" "), "one trillion dollars");
  assert.equal(expandNumerals("1,000,000").join(" "), "one million", "the scales below it still work");
  // Past the last scale name there is no honest reading, so there is none: this is refused by
  // name at the tokenizer, not read as the largest prefix it can name.
  assert.equal(expandNumerals("1,000,000,000,000,000"), null);
  assert.deepEqual(audit("A budget of 1,000,000,000,000,000 dollars.").unreadable, ["1,000,000,000,000,000"]);
});

test("a sign is said, so a negative line is not read as a positive one", () => {
  assert.equal(expandNumerals("-3.5").join(" "), "minus three point five");
  assert.equal(expandNumerals("-3.5%").join(" "), "minus three point five percent");
  assert.equal(expandNumerals("-1200").join(" "), "minus one thousand two hundred");
  assert.equal(expandNumerals("+5").join(" "), "plus five");
  // Through the tokenizer, which is where the sign used to be stripped along with the quotes -
  // the reader was right and the caller threw the minus away, so this is pinned on the sentence.
  assert.equal(said("It is -3.5 degrees outside."), "It is minus three point five degrees outside");
  assert.equal(said("It fell to -0.5."), "It fell to minus oh point five");
  assert.equal(said("The balance is -$5."), "The balance is minus five dollars");
});

test("a shape the reader cannot read is refused by name, never read as its leftover letters", () => {
  // `$5M` and `$M` were read as "five M" and "M": a confident reading of a shape the reader had
  // just declined, which is the failure the whole numeral reader exists to prevent. A refusal is
  // something a person can fix; an invented word is not.
  for (const [line, refused] of [
    ["It costs $5M.", "$5M."],
    ["A total of $M.", "$M."],
    ["He is 6 ft tall.", "ft"],
    ["The meeting is on 3/4/2024.", "3/4/2024."],
    ["Range 1990-1995.", "1990-1995."],
    ["It grew 2.5x.", "2.5x."],
    ["The 2st time.", "2st"],
    ["It cost 1,20 dollars.", "1,20"]
  ]) {
    assert.deepEqual(audit(line).unreadable, [refused], `"${line}" is refused by name`);
  }
  // A stray currency symbol is still refused: dropping it silently is the failure this test is
  // about, and `$.` is a typo the writer should see rather than a pause the voice should keep.
  assert.deepEqual(audit("The cost was $.").unreadable, ["$."], "a bare symbol is a shape the reader declines, and it says so");
});

test("the table that already has takes keeps every reading it published, wrong ones included", () => {
  // `cmudict-3` shipped these four readings, and a take made with it sounds like them. Freezing
  // the set is not a formality: if the fix changed the table in place, every such take would
  // stop verifying and a card that was honest yesterday would look like a lie today.
  const frozen = [
    ["$1250", "twelve fifty dollars"],
    ["£0.50", "fifty cents"],
    ["1,000,000,000,000", "one"],
    ["$1,000,000,000,000", "one dollars"],
    ["-3.5", "minus three point five"],
    ["8:30", "eight thirty"],
    ["$5", "five dollars"],
    ["1990", "nineteen ninety"]
  ];
  for (const [token, words] of frozen) {
    assert.equal(expandNumerals(token, "cmudict-3").join(" "), words, `cmudict-3 still reads ${token} as it published it`);
  }
  // And through the tokenizer, because the sign was dropped by its token splitter rather than
  // by the reader. Reproducing a take means reproducing the whole path that made the bytes.
  assert.equal(said("It is -3.5 degrees outside.", "cmudict-3"), "It is three point five degrees outside");
  // The shapes cmudict-3 refused are still refused by it.
  assert.equal(expandNumerals("+5", "cmudict-3"), null, "cmudict-3 had no reading for a leading plus");
  assert.equal(expandNumerals("$1.234", "cmudict-3"), null, "nor for a price with other than two decimals");
});

test("a take made by the old table still verifies, byte for byte, from this build", () => {
  // The decisive check on the freeze: not the words the reader returns, but the audio the old
  // table produced and whether this build can still reproduce and verify it. A take of a line
  // containing all four corrected shapes is rendered under `cmudict-3`, written beside its
  // timeline, and put through the same CLI a person uses on a card they already have.
  const line = "The ticket costs $1250 and it was -3.5 degrees, a 1,000,000,000,000 dollar year.";
  const old = renderParagraph([{ text: line }], { readings: "cmudict-3" });
  const now = renderParagraph([{ text: line }], { readings: "cmudict-4" });
  assert.notEqual(createHash("sha256").update(toWav(old.samples, old.rate)).digest("hex"),
    createHash("sha256").update(toWav(now.samples, now.rate)).digest("hex"),
    "the two tables really do make different recordings of this line");
  const dir = join(base, "frozen-take");
  const wav = join(dir, "narration.wav");
  writeFileSync(wav, toWav(old.samples, old.rate));
  writeFileSync(join(dir, "timeline.json"), JSON.stringify({ audio: wav, rate: old.rate, seconds: old.samples.length / old.rate, voice: old.voice, phrases: old.segments }));
  const out = execFileSync(process.execPath, [join(root, "voice/verify-take.mjs"), dir], { encoding: "utf8" });
  assert.match(out, /^verifies: /, `a cmudict-3 take with the old readings still verifies, got ${out}`);
  assert.match(out, /reading table: cmudict-3/, "and is named as the table that made it");
});

test("a line with no number in it is unchanged by the numeral fix", () => {
  // The fix touched the numeral reader and the token splitter, both of which every line passes
  // through. A sentence with no numeral in it must still be the same recording, or this change
  // would silently re-render every narration in the workspace.
  const plain = "Nothing about the building looks the same in the morning light.";
  const three = renderParagraph([{ text: plain }], { readings: "cmudict-3" });
  const four = renderParagraph([{ text: plain }], { readings: "cmudict-4" });
  assert.equal(createHash("sha256").update(toWav(four.samples, four.rate)).digest("hex"),
    createHash("sha256").update(toWav(three.samples, three.rate)).digest("hex"),
    "without a numeral, cmudict-4 makes exactly the bytes cmudict-3 made");
});

test("this build speaks with cmudict-4, and every table it ships is named in the usage", () => {
  assert.equal(CURRENT_READINGS, "cmudict-4", "the corrected table is the one this build renders with");
  assert.ok(READING_SETS.includes("cmudict-3"), "and the frozen one is still shipped, because takes were made with it");
  // `pronounce` must agree with the reader, not read a corrected token through the digit path.
  assert.notEqual(pronounce("$1250", "cmudict-3").join(" "), pronounce("$1250", "cmudict-4").join(" "), "the two tables pronounce a price differently");
  // The reading is the words, so every phoneme of it comes from the dictionary rather than
  // from a digit-by-digit fallback: `one thousand two hundred fifty dollars` must sound like
  // exactly those words and like nothing else.
  const words = tokenize("one thousand two hundred fifty dollars", "cmudict-4").tokens.flatMap(t => t.phonemes).join(" ");
  assert.equal(pronounce("$1250", "cmudict-4").join(" "), words, "and the new reading is exactly those words");
  assert.notEqual(pronounce("$1250", "cmudict-4").join(" "), pronounce("1250", "cmudict-4").join(" "), "a price is not the bare number: it says its unit");
  const usage = (() => {
    try { execFileSync(process.execPath, [join(root, "voice/render.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return ""; }
    catch (error) { return String(error.stderr || ""); }
  })();
  assert.match(usage, /cmudict-4/, "the renderer's usage names the table this build speaks with");
});
