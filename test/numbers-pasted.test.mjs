// A script is usually pasted from a page, and a page uses characters a keyboard does not. A
// second listener round found three of them going wrong in silence, on the build that had just
// fixed the arithmetic:
//
//   "−3.5"   the true minus sign is not the ASCII hyphen; it was stripped with the quotes, and a
//            negative temperature was read back as a positive one;
//   "¥500"   a currency the voice does not name was dropped, so the line was read as "five
//            hundred" - a price with no country, which is the same defect as `£0.50` read as cents;
//   "½"      a fraction symbol was not even a token: it vanished, so "half a cup" became "a cup".
//
// Two of those are refusals and one is a reading, and the difference is deliberate: a true minus
// has exactly one meaning, so it is said; a currency or a fraction carries meaning this voice
// cannot say, so it is refused *and named*, because the writer can fix a named symbol and cannot
// fix a line that quietly plays something else.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { audit, tokenize, CURRENT_READINGS } from "../voice/lexicon.mjs";

const root = process.cwd();
const base = mkdtempSync(join(tmpdir(), "hypermaker-pasted-"));
const said = (text, readings = CURRENT_READINGS) => tokenize(text, readings).tokens.map(t => t.word).join(" ");
const MINUS = "\u2212";

test("a true minus sign is read as minus, so a negative line stays negative", () => {
  // The sign a document uses. Reading it as positive is the worst kind of failure here: the
  // sentence is fluent, plausible and about the opposite of what was written.
  assert.equal(said(`It is ${MINUS}3.5 degrees outside.`), "It is minus three point five degrees outside");
  assert.equal(said(`It fell ${MINUS}3.5% this year.`), "It fell minus three point five percent this year");
  assert.equal(said(`${MINUS}$5`), "minus five dollars", "a pasted minus before a currency is a negative price");
  // Through `render.mjs`, because the token strip that dropped it lived between the reader and
  // the synthesizer: asserting the reader alone would have passed while the audio was wrong.
  const script = join(base, "minus.txt");
  writeFileSync(script, `It is ${MINUS}3.5 degrees outside.\n`);
  const out = join(base, "minus.wav");
  const printed = JSON.parse(execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", script, "--out", out], { encoding: "utf8" }));
  assert.match(printed.phrases[0].text, /./, "the renderer recorded a phrase");
  assert.deepEqual(audit(`It is ${MINUS}3.5 degrees outside.`).unreadable, [], "and it is not refused");
  assert.equal(said(`It is ${MINUS}3.5 degrees outside.`).split(" ")[2], "minus", "the rendered script says minus");
});

test("a symbol the voice cannot name is refused by name, with the reason, not dropped", () => {
  // Each of these used to be dropped as punctuation, which produced a confident sentence about
  // something else. The reason is asserted, not only the refusal: `¥` is fixed by replacing one
  // character, and only a message that names it is something a writer can act on.
  const cases = [
    ["The price is \u00a5500.", "\u00a5500.", /currency this voice does not name/],
    ["The price is \u20b9500.", "\u20b9500.", /currency this voice does not name/],
    ["Add \u00bd cup of sugar.", "\u00bd", /fraction symbol/],
    ["The area is 3\u00d74 metres.", "3\u00d74", /mathematical symbol/],
    ["A range of 1990\u20131995.", "1990\u20131995.", /unit or range symbol/],
    ["It is 3.5\u00b0 outside.", "3.5\u00b0", /unit or range symbol/]
  ];
  for (const [line, token, reason] of cases) {
    const a = audit(line);
    assert.deepEqual(a.unreadable, [token], `"${line}" refuses the token it cannot read`);
    assert.ok((a.reasons || []).some(r => reason.test(r)), `"${line}" says why: got ${JSON.stringify(a.reasons)}`);
  }
  // The currencies and symbols this voice *does* read are not caught by the same net.
  for (const fine of ["$5", "£5", "\u20ac5", "40%", "8:30"]) assert.deepEqual(audit(fine).unreadable, [], `${fine} is still readable`);
});

test("the refusal reaches the person as a sentence naming the symbol", () => {
  // A refusal nobody can read is not much better than the wrong reading: the card shows the
  // message, and the message has to say which character to change.
  const script = join(base, "yen.txt");
  writeFileSync(script, "The price is \u00a5500.\n");
  let status = 0, stderr = "";
  try { execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", script, "--out", join(base, "yen.wav")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { status = error.status; stderr = String(error.stderr || ""); }
  assert.equal(status, 2, "the render is refused rather than written");
  assert.match(stderr, /\u00a5500/, "the message names the token");
  assert.match(stderr, /currency this voice does not name/, "and says what is wrong with it");
  assert.match(stderr, /reads \$/, "and which currencies it does read");
  // The token has its own full stop, so the message must not end `¥500..` - seen in a real run
  // through the canvas, where it reaches a person.
  assert.doesNotMatch(stderr, /\.\./, "and does not double the sentence's own full stop");
  assert.doesNotMatch(stderr, /The symbols:/, "and does not put a label in front of a sentence that already names the symbol");
});

test("the pasted shapes do not disturb the table that already has takes", () => {
  // `cmudict-3` is frozen: it read these shapes wrongly (a pasted minus silently became positive,
  // a currency symbol was dropped) and a take made with it must keep reproducing that. Only the
  // current table refuses or reads them.
  assert.equal(said(`It is ${MINUS}3.5 degrees.`, "cmudict-3"), "It is three point five degrees", "the frozen table still drops the pasted minus");
  assert.deepEqual(audit("The price is \u00a5500.", "cmudict-3").unreadable, [], "and still drops an unknown currency without refusing");
  // A sentence with none of these characters is unaffected by the change.
  const plain = "Nothing about the building looks the same in the morning light.";
  assert.equal(said(plain, "cmudict-3"), said(plain, CURRENT_READINGS), "a plain sentence reads identically under both tables");
});
