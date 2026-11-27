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
import { audit } from "../voice/lexicon.mjs";
import { wavSamples } from "../voice/wav.mjs";

export function verifyNarration({ attemptDir, artifact }) {
  const wav = join(attemptDir, basename(String(artifact || "")));
  const problems = [];
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
    phrases: (timeline?.phrases || []).map(p => ({ text: String(p.text).trim(), start: Number(Number(p.start).toFixed(2)), duration: Number(Number(p.duration).toFixed(2)) }))
  } : null;
  return { ok: problems.length === 0, problems, report, evidence, seconds, words: words.trim() };
}
