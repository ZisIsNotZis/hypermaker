// A real speech engine, used only when one is installed, and named in the take when it is.
//
// WHY THIS EXISTS. `voice/synth.mjs` is a formant synthesizer written for this repository: it
// needs nothing installed, it is byte-deterministic, and every take it makes can be reproduced
// and re-checked from its own record. What it cannot do is be understood. An independent
// recognizer (faster-whisper tiny.en) transcribes its narration as nothing at all on the
// project's own 69-word corpus - WER 1.0 - while transcribing eSpeak on the same words at 3
// errors in 69. That is recorded with its method in `docs/evidence/voice-not-understood.md`, and it
// is not a tuning problem: two candidate repairs to the synthesizer were built, measured, and
// reverted without moving the number.
//
// So the product's answer is not "make the formant voice better", it is "speak with an engine
// when the machine has one". eSpeak NG is the smallest such engine that qualifies:
//
//   * it is a package on this distribution, so a person can install it without an account;
//   * its output is byte-deterministic, which is what every check in `voice/bind.mjs` rests on -
//     a voice whose bytes changed between two renders could not be verified against its own
//     timeline at all;
//   * it is 22050 Hz mono 16-bit PCM, the sample rate this project already reads and writes, so
//     nothing downstream learns a new format;
//   * it is GPL-3.0 and this repository is AGPL-3.0, so invoking it as a separate program is
//     unambiguously fine.
//
// WHAT THIS MODULE DOES NOT DO. It does not vendor the engine. eSpeak's data alone is 25 MB,
// and a repository that carries a synthesizer's voice data is a repository that ships a sound
// nobody can update. Discovery is therefore explicit, in one order, and a *named* engine that is
// absent is a refusal rather than a silent fallback to the built-in voice: a take that says it
// was spoken by eSpeak must never quietly be spoken by something else, because the record is
// what a later check trusts.
//
// It also does not decide anything about words. `renderParagraph` still tokenizes every phrase
// with this repository's lexicon before a byte is rendered, so "every word spoken is a word the
// card was given" and "a symbol this product cannot say is refused by name" hold identically for
// both voices. The engine is a mouth, not an author.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { wavSamples } from "./wav.mjs";

// The engine's name as a *record* names it. A take stores this string; anything else - including
// the built-in voice - is not this module's business.
export const ENGINE = "espeak-ng";
// The voice inside the engine. Pinned rather than left to the engine's default, because the
// default is a setting on someone's machine and the bytes of a published take have to be a fact
// about the take.
//
// `en-us` rather than `en`, and the choice was MEASURED rather than preferred, because it is a
// claim about being understood. eSpeak's `en` is British and its `en-us` American; the recognizer
// this project measures with (faster-whisper tiny.en) is trained on ordinary American English. On
// the project's own 69-word corpus at 150 wpm, 2026-11-28:
//
//     en       WER 0.116   (61 of 69 words recovered)
//     en-us    WER 0.043   (66 of 69) - which reproduces the recorded eSpeak reference exactly
//     en-gb    WER 0.116   (same as en, as expected: they are the same voice)
//
// and on a four-line story at the pace a person actually uses (150 wpm) 0.100 against 0.133. Both
// are far from the built-in formant voice's 1.0, but 0.043 against 0.116 on the same words is not a
// preference - it is three times fewer words misheard, and every one of them is a word a listener
// would have to reconstruct.
//
// A take records this string, because it is part of what made the bytes: swapping it later must not
// silently change the sound of a take that named the old one.
export const ENGINE_VOICE = "en-us";
// A take that records no `engineVoice` is read as this, which is what `renderWithEngine` does when the
// field is absent - so importing the constant above rather than repeating "en-us" in three modules is
// the only way those three can stay in agreement.
// eSpeak's `-p` is a 0-99 scale, not hertz: 50 is the middle of its range and the ordinary
// reading of a default voice. It is recorded verbatim, and it is NOT the built-in voice's `pitch`
// in hertz - `voice.engine` is what tells a reader which scale a `pitch` is on.
export const DEFAULT_PITCH = 50;
// eSpeak's `-s` is words per minute, integer. 165 is its own default and reads a plain sentence
// at about 175 words a minute as this project measures pace (measured, not assumed).
export const DEFAULT_SPEED = 165;
// The rate every other part of this pipeline assumes. Kept here rather than imported from
// `synth.mjs` on purpose: `synth` imports this module, and a cycle between them would make the
// sample rate depend on which of the two loaded first.
const RATE_OF_ENGINE = 22050;

const clampInt = (value, lo, hi, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};
export const clampSpeed = value => clampInt(value, 80, 450, DEFAULT_SPEED);
export const clampPitch = value => clampInt(value, 0, 99, DEFAULT_PITCH);

// Where the engine is, and how to run it, worked out once per process.
//
// The binary is found in one order: `HYPERMAKER_ESPEAK` if set (a path, honoured even when it is
// wrong - see below), then `espeak-ng` on PATH. Nothing searches the filesystem for a stray
// copy: a voice that depends on which directory somebody happened to extract is not a voice a
// record can name.
//
// The environment is derived from the binary rather than from more variables, because the
// ordinary way to get a recent eSpeak on a machine without root is to unpack the `.deb`s into a
// prefix - and then the program needs to be told where its libraries and its data are. If
// `<prefix>/usr/lib/x86_64-linux-gnu/espeak-ng-data` exists beside the binary, that prefix is
// used; the caller's `LD_LIBRARY_PATH` is prepended to, never replaced.
let cached = null;
function locate() {
  if (cached) return cached;
  const named = process.env.HYPERMAKER_ESPEAK;
  const candidates = named ? [{ binary: named, from: "HYPERMAKER_ESPEAK" }] : [];
  if (!named) {
    for (const dir of String(process.env.PATH || "").split(":").filter(Boolean)) {
      const binary = join(dir, "espeak-ng");
      if (existsSync(binary)) { candidates.push({ binary, from: "PATH" }); break; }
    }
  }
  if (!candidates.length) {
    return (cached = { ok: false, why: `no espeak-ng on PATH and HYPERMAKER_ESPEAK is unset, so this machine has no speech engine; the built-in voice is what speaks here` });
  }
  const { binary, from } = candidates[0];
  if (!existsSync(binary)) {
    // A named engine that is not there is a mistake worth naming, not a reason to speak with
    // something else: the caller asked for this engine and a different voice is a different take.
    return (cached = { ok: false, why: `HYPERMAKER_ESPEAK names ${binary}, which does not exist` });
  }
  // The data and the shared libraries sit beside the binary in each of the two layouts a person
  // actually has: a system install (`/usr/bin`, `/usr/lib/x86_64-linux-gnu`) and an unpacked
  // `.deb` prefix (`<prefix>/usr/bin`, `<prefix>/usr/lib/x86_64-linux-gnu`) - which is the only way
  // to get a recent eSpeak without root, and is why the prefix is derived from the binary rather
  // than from another environment variable nobody would know to set. A multiarch directory is
  // tried first and a plain `lib` second; `pulseaudio/` is on the load path because the binary
  // links libpulse and its private helper library lives one directory down (measured: without it
  // the program fails to start with "libpulsecommon-17.0.so: cannot open shared object file").
  const env = { ...process.env };
  const up = dirname(binary);
  const libs = ["x86_64-linux-gnu", "lib"].flatMap(arch => [join(up, "..", "lib", arch), join(up, "..", "..", "lib", arch)]);
  const lib = libs.find(dir => existsSync(join(dir, "espeak-ng-data")));
  if (lib) {
    env.ESPEAK_DATA_PATH = join(lib, "espeak-ng-data");
    const paths = [lib, join(lib, "pulseaudio"), env.LD_LIBRARY_PATH].filter(Boolean);
    env.LD_LIBRARY_PATH = paths.join(":");
  }
  try {
    const out = String(execFileSync(binary, ["--version"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  // The voices this build actually carries. Asking is cheap and it is the only way to answer "is the
  // voice this take names available here" without rendering a sentence and guessing.
  let voices = [];
  try { voices = String(execFileSync(binary, ["--voices"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).split(/\r?\n/).map(l => l.trim().split(/\s+/)[1]).filter(Boolean); } catch { /* leave empty: an unknown list is not a refusal on its own */ }
    // `eSpeak NG text-to-speech: 1.52.0  Data at: /path/...` - the version is what a take records,
    // because a later eSpeak is a different voice and a refusal should say which one made the audio.
    const version = (out.match(/(\d+\.\d+\.\d+)/) || [])[1] || "unknown";
    return (cached = { ok: true, binary, env, version, from, voices });
  } catch (error) {
    const said = String(error?.stderr || error?.message || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0];
    return (cached = { ok: false, why: `${binary} (from ${from}) could not run${said ? `: ${said}` : ""}` });
  }
}

// What this machine has, for a caller deciding whether to ask for the engine at all. A card says
// this in one line; a render needs `checkEngine` instead.
export function engineStatus() {
  const at = locate();
  if (!at.ok) return { installed: false, name: ENGINE, why: at.why };
  // The voice is *asked about*, not assumed from the fact that it is the pinned one. It used to be
  // skipped exactly when `voice === ENGINE_VOICE`, which is every ordinary call - so `--engine-check`
  // answered `installed: true, voice: "en-us"` on a build whose voice list had no `en-us` at all,
  // and only the first render failed. New takes were still refused rather than spoken in the wrong
  // voice, but the machine-readable answer a caller decides on was unverified.
  const has = checkVoice(ENGINE_VOICE);
  return has.ok
    ? { installed: true, name: ENGINE, binary: at.binary, version: at.version, voice: ENGINE_VOICE, ...(has.unverified ? { voiceUnverified: true } : {}) }
    : { installed: true, name: ENGINE, binary: at.binary, version: at.version, voice: null, voiceMissing: ENGINE_VOICE, why: has.why };
}

// Is the pinned voice present? eSpeak is built with a voice list that differs between distributions
// and packages, so "the engine runs" does not imply "it can say this in American English". Asking
// rather than assuming is what stops a machine from silently speaking a different voice than the one
// the take records.
export function checkVoice(name = ENGINE_VOICE) {
  const at = locate();
  if (!at.ok) return { ok: false, why: at.why };
  if (!at.voices.length) return { ok: true, unverified: true };
  if (at.voices.includes(name)) return { ok: true };
  return { ok: false, why: `${at.binary} (${at.version}) carries no ${JSON.stringify(name)} voice; it has ${at.voices.filter(v => v.startsWith("en")).join(", ") || "no English voice at all"}` };
}

// Refuse by name, in the place the bytes would have been made. `version` is the version the take
// recorded: a different eSpeak build is a different voice, and rendering this build's bytes and
// then letting a frame comparison fail would blame the script for what the upgrade did.
export function checkEngine(name, version = null, voice = null) {
  if (name !== ENGINE) throw new Error(`this build has no speech engine called ${JSON.stringify(name)}; it has ${JSON.stringify(ENGINE)}, and it is only used when a machine has it installed`);
  const at = locate();
  if (!at.ok) throw new Error(`this take was spoken by ${ENGINE}, and this machine cannot run it: ${at.why}. Install espeak-ng (or point HYPERMAKER_ESPEAK at it) to hear or re-check this take`);
  if (version && at.version !== version) throw new Error(`this take was spoken by ${ENGINE} ${version} and this machine has ${at.version}; a different engine version is a different voice, so the take cannot be re-rendered here`);
  // The voice inside the engine is checked too, for the same reason one level down: `en` and `en-us`
  // are two voices, and a take recorded with one must not be re-rendered with the other. The check
  // runs for the pinned voice as well - skipping it there (which is every ordinary call) let a build
  // with no `en-us` pass this function and fail later, inside eSpeak.
  if (voice) {
    const has = checkVoice(voice);
    if (!has.ok) throw new Error(`this take was spoken by ${ENGINE}'s ${JSON.stringify(voice)} voice and this machine cannot: ${has.why}`);
  }
  return { binary: at.binary, env: at.env, version: at.version };
}

// One phrase, as floats in -1..1 at the project's own sample rate.
//
// The engine writes a WAV to its standard output and this reads the samples back, rather than
// asking for raw PCM: the header is how the rate and width are stated by the thing that made
// them, and reading a file whose header lies would be worse than failing. `-w file` is avoided
// deliberately - a published take's own directory is not where a second writer belongs.
//
// Nothing is normalised or re-gained. Two renders of one phrase are byte-identical (measured),
// and a take is the engine's sound rather than this project's version of it; scaling it here
// would put a second, invisible author in the bytes a stored take has to reproduce.
export function renderWithEngine(text, options = {}) {
  const voice = options.engineVoice == null ? ENGINE_VOICE : String(options.engineVoice);
  const { binary, env, version } = checkEngine(options.engine ?? ENGINE, options.engineVersion ?? null, voice);
  const speed = clampSpeed(options.speed), pitch = clampPitch(options.pitch);
  const spoken = String(text ?? "").trim();
  if (!spoken) return { samples: new Float32Array(0), speed, pitch, version, voice };
  let buffer;
  try {
    // `--` ends the options, so a phrase that begins with a hyphen is spoken rather than read as
    // an eSpeak flag. This is not a corner case: a line of dialogue (`- Where are you going?`) and
    // a negative number (`-3.5 points is below zero`) both begin with one, and without this eSpeak
    // consumed the word as an option, wrote nothing to stdout, and the caller was told
    // "not a RIFF/WAVE file" - a sentence about our parser for a mistake in our argv. Measured:
    // the built-in voice renders that line fine, so only engine takes were broken.
    buffer = execFileSync(binary, ["-v", voice, "-s", String(speed), "-p", String(pitch), "--stdout", "--", spoken], {
      env, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // eSpeak's own `stderr` is the only thing that says *why* it refused, so it is passed through
    // whole when there is one. The old version kept the first line only, which is how "not a
    // RIFF/WAVE file" (this module's complaint about empty stdout) displaced the actual reason.
    const said = String(error?.stderr || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean).join("; ");
    throw new Error(`${ENGINE} could not say ${JSON.stringify(spoken)}${said ? `: ${said}` : error?.message ? `: ${String(error.message).split("\n")[0]}` : ""}`);
  }
  // An engine that accepts the phrase but writes no audio is a refusal of its own kind, and the
  // empty buffer would otherwise travel on to the WAV reader and be reported as malformed audio.
  if (!buffer.length) throw new Error(`${ENGINE} wrote no audio for ${JSON.stringify(spoken)}`);
  const { samples, rate } = wavSamples(buffer);
  // THE ENGINE'S OWN NUMBERS, NOT A ROUNDED COPY OF THEM. `wavSamples` decodes with /32768 while
  // `toInt16` encodes with *32767, so the round trip moves a sample by one step whenever rounding
  // would have gone the other way - measured 461 of 121800 samples on one line. It is one LSB and
  // it is not cosmetic: transcribed side by side at otherwise identical settings, eSpeak's own
  // bytes were heard as "harbour" and the product's rounded copy as "harbor", so one of the four
  // words this project counted as the engine's fault was this arithmetic. Rescaling by 32768/32767
  // makes `toInt16(sample)` return exactly the integer eSpeak wrote (measured: every sample, and
  // the audio payload of the re-encoded file is byte-identical to eSpeak's).
  //
  // This is done here and not in `wavSamples` on purpose: the built-in voice's stored takes were
  // made with the /32768 decode, and changing the shared reader would alter bytes no take recorded.
  if (samples.length) {
    const exact = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) exact[i] = samples[i] * (32768 / 32767);
    samples.set(exact);
  }
  if (rate !== RATE_OF_ENGINE) {
    // The whole voice pipeline assumes this rate: `bind.mjs` slices frames at it and the film's
    // track is compared at it. A different one is not a small difference, it is a voice nothing
    // here can check - so it is refused where it happens rather than mis-measured later.
    throw new Error(`${ENGINE} spoke at ${rate} Hz, and this project's voice pipeline is ${RATE_OF_ENGINE} Hz; that is a different engine build than this one can check`);
  }
  return { samples, speed, pitch, version, voice };
}
