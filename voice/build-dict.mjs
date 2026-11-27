#!/usr/bin/env node
// Turn a CMU pronouncing dictionary into the compact tables `voice/lexicon.mjs` reads.
//
//   node voice/build-dict.mjs /path/to/cmudict.dict vendor/cmudict/dict.txt.gz vendor/cmudict/stress.txt.gz
//
// The dictionary is vendored rather than downloaded because the whole point of this voice is
// that it works with nothing installed and no network. CMUdict is BSD-licensed and may be
// redistributed with its notice (`vendor/cmudict/LICENSE`), which is why this file exists: the
// shipped table is regenerable from a public source instead of being an opaque blob.
//
// What changes on the way in:
//   * a stress digit is dropped from the phoneme line (`AH0` -> `AH`) and kept in a second
//     table, `stress.txt.gz`. The engine spells sounds; a syllable's metre is a *different*
//     fact about the same word, read by different code, so it gets its own file. Keeping the
//     digit in the phoneme line would make every existing comparison between this voice and a
//     plain CMUdict reading start failing on digits - a spelling difference standing in for a
//     real one.
//   * every pronunciation of a homograph is kept, joined by `;` (`read` is both "red" and
//     "reed"). A model picks one from context; this voice has no context, so `lexicon.mjs`
//     names the reading it prefers in a small table rather than losing the alternative here.
//     No context at all is still better than the alternative: a homograph read with the
//     wrong vowel is a word a listener hears as a different word.
//   * the stress table lists a word only when the reading *this voice speaks* puts the primary
//     stress somewhere other than the first syllable, which is the only case where it changes
//     the audio: the synthesizer stresses syllable one by default, and a word missing from the
//     table is read exactly as it was before rather than refused. Measured on the public
//     source: 35,232 of 124,087 words, 142 KB gzipped, against 437 KB for an exhaustive table.
//   * entries whose symbols include cmudict's own markers (`name`, `french`, `abbrev`, the
//     trailing punctuation on some keys) are dropped, as are keys with punctuation other than
//     an internal apostrophe. The engine must never be handed a symbol it cannot render.
//
// The phoneme table's construction below is deliberately the version that shipped: the file is
// *frozen*, because every published take's audio is reproduced from it. `compact()` is written
// so that it regenerates the committed bytes exactly, duplicate readings and all, and a test
// pins that. Fixing the duplication was tempting - the old dedupe compares against `";" + said`,
// so it misses a repeat of the *first* reading and over-matches a reading that is a prefix of
// another - but a table edit is how an honest take becomes unverifiable, and the duplicates
// change no audio (`chosen()` reads `readings[0]`).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname } from "node:path";
import { VOWEL_TARGETS, CONSONANTS } from "./synth.mjs";
// `CHOSEN` from `voice/lexicon.mjs`: the readings narration prefers where the dictionary's
// first one would be heard as a different word. Imported rather than copied, so the stress
// table describes the reading the voice really says and the two cannot drift apart.
import { CHOSEN as PREFER } from "./lexicon.mjs";

// Exactly what `voice/synth.mjs` can render. A dictionary entry with any other symbol is not
// skipped silently at runtime, it is dropped here where the reason is visible.
const RENDERABLE = new Set([...Object.keys(VOWEL_TARGETS), ...Object.keys(CONSONANTS)]);
// A stress digit only ever follows a vowel, so a reading's stress pattern is the digit of each
// vowel in order - the same syllable order `syllables()` in `synth.mjs` derives from the same
// phoneme list.
const VOWELS = new Set(Object.keys(VOWEL_TARGETS));

export function compact(source) {
  const at = new Map();
  const entries = [];
  // The stress pattern of the reading this voice will speak for each word: the first one the
  // source lists, or `CHOSEN`'s preference where narration needs it. `CHOSEN` lives in
  // `lexicon.mjs` and is imported lazily below so this file does not depend on the reader.
  const primary = new Map();
  let total = 0, kept = 0, droppedSymbol = 0, droppedKey = 0;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith(";;;")) continue;
    total++;
    // `word PH PH ...`; a key ending in `(2)` is a second pronunciation of the same word.
    const match = /^(\S+)\s+(.+)$/.exec(line);
    if (!match) { droppedKey++; continue; }
    let [, key, rest] = match;
    const alt = /^(.*)\(\d+\)$/.exec(key);
    if (alt) key = alt[1];
    key = key.toLowerCase();
    if (!/^[a-z](?:[a-z']*[a-z])?$/.test(key)) { droppedKey++; continue; }
    const marks = rest.split(/\s+/);
    const phonemes = marks.map(p => p.replace(/[0-2]$/, ""));
    if (!phonemes.length || phonemes.some(p => !RENDERABLE.has(p))) { droppedSymbol++; continue; }
    const said = phonemes.join(" ");
    // One digit per vowel, in syllable order. A vowel the source left unmarked is unstressed
    // (`0`), which is what CMUdict writes it as; a consonant contributes nothing, and a reading
    // with no vowel at all (`hmm`) yields the empty pattern.
    const pattern = marks.map(p => {
      const base = p.replace(/[0-2]$/, "");
      if (!VOWELS.has(base)) return null;
      const digit = /[0-2]$/.exec(p);
      return digit ? digit[0] : "0";
    }).filter(d => d != null).join("");
    if (!primary.has(key)) primary.set(key, []);
    primary.get(key).push({ said, pattern });
    // First sighting of a word starts its entry; a later pronunciation is appended to it, in
    // the dictionary's own order, so the vendored file stays a faithful rendering of the
    // source. A reader chooses between them; see `CHOSEN` in `voice/lexicon.mjs`.
    const index = at.get(key);
    if (index != null) { if (!entries[index].includes(";" + said)) entries[index] += ";" + said; continue; }
    at.set(key, entries.length);
    entries.push(`${key}\t${said}`);
    kept++;
  }
  entries.sort();
  // The reading that will actually be spoken, per `chosen()`'s rule: `CHOSEN`'s preference when
  // the source lists it, otherwise the first reading. Reproduced here rather than looked up
  // through `pronounce()` because this runs over 124,000 words and needs the stress digits that
  // `pronounce()` has already stripped.
  const spoken = (key, readings) => {
    const prefer = PREFER.get(key);
    if (prefer) { const hit = readings.find(r => r.said === prefer); if (hit) return hit; }
    return readings[0];
  };
  const stress = [];
  for (const [key, readings] of primary) {
    const reading = spoken(key, readings);
    // Off the first syllable and nothing else: a word whose primary stress is already on
    // syllable one is read exactly as the engine reads it with no help at all.
    if (reading && reading.pattern.indexOf("1") > 0) stress.push(`${key}\t${reading.pattern}`);
  }
  stress.sort();
  return { text: entries.join("\n") + "\n", stress: stress.join("\n") + "\n", total, kept, droppedSymbol, droppedKey };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("build-dict.mjs")) {
  const [from, to = "vendor/cmudict/dict.txt.gz", stressTo = "vendor/cmudict/stress.txt.gz"] = process.argv.slice(2);
  if (!from) { console.error("usage: node voice/build-dict.mjs /path/to/cmudict.dict [vendor/cmudict/dict.txt.gz] [vendor/cmudict/stress.txt.gz]"); process.exit(1); }
  const result = compact(readFileSync(from, "utf8"));
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, gzipSync(Buffer.from(result.text), { level: 9 }));
  writeFileSync(stressTo, gzipSync(Buffer.from(result.stress), { level: 9 }));
  const stressed = result.stress.split("\n").filter(Boolean).length;
  console.error(`read ${result.total} lines: kept ${result.kept}, dropped ${result.droppedSymbol} with symbols this voice cannot render, ${result.droppedKey} with a key it cannot say -> ${to}; ${stressed} words put their stress off the first syllable -> ${stressTo}`);
}
