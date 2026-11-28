// Reading a transcript against the script it was supposed to be.
//
// This lives in its own module because it was written twice - once in `voice/asr-check.mjs` and once
// in its test - and the test passed while the tool was wrong. An operator proved it: changing the
// tool's verdict back to "total edits equal to word count means nothing was heard" left the suite
// green, because the suite was checking a copy. There is one implementation now, and both the tool
// and the tests import it.
//
// The distinction the numbers have to carry, learned from two operator reports:
//
//   * "Hello world" heard as "Hello there world again" is TWO EXTRA WORDS with both real words in
//     place. Calling that "not one word was heard" is not a rounding error, it is a false report of
//     the worst possible failure.
//   * so the verdict is about words RECOVERED, not about the edit count. An edit count folds
//     substitutions, insertions and deletions into one number and cannot answer "was I heard?".
//   * and when every word was recovered but the rate is still high, the problem is the recognizer
//     adding words. That is a noisy reading, not lost speech, and it is reported as such.

export const words = text => (String(text).toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || []);

// A global alignment, so the answer says which KIND of error each one is.
export function align(reference, heard) {
  const n = reference.length, m = heard.length;
  const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (reference[i - 1] !== heard[j - 1] ? 1 : 0));
    }
  }
  let substitutions = 0, insertions = 0, deletions = 0, i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (reference[i - 1] !== heard[j - 1] ? 1 : 0)) {
      if (reference[i - 1] !== heard[j - 1]) substitutions++;
      i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { deletions++; i--; }
    else { insertions++; j--; }
  }
  return {
    words: n,
    edits: substitutions + insertions + deletions,
    substitutions, insertions, deletions,
    // A script word is recovered unless it was replaced or dropped. An extra word the recognizer
    // invented says nothing about whether the script was heard.
    recovered: n - substitutions - deletions,
    wer: Number(((substitutions + insertions + deletions) / Math.max(1, n)).toFixed(3)),
  };
}

export const readTranscript = (script, heard) => align(words(script), words(heard));

// What the reading means, as a verdict a caller acts on. `null` means "heard well enough".
// The reference rate is passed in, and so is whether it applies: a number measured on one corpus is
// not a bar for a different script, and printing it as one was a third report.
export function verdict(at, { referenceWer = null, referenceApplies = false, segments = null } = {}) {
  if (at.recovered === 0) {
    return {
      ok: false,
      kind: "no-words",
      message: `not one word of the script was heard - ${segments === 0 || segments === null
        ? "the recognizer found no speech at all."
        : `the recognizer heard ${segments} segment(s) of something else.`}`,
    };
  }
  const lost = at.words - at.recovered;
  if (at.wer > 0.25) {
    if (lost > 0) {
      return {
        ok: false,
        kind: "lost-words",
        message: `${lost} of ${at.words} script words were not heard (${at.substitutions} substituted, ${at.deletions} missing).`
          + (referenceApplies ? ` The reference reaches ${referenceWer} on these words.` : " There is no recorded reference for this script; the raw rate is what it is."),
      };
    }
    return {
      ok: false,
      kind: "noisy-reading",
      message: `every script word was recovered, but the recognizer added ${at.insertions} word(s) that are not in the script (WER ${at.wer}). That is a noisy reading rather than lost speech.`,
    };
  }
  return { ok: true, kind: "understood", message: `the voice is transcribed close enough to the script to be understood (WER ${at.wer}).` };
}
