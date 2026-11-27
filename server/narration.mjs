// A card that says it narrated something has to have narrated it.
//
// The agent writes a WAV and, next to it, a `timeline.json` saying which phrase is spoken
// when. Neither file is evidence on its own: an agent that writes a convincing JSON and a
// file of noise produces a card that plays a hiss while the record claims a sentence. So
// two independent things are checked before publishing, and each can fail alone:
//
//   1. the timeline describes *this* WAV - its phrases follow one another and add up to the
//      file's real length, and every word in them is one the shipped voice can say;
//   2. the file itself measures as speech - syllable onsets, periodic sound, more than one
//      vowel region.
//
// The thresholds are not repeated here. `judge()` in `voice/render.mjs` owns them, and it is
// what `node voice/render.mjs --check` runs, so an agent reporting the tool's numbers and a
// server checking the same bytes cannot disagree about them.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { judge } from "../voice/render.mjs";
import { audit, CURRENT_READINGS } from "../voice/lexicon.mjs";
import { wavSamples } from "../voice/wav.mjs";
import { appearsInOrder, bindTake, spokenWords, wordsOf } from "../voice/bind.mjs";

// `material` is what the card was reading: the frozen text inputs (or the user prompt when
// there is no text input), already concatenated by the caller. It is the third thing the
// narration is checked against, and it is the one a reviewer found missing: the text of a
// take and the sound of a take could come from two different runs, so the card wrote one
// sentence and played another. Passing it in makes "what did it read" a fact about the
// card rather than a claim in a JSON file.
// `from` is the card the material came from, when there was one: {id, artifact}. It is
// recorded in the evidence so a reopened card can say whose words were read, not only which
// words - the creator asked for both.
export function verifyNarration({ attemptDir, artifact, material = null, from = null }) {
  const wav = join(attemptDir, basename(String(artifact || "")));
  const problems = [];
  let bound = null;
  if (!artifact || !existsSync(wav)) return { ok: false, problems: [`the run named ${artifact || "no artifact"}, which is not a file in its directory`], report: null };

  // A missing timeline is a failure, not a shrug: it is the record that makes the claim
  // checkable, and a narrated card without one cannot be told apart from a tone card that
  // was described as speech.
  const timelinePath = join(attemptDir, "timeline.json");
  let timeline = null;
  try { timeline = JSON.parse(readFileSync(timelinePath, "utf8")); }
  catch (error) { problems.push(`no readable timeline.json next to the WAV (${error.code === "ENOENT" ? "the file is missing" : error.message}), so nothing records which words were spoken when`); }

  const { rate, samples } = wavSamples(readFileSync(wav));
  const seconds = samples.length / rate;
  let words = "";
  if (timeline) {
    const phrases = Array.isArray(timeline.phrases) ? timeline.phrases : [];
    if (!phrases.length) problems.push("timeline.json lists no phrases");
    // Contiguous and positive: a timeline that overlaps itself or counts backwards
    // describes audio nobody rendered.
    let cursor = 0;
    phrases.forEach((phrase, i) => {
      const text = typeof phrase?.text === "string" ? phrase.text.trim() : "";
      if (!text) problems.push(`phrase ${i + 1} has no text`);
      const start = Number(phrase?.start), duration = Number(phrase?.duration);
      if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) problems.push(`phrase ${i + 1} has no usable start/duration`);
      else {
        if (Math.abs(start - cursor) > 0.2) problems.push(`phrase ${i + 1} starts at ${start.toFixed(2)}s but the previous one ended at ${cursor.toFixed(2)}s`);
        cursor = start + duration;
      }
      const unreadable = audit(text).unreadable;
      if (unreadable.length) problems.push(`phrase ${i + 1} uses words this voice cannot say: ${[...new Set(unreadable)].join(", ")}`);
      words += ` ${text}`;
    });
    // The file's own length, not the timeline's claim about it. A tolerance for the tail of
    // the last phrase, but not for a WAV twice as long as the script it claims to say.
    const tolerance = Math.max(0.2, seconds * 0.02);
    if (cursor && Math.abs(cursor - seconds) > tolerance) {
      problems.push(`the timeline lasts ${cursor.toFixed(2)}s but the WAV is ${seconds.toFixed(2)}s, so it does not describe this file`);
    }

    // Length agreement is not enough, and this is the bug a reviewer reproduced: two takes
    // of different sentences can have the same duration to the sample, and the old check was
    // happy with either one's timeline beside either one's audio. Rendering is deterministic,
    // so the published bytes can be compared with the sound these very words make.
    if (phrases.length && problems.length === 0) {
      bound = bindTake({ file: wav, timeline });
      if (!bound.ok) problems.push(...bound.problems);
    }

    // And the script has to be a selection of what the card was reading, not merely a list
    // of pronounceable words. Without this an agent can speak a fluent sentence about
    // something else, and the card will honestly report that it said it - true of the file,
    // false about the card.
    if (material != null) {
      const source = wordsOf(material);
      // A card with no text input narrates its own prompt, and the caller passes that.
      if (!source.length) problems.push("this card had no text to read, so a narration of it cannot be shown to come from its material");
      else {
        const { ok, missing } = appearsInOrder(spokenWords(timeline), source);
        if (!ok) problems.push(`the script says ${[...new Set(missing)].map(w => `"${w}"`).join(", ")}, which ${missing.length === 1 ? "is" : "are"} not in the material this card was given; a narration may leave words out but cannot add them`);
      }
    }
  }

  // Measured only when the timeline held up: running the judge against an unknown script
  // would compare onsets with no words and report a vaguer problem than the real one.
  const report = problems.length ? null : judge(wav, words);
  if (report) problems.push(...report.problems);
  // The evidence that outlives the attempt directory. A narration's record is what makes the
  // card worth trusting tomorrow: the phrases it said and when, plus the numbers measured
  // from the bytes. Without it a reopened workspace would only know that a WAV exists.
  const evidence = report && !problems.length ? {
    verdict: report.verdict,
    seconds: Number(report.seconds.toFixed(2)),
    words: report.words,
    onsets: report.onsets,
    vowelKinds: report.vowelKinds,
    voicedShare: Number(report.voicedShare.toFixed(2)),
    peak: report.peakSample,
    phrases: (timeline?.phrases || []).map(p => ({ text: String(p.text).trim(), start: Number(Number(p.start).toFixed(2)), duration: Number(Number(p.duration).toFixed(2)) })),
    // How the words over the player were tied to the sound under it: the published bytes
    // were re-rendered from this very script and agreed to this correlation. Kept because
    // it is what a person is trusting when they read the sentence and press play, and it is
    // a number a later check cannot quietly stop computing.
    take: {
      correlation: bound?.correlation ?? null,
      // Set only when the timeline's own settings could not reproduce the audio and the take
      // was accepted at settings recovered from within the precision the record was written
      // at. It is evidence of an imprecise record, not of a bad take: the words are the
      // card's words, and a reader should not later be told the record was exact when it was
      // not. `matched` is what the audio is; `recorded` is what the file claimed.
      ...(bound?.voice ? { voice: bound.voice } : {})
    },
    // Which card was read, when there was one. Provenance the creator asked for: reopening
    // the workspace must say both what was said and where the words came from.
    source: from ? { id: Number(from.id), artifact: from.artifact ?? null } : null,
    // The voice this build speaks with, so a take that verified under an older table can be
    // described as older rather than as identical. Without it the card cannot tell a recording
    // made before a pronunciation or stress fix from one made after, and the creator has no way
    // to know which of two takes is worth regenerating. It is the build's setting, not the
    // take's - the take's own table is under `take.voice`.
    currentReadings: CURRENT_READINGS
  } : null;
  return { ok: problems.length === 0, problems, report, evidence, seconds, words: words.trim() };
}
