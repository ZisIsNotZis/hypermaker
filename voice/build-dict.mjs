#!/usr/bin/env node
// Turn a CMU pronouncing dictionary into the compact table `voice/lexicon.mjs` reads.
//
//   node voice/build-dict.mjs /path/to/cmudict.dict vendor/cmudict/dict.txt.gz
//
// The dictionary is vendored rather than downloaded because the whole point of this voice is
// that it works with nothing installed and no network. CMUdict is BSD-licensed and may be
// redistributed with its notice (`vendor/cmudict/LICENSE`), which is why this file exists: the
// shipped table is regenerable from a public source instead of being an opaque blob.
//
// What changes on the way in:
//   * stress digits are dropped (`AH0` -> `AH`). The synthesizer has no notion of stress yet,
//     so shipping it would be a promise the audio does not keep.
//   * every pronunciation of a homograph is kept, joined by `;` (`read` is both "red" and
//     "reed"). A model picks one from context; this voice has no context, so `lexicon.mjs`
//     names the reading it prefers in a small table rather than losing the alternative here.
//     No context at all is still better than the alternative: a homograph read with the
//     wrong vowel is a word a listener hears as a different word.
//   * entries whose symbols include cmudict's own markers (`name`, `french`, `abbrev`, the
//     trailing punctuation on some keys) are dropped, as are keys with punctuation other than
//     an internal apostrophe. The engine must never be handed a symbol it cannot render.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname } from "node:path";
import { VOWEL_TARGETS, CONSONANTS } from "./synth.mjs";

// Exactly what `voice/synth.mjs` can render. A dictionary entry with any other symbol is not
// skipped silently at runtime, it is dropped here where the reason is visible.
const RENDERABLE = new Set([...Object.keys(VOWEL_TARGETS), ...Object.keys(CONSONANTS)]);

export function compact(source) {
  const at = new Map();
  const entries = [];
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
    const phonemes = rest.split(/\s+/).map(p => p.replace(/[0-2]$/, ""));
    if (!phonemes.length || phonemes.some(p => !RENDERABLE.has(p))) { droppedSymbol++; continue; }
    const said = phonemes.join(" ");
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
  return { text: entries.join("\n") + "\n", total, kept, droppedSymbol, droppedKey };
}
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("build-dict.mjs")) {
  const [from, to = "vendor/cmudict/dict.txt.gz"] = process.argv.slice(2);
  if (!from) { console.error("usage: node voice/build-dict.mjs /path/to/cmudict.dict [vendor/cmudict/dict.txt.gz]"); process.exit(1); }
  const result = compact(readFileSync(from, "utf8"));
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, gzipSync(Buffer.from(result.text), { level: 9 }));
  console.error(`read ${result.total} lines: kept ${result.kept}, dropped ${result.droppedSymbol} with symbols this voice cannot render, ${result.droppedKey} with a key it cannot say -> ${to}`);
}
