#!/usr/bin/env node
// How many words does the shipped voice say the way a dictionary says them?
//
//   node voice/check-pronunciation.mjs [--dict /path/to/cmudict.dict] [--text file.txt]
//
// Every claim about this voice's pronunciation used to rest on examples picked by hand
// (`science` as "S-S-IY-N-S" was the one everybody quoted). Hand-picked examples show a
// defect exists; they cannot say whether a listener reading an ordinary paragraph stumbles
// once or thirty times, and that is the question that decides whether a narration is worth
// publishing. So this counts.
//
// It renders nothing. It compares the phonemes `pronounce()` produces with the readings in a
// CMU-format dictionary, word by word, over prose. `--dict` defaults to the dictionary
// vendored in this repository when present, and a full `cmudict.dict` otherwise; passing
// `--dict` is how you check the vendored copy against an upstream one you trust more.
//
// Two numbers matter and they are different defects:
//   * "differs" - the voice says a different sequence of sounds for a word the dictionary
//     knows. This is the audible one: the listener hears another word.
//   * "unreadable" - the voice has no way to say the word at all, and refuses. That is a
//     limitation, not a wrong answer, and a script with one should be rewritten.
//
// Stress marks are stripped before comparing, because the synthesizer has no stress model:
// comparing with them would score the absence of an unimplemented feature as a misspelling.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pronounce, tokenize } from "./lexicon.mjs";

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1] ?? null; };

// A paragraph of the kind this project asks a creator to write: ordinary English, a few
// numbers, a couple of proper nouns, no word chosen to flatter the engine.
export const SAMPLE = `The sea at night is never still. It carries every colour of the sky.
The light is moving over the water. The room is silent as the night comes.
Turn and look out at the street. There is a light under the bridge.
Walk slowly down toward the house. The garden is quiet in the rain.
A window shines in the distance. The path goes past the old stone wall.
Open the blue door. Close the red gate. Every city has a story to tell.
The picture on the wall is a photograph of the ocean at sunrise.
She moved through the crowd without saying a single word.
Science and music change how we hear the world.
The table was set for eight people at half past seven.
Three hundred and forty two boats left the harbour before dawn.
Nothing about the building looks the same in the morning light.
He wanted to know what the machine was doing and why it mattered.
Against the wall, around the garden, the wind was never quiet.`;

function loadDictionary(path) {
  const map = new Map();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith(";;;")) continue;
    const match = /^(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    let [, key, rest] = match;
    const alt = /^(.*)\(\d+\)$/.exec(key);
    if (alt) key = alt[1];
    key = key.toLowerCase();
    if (!/^[a-z']+$/.test(key)) continue;
    const reading = rest.split(/\s+/).map(p => p.replace(/[0-2]$/, "")).join(" ");
    const list = map.get(key);
    if (list) list.push(reading); else map.set(key, [reading]);
  }
  return map;
}

export function compare(text, dict) {
  // Unique, lowercased words in first-appearance order, so a repeated word is not counted
  // twice as if it were two findings - and with `tokenize`, so this judges exactly the words
  // the renderer would speak, not a separate regex that could drift from it.
  const seen = new Set();
  const words = [];
  const { tokens, unreadable: refused } = tokenize(text);
  for (const token of tokens) {
    const w = token.word.toLowerCase();
    if (!seen.has(w)) { seen.add(w); words.push(w); }
  }
  // `tokenize` already refuses what it cannot spell and *drops* it - which would make the
  // words this report exists to name invisible to it. A word the voice cannot say is the
  // finding, not a filter, so it is taken from the tokenizer's own refusal list.
  const differs = [], unreadable = [], unknown = [];
  for (const raw of refused) {
    const w = raw.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    if (w && !seen.has(w)) { seen.add(w); unreadable.push(w); }
  }
  let agrees = 0;
  for (const w of words) {
    let mine;
    try { mine = pronounce(w); } catch { unreadable.push(w); continue; }
    // The tokenizer refuses some words the rules could spell (a vowel-less cluster such as
    // `pfft` renders as a click), and those never reach the branch above.
    if (!tokenize(w).tokens.length) { unreadable.push(w); continue; }
    const ref = dict.get(w);
    if (!ref) { unknown.push(w); continue; }
    const said = mine.join(" ");
    if (ref.includes(said)) agrees++;
    else differs.push({ word: w, said, dictionary: ref[0] });
  }
  const judged = agrees + differs.length;
  return {
    words: words.length, agrees, differs, unreadable, unknown,
    // The headline: of the words both the voice and the dictionary can speak, how many sound
    // wrong. Unknown words are excluded rather than counted as failures, because a proper
    // noun the dictionary never had is not evidence about the rules.
    wrongShare: judged ? Number((differs.length / judged).toFixed(3)) : 0
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-pronunciation.mjs")) {
  const vendored = fileURLToPath(new URL("../vendor/cmudict/dict.txt.gz", import.meta.url));
  const explicit = arg("dict");
  let path = explicit;
  if (!path) {
    if (!existsSync(vendored)) { console.error("no vendored dictionary and no --dict given"); process.exit(1); }
    // The vendored file is gzipped; decompress to a string the parser above can read.
    const { gunzipSync } = await import("node:zlib");
    const text = gunzipSync(readFileSync(vendored)).toString("utf8");
    const dict = new Map();
    for (const line of text.split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      dict.set(line.slice(0, tab), line.slice(tab + 1).split(";").map(p => p.replace(/\s+/g, " ")));
    }
    report(compare(arg("text") ? readFileSync(arg("text"), "utf8") : SAMPLE, dict), explicit || vendored);
    process.exit(0);
  }
  report(compare(arg("text") ? readFileSync(arg("text"), "utf8") : SAMPLE, loadDictionary(path)), path);
}

function report(result, path) {
  console.log(`dictionary: ${path}`);
  const judged = result.agrees + result.differs.length;
  console.log(`${result.words} distinct words; ${judged} the dictionary also knows`);
  console.log(`  agree      ${result.agrees}`);
  console.log(`  differ     ${result.differs.length}  (${(result.wrongShare * 100).toFixed(1)}% of judged words)`);
  console.log(`  unreadable ${result.unreadable.length}${result.unreadable.length ? ` [${result.unreadable.join(", ")}]` : ""}`);
  console.log(`  unknown    ${result.unknown.length}${result.unknown.length ? ` [${result.unknown.slice(0, 12).join(", ")}${result.unknown.length > 12 ? ", ..." : ""}]` : ""}`);
  for (const d of result.differs) console.log(`  ! ${d.word.padEnd(12)} says ${d.said.padEnd(22)} dictionary ${d.dictionary}`);
}
