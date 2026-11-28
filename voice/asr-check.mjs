// Does an independent recognizer hear this voice? A measurement, not a test.
//
//   node voice/asr-check.mjs --python /path/to/venv/bin/python --model /path/to/tiny-en [--script FILE]
//   node voice/asr-check.mjs --stub '{"text": "Hello there world again."}' --script FILE
//
// WHY THIS EXISTS. Every other check of the narration measures the *signal*: it is speech-shaped,
// its phrases follow one another, its words are words the voice can say, and the card can bind each
// phrase to the sound it makes. All of that can be true of a voice nobody can understand - and it
// was. An independent recognizer (faster-whisper tiny.en) transcribed this voice's narration as
// nothing at all on the project's own 69-word corpus, while transcribing eSpeak on the same words at
// WER 0.043. This script reproduces that measurement with a recognizer you supply, so a change to
// the voice can be judged by the same number rather than by an impression.
//
// `--stub` runs the *verdict* against a fixed transcript instead of a real recording. That is what
// makes the reading testable: the reading lives in `voice/transcript.mjs`, this file only prints it,
// and the test drives this entry with a stub rather than re-implementing the logic beside it. A
// first version of the test did re-implement it and stayed green while the tool was wrong.
//
// It is deliberately NOT part of `npm test` in its real-recognizer form: it needs a Python venv and a
// model that are not part of this repository, and a skip there would be indistinguishable from a
// pass. The stub form needs neither, and the reading it exercises is covered by `npm test`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTranscript, verdict } from "./transcript.mjs";

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };

// The project's own listening corpus, the same 69 words the two measurements above used.
export const CORPUS = [
  "The sea at night is never still.",
  "It carries every colour of the sky.",
  "The picture on the wall is a photograph of the ocean at sunrise.",
  "Science and music change how we hear the world.",
  "He wanted to know what the machine was doing.",
  "Nothing about the building looks the same in the morning light.",
  "Walk slowly down toward the house.",
  "The garden is quiet in the rain.",
];

// The reference number is a fact about ONE corpus and is only quoted for it. A first version printed
// it for every script, so an operator's own 20-word script was compared with a bar of 0.043 when the
// real reference for those words is 0.15. A comparison against the wrong corpus reads as a
// measurement and is not one.
const REFERENCE_WER = 0.043; // eSpeak, on CORPUS, this machine, 2026-11-28

const scriptPath = arg("script");
const stub = arg("stub");
const engine = arg("engine");
const base = mkdtempSync(join(tmpdir(), "hypermaker-asr-"));
const script = scriptPath || join(base, "script.txt");
if (!scriptPath) writeFileSync(script, CORPUS.join("\n"));
const usingCorpus = !scriptPath;

let heard, segments, recognizer;
if (stub) {
  // The verdict path without a recognizer or a render: the transcript is given.
  const fixed = JSON.parse(stub);
  heard = String(fixed.text ?? "");
  segments = Number.isInteger(fixed.segments) ? fixed.segments : null;
  recognizer = "stub transcript";
} else {
  const python = arg("python"), model = arg("model");
  if (!python || !model) {
    console.error("usage: node voice/asr-check.mjs --python <venv/bin/python> --model <model dir> [--script FILE] [--engine espeak-ng [--speed N]]");
    console.error("       node voice/asr-check.mjs --stub '{\"text\": \"...\"}' [--script FILE]");
    console.error("\n--engine measures that engine's take instead of the built-in voice's, through the same");
    console.error("renderer. Without it this measures the formant voice, which is what a machine with no");
    console.error("engine installed actually gets.");
    process.exit(1);
  }
  const wav = join(base, "take.wav"), timeline = join(base, "timeline.json");
  // Which mouth is measured. Without this the tool always measured the built-in voice, which made
  // it useless for the one question it exists to answer after an engine is installed: does *this
  // build's* narration get understood? `--engine espeak-ng` measures the engine's take through the
  // same real renderer, so `--check` and its acoustics apply to the same bytes.
  const mouth = engine ? ["--engine", engine, ...(arg("speed") ? ["--speed", arg("speed")] : [])] : [];
  execFileSync(process.execPath, [join(import.meta.dirname, "render.mjs"), "--file", script, "--out", wav, "--timeline", timeline, ...mouth], { stdio: "pipe" });
  // The recognizer runs in the caller's Python and returns its transcript; every judgement about
  // what those words mean is made here, in the module the tests import.
  const py = `
import json, sys
from faster_whisper import WhisperModel
engine = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", cpu_threads=3, local_files_only=True)
segments, _ = engine.transcribe(sys.argv[2], language="en", beam_size=5, condition_on_previous_text=False)
segments = list(segments)
print(json.dumps({"segments": len(segments), "heard": " ".join(s.text.strip() for s in segments)}))
`;
  const out = JSON.parse(execFileSync(python, ["-c", py, model, wav], { encoding: "utf8", env: { ...process.env, HF_HOME: process.env.HF_HOME || join(model, "..") } }));
  heard = out.heard ?? ""; segments = out.segments; recognizer = model;
}

const at = readTranscript(readFileSync(script, "utf8"), heard);
const decided = verdict(at, { referenceWer: REFERENCE_WER, referenceApplies: usingCorpus, segments });

console.log(`script:     ${script}${usingCorpus ? " (the project's own 69-word corpus)" : " (your script)"}`);
console.log(`recognizer: ${recognizer}`);
if (segments !== null) console.log(`segments:   ${segments}`);
console.log(`heard:      ${heard || "(nothing)"}`);
console.log(`word error: ${at.edits} of ${at.words} (WER ${at.wer})`);
console.log(`error mix:  ${at.recovered} of ${at.words} words recovered` +
  ` (${at.substitutions} substituted, ${at.deletions} missing, ${at.insertions} extra)`);
console.log(usingCorpus
  ? `bar:        eSpeak on these same 69 words measured WER ${REFERENCE_WER}`
  : "bar:        none for this script. The recorded reference (eSpeak, WER " + REFERENCE_WER + ") is for the\n"
    + "            69-word corpus, not for the words you supplied; measure a reference on your own words\n"
    + "            before comparing. What IS comparable for any script is whether any word was heard.");

if (decided.ok) {
  console.log(`\nPASS: ${decided.message}`);
  process.exit(0);
}
console.log(`\nFAIL (${decided.kind}): ${decided.message}`);
if (decided.kind === "no-words") {
  console.log(`      The narration is audible and measurable but not understood, and no signal-level`);
  console.log(`      check in this repository can see that. This run measured the ${engine ? engine : "built-in formant voice"}${engine ? "" : " - install espeak-ng and pass --engine espeak-ng to measure that instead"}.`);
}
process.exit(decided.kind === "no-words" ? 2 : 3);
