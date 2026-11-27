// Text to phonemes for the offline voice.
//
// There is no speech model on this machine: no espeak, no flite, no GGUF file, neither
// tts.cpp nor bark.cpp, not even the `flite` filter in the ffmpeg Remotion ships. So the
// words have to come from rules and a word list that live in this repository. English
// spelling is famously unhelpful, which is why this file is split the way it is:
//
//   1. a short list of exceptions for the words rules get wrong (`the`, `of`, `one`,
//      `night`, `through` ...). Missing one is audible, so this list is a fact about the
//      voice and it is tested;
//   2. ordered letter-to-sound rules for the rest, applied longest-pattern-first;
//   3. a refusal for anything it cannot read.
//
// The refusal matters as much as the rules. A synthesizer asked to say Chinese text with
// an English rule set does not produce "roughly the right sounds", it produces noise that
// looks like a narration and is not one. `pronounce()` therefore throws for text it cannot
// spell, and both the command line tool and the server check the words before a WAV is
// published. A run that says it narrated something it did not read is the exact failure
// this project keeps writing tests against.

// Vowel letters are the ones whose sound depends on context; consonants are mostly
// one-to-one, so the exceptions below are heavily weighted towards vowels.
const EXCEPTIONS = new Map(Object.entries({
  a: "AH", about: "AH B AW T", above: "AH B AH V", across: "AH K R AO S", again: "AH G EH N",
  against: "AH G EH N S", ago: "AH G OW", all: "AO L", almost: "AO L M OW S T", also: "AO L S OW",
  always: "AO L W EY Z", among: "AH M AH NG", another: "AH N AH DH ER", any: "EH N IY",
  are: "AA R", area: "EH R IY AH", around: "AH R AW N D", as: "AE Z", ask: "AE S K",
  because: "B IH K AO Z", been: "B IH N", before: "B IH F AO R", behind: "B IH HH AY N D",
  being: "B IY IH NG", both: "B OW TH", busy: "B IH Z IY", came: "K EY M", can: "K AE N",
  city: "S IH T IY", close: "K L OW Z", come: "K AH M", comes: "K AH M Z", could: "K UH D",
  do: "D UW", does: "D AH Z", done: "D AH N", door: "D AO R", down: "D AW N", earth: "ER TH",
  eight: "EY T", enough: "IH N AH F", even: "IY V AH N", ever: "EH V ER", every: "EH V R IY",
  eye: "AY", eyes: "AY Z", find: "F AY N D", fire: "F AY ER", first: "F ER S T",
  five: "F AY V", floor: "F L AO R", for: "F AO R", four: "F AO R", friend: "F R EH N D",
  from: "F R AH M", front: "F R AH N T", full: "F UH L", give: "G IH V", goes: "G OW Z",
  gone: "G AO N", good: "G UH D", great: "G R EY T", half: "HH AE F", has: "HH AE Z",
  have: "HH AE V", he: "HH IY", head: "HH EH D", hear: "HH IH R", heard: "HH ER D",
  heart: "HH AA R T", here: "HH IH R", high: "HH AY", his: "HH IH Z", hour: "AW ER",
  house: "HH AW S", how: "HH AW", idea: "AY D IY AH", into: "IH N T UW", is: "IH Z",
  just: "JH AH S T", know: "N OW", land: "L AE N D", laugh: "L AE F", light: "L AY T",
  like: "L AY K", live: "L IH V", long: "L AO NG", look: "L UH K", love: "L AH V",
  made: "M EY D", make: "M EY K", many: "M EH N IY", me: "M IY", might: "M AY T",
  mind: "M AY N D", money: "M AH N IY", moon: "M UW N", more: "M AO R", most: "M OW S T",
  move: "M UW V", much: "M AH CH", must: "M AH S T", my: "M AY", near: "N IH R",
  never: "N EH V ER", new: "N UW", night: "N AY T", no: "N OW", none: "N AH N",
  not: "N AA T", nothing: "N AH TH IH NG", now: "N AW", ocean: "OW SH AH N",
  of: "AH V", off: "AO F", often: "AO F AH N", old: "OW L D", on: "AA N", once: "W AH N S",
  one: "W AH N", only: "OW N L IY", open: "OW P AH N", or: "AO R", other: "AH DH ER",
  our: "AW ER", out: "AW T", over: "OW V ER", own: "OW N", people: "P IY P AH L",
  picture: "P IH K CH ER", place: "P L EY S", put: "P UH T", quiet: "K W AY AH T",
  read: "R IY D", really: "R IH L IY", right: "R AY T", river: "R IH V ER",
  said: "S EH D", salt: "S AO L T", same: "S EY M", say: "S EY", says: "S EH Z",
  sea: "S IY", see: "S IY", seven: "S EH V AH N", shall: "SH AE L", she: "SH IY",
  should: "SH UH D", show: "SH OW", side: "S AY D", six: "S IH K S", sky: "S K AY",
  small: "S M AO L", snow: "S N OW", so: "S OW", some: "S AH M", someone: "S AH M W AH N",
  something: "S AH M TH IH NG", sometimes: "S AH M T AY M Z", son: "S AH N", soon: "S UW N",
  sound: "S AW N D", star: "S T AA R", still: "S T IH L", stone: "S T OW N",
  story: "S T AO R IY", such: "S AH CH", sun: "S AH N", sure: "SH UH R",
  take: "T EY K", than: "DH AE N", that: "DH AE T", the: "DH AH", their: "DH EH R",
  them: "DH EH M", then: "DH EH N", there: "DH EH R", these: "DH IY Z", they: "DH EY",
  thing: "TH IH NG", think: "TH IH NG K", this: "DH IH S", those: "DH OW Z", though: "DH OW",
  three: "TH R IY", through: "TH R UW", time: "T AY M", to: "T UW", today: "T AH D EY",
  together: "T AH G EH DH ER", too: "T UW", took: "T UH K", toward: "T AO R D",
  tree: "T R IY", true: "T R UW", two: "T UW", under: "AH N D ER", until: "AH N T IH L",
  upon: "AH P AA N", us: "AH S", very: "V EH R IY", voice: "V OY S", wait: "W EY T",
  walk: "W AO K", wall: "W AO L", want: "W AA N T", war: "W AO R", warm: "W AO R M",
  was: "W AH Z", watch: "W AA CH", water: "W AO T ER", wave: "W EY V", way: "W EY",
  we: "W IY", were: "W ER", what: "W AH T", when: "W EH N", where: "W EH R",
  which: "W IH CH", while: "W AY L", white: "W AY T", who: "HH UW", whole: "HH OW L",
  why: "W AY", will: "W IH L", wind: "W IH N D", with: "W IH TH", without: "W IH TH AW T",
  woman: "W UH M AH N", women: "W IH M AH N", wonder: "W AH N D ER", word: "W ER D",
  work: "W ER K", world: "W ER L D", would: "W UH D", write: "R AY T", wrong: "R AO NG",
  year: "Y IH R", yes: "Y EH S", yet: "Y EH T", you: "Y UW", young: "Y AH NG",
  your: "Y AO R", zero: "Z IH R OW", nine: "N AY N", ten: "T EH N", hundred: "HH AH N D R AH D",
  thousand: "TH AW Z AH N D", minute: "M IH N IH T", second: "S EH K AH N D",
  // Digits are read as words rather than refused: a caption like "chapter 2" is
  // ordinary narration, and spelling out nine digits is not a speech model.
  0: "Z IH R OW", 1: "W AH N", 2: "T UW", 3: "TH R IY", 4: "F AO R", 5: "F AY V",
  6: "S IH K S", 7: "S EH V AH N", 8: "EY T", 9: "N AY N"
}));

// Letter-to-sound rules, applied to the front of what is left. Longest pattern first:
// `ough`, `tion`, `ch`, `sh` and the silent-final-`e` pattern have to win before the
// single-letter fallbacks, or `night` becomes "n-i-g-h-t" and `nation` loses its `sh`.
// Each entry is [pattern, phonemes]; `^` means start of word.
const RULES = [
  // Word-final `le` after a consonant is English's syllabic L: `table`, `little`, `apple`.
  // Without these the rule for `a` sees `ppl` + `e` and turns `apple` into "AY-p-l".
  ["ble$", "B AH L"], ["tle$", "T AH L"], ["ple$", "P AH L"], ["dle$", "D AH L"],
  ["gle$", "G AH L"], ["kle$", "K AH L"], ["fle$", "F AH L"], ["cle$", "K AH L"],
  ["zle$", "Z AH L"], ["le$", "AH L"],
  // A doubled consonant is written twice and said once.
  ["bb", "B"], ["cc", "K"], ["dd", "D"], ["ff", "F"], ["gg", "G"], ["ll", "L"],
  ["mm", "M"], ["nn", "N"], ["pp", "P"], ["rr", "R"], ["ss", "S"], ["tt", "T"], ["zz", "Z"],
  // Whole clusters that English spells one way and says another.
  ["ough$", "AO"], ["ought", "AO T"], ["augh", "AO"], ["eigh", "EY"], ["igh", "AY"],
  ["tion", "SH AH N"], ["sion", "ZH AH N"], ["cious", "SH AH S"], ["tious", "SH AH S"],
  ["ture", "CH ER"], ["sure", "ZH ER"], ["cial", "SH AH L"], ["tial", "SH AH L"],
  ["ck", "K"], ["ph", "F"], ["sh", "SH"], ["th", "TH"], ["ch", "CH"], ["wh", "W"],
  ["qu", "K W"], ["ng", "NG"], ["kn", "N"], ["wr", "R"], ["ps", "S"], ["gn", "N"],
  ["dg", "JH"], ["tch", "CH"], ["dge", "JH"], ["gue", "G"], ["que", "K"],
  // Vowel digraphs.
  ["ee", "IY"], ["ea", "IY"], ["ie", "IY"], ["ei", "EY"], ["ey", "EY"], ["ai", "EY"],
  ["ay", "EY"], ["oa", "OW"], ["oe", "OW"], ["oo", "UW"], ["ou", "AW"], ["ow", "AW"],
  ["oi", "OY"], ["oy", "OY"], ["au", "AO"], ["aw", "AO"], ["ue", "UW"], ["ui", "UW"],
  // A final `y` after a consonant is the vowel `ee` (`city`, `story`, `sky` used to be an
  // exception for exactly this reason). It has to be listed *before* the consonant table,
  // or `["y", "Y"]` claims every final `y` and this rule is dead code.
  ["y$", "IY"],
  ["ar", "AA R"], ["er", "ER"], ["ir", "ER"], ["ur", "ER"], ["or", "AO R"],
  // R-coloured vowels must not leave a separate `r`.
  ["air", "EH R"], ["ear", "IH R"], ["eer", "IH R"], ["our", "AW ER"], ["oor", "AO R"],
  // Consonants with a fixed sound, including the two `c` and `g` splits.
  ["c(?=[eiy])", "S"], ["c", "K"], ["g(?=[eiy])", "JH"], ["g", "G"],
  ["b", "B"], ["d", "D"], ["f", "F"], ["h", "HH"], ["j", "JH"], ["k", "K"], ["l", "L"],
  ["m", "M"], ["n", "N"], ["p", "P"], ["r", "R"], ["s", "S"], ["t", "T"], ["v", "V"],
  ["w", "W"], ["x", "K S"], ["y", "Y"], ["z", "Z"],
  // Silent final `e` lengthens the vowel only when exactly one consonant sits between
  // them: `time`, `stone`, `wave`. With `[^aeiou]*` this also fired on `apple` (ppl) and
  // on `little` (ttl), turning every such word into a diphthong; the syllabic-`le` rules
  // above now claim those first, and this narrowed pattern leaves them alone.
  ["a(?=[^aeiou]e$)", "EY"], ["i(?=[^aeiou]e$)", "AY"], ["o(?=[^aeiou]e$)", "OW"],
  ["u(?=[^aeiou]e$)", "UW"], ["e(?=[^aeiou]e$)", "IY"],
  // Short vowels are the default once the digraph rules have had their turn.
  ["a", "AE"], ["e", "EH"], ["i", "IH"], ["o", "AA"], ["u", "AH"], ["y", "IH"]
];

// A word with no vowel sound at all (`rhythm`, `hmm`) cannot be spoken as written; the
// rules would produce a consonant cluster that the synthesizer renders as a click.
const VOWELS = new Set("IY IH EY EH AE AA AO OW UH UW AH ER AY OY AW".split(" "));

export function pronounce(word) {
  const clean = String(word).toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  if (!clean) return [];
  if (EXCEPTIONS.has(clean)) return EXCEPTIONS.get(clean).split(" ");
  if (/^\d+$/.test(clean)) {
    // Multi-digit numbers are read digit by digit rather than refused: no card in this
    // app needs "one thousand two hundred", and inventing it would be a number engine,
    // not a voice.
    return clean.split("").flatMap(d => EXCEPTIONS.get(d).split(" "));
  }
  const out = [];
  let s = clean;
  while (s.length) {
    const rule = RULES.find(([pattern]) => {
      const m = pattern.startsWith("^") ? null : null;
      return new RegExp(`^(?:${pattern})`).test(s);
    });
    if (!rule) { s = s.slice(1); continue; }
    const [pattern, phonemes] = rule;
    const match = new RegExp(`^(?:${pattern})`).exec(s)[0];
    // The silent final `e`: matched by a rule only to be dropped after it has coloured
    // the vowel before it. Any other match produces its sounds.
    const silent = match === "e" && s.length === 1 && clean.length > 2;
    if (!silent) out.push(...phonemes.split(" "));
    s = s.slice(match.length);
    if (!s.length) break;
  }
  if (!out.some(p => VOWELS.has(p))) throw new Error(`the offline voice cannot say "${clean}": no vowel in the rule output`);
  return out;
}

// Split text into words, keeping sentence punctuation so the voice can put a pause and a
// falling pitch at the end of a sentence rather than running all of them together.
export function tokenize(text) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const unreadable = [];
  const tokens = words.map(raw => {
    const cleaned = raw.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, "");
    const punctuation = /[.!?]$/.test(raw) ? "sentence" : /[,;:]$/.test(raw) ? "clause" : "";
    // A token with no letters or digits left is punctuation, and punctuation is a pause.
    // Except when the token *was* letters - just not Latin ones. A Chinese sentence used to
    // vanish here: every word was stripped to nothing and quietly dropped, the render
    // produced a zero-length WAV, and the command exited 0. That is a narration of nothing
    // reported as a success, which is the failure this whole file is written against. A
    // letter this rule set cannot read is a refusal, and it says so.
    if (!cleaned) { if (/\p{L}/u.test(raw)) unreadable.push(raw); return null; }
    if (!/^[A-Za-z0-9']+$/.test(cleaned)) { unreadable.push(raw); return null; }
    let phonemes;
    try { phonemes = pronounce(cleaned); } catch { unreadable.push(raw); return null; }
    return { word: cleaned, phonemes, punctuation };
  }).filter(Boolean);
  return { tokens, unreadable };
}

// Everything a caller needs to know before speaking: which words this voice can say, and
// which it cannot. The server runs this against the agent's script so a published WAV
// cannot claim words the engine never pronounced.
// `syllables` counts the vowels the engine will actually pronounce, which is the right
// number to compare an onset count against. Words were the wrong unit and it took a real
// measurement to see it: `carries` is two syllables and `cat` is one, so a sentence of
// fourteen words can have nineteen syllables and a check against words either passes a bad
// render or fails a good one. Counting the vowel phonemes is exact, because they are the
// same list the synthesizer renders.
const VOWEL_SET = new Set("IY IH EY EH AE AA AO OW UH UW AH ER AY OY AW".split(" "));
export function audit(text) {
  const { tokens, unreadable } = tokenize(text);
  return {
    words: tokens.length,
    syllables: tokens.reduce((n, t) => n + t.phonemes.filter(p => VOWEL_SET.has(p)).length, 0),
    unreadable,
    phonemeCount: tokens.reduce((n, t) => n + t.phonemes.length, 0)
  };
}
