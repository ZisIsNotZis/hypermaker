// A film that plays something is not the same as a film that plays *its* narration.
//
// A real agent once produced an MP4 with a valid AAC track of pure digital silence, and every
// cheap check passed: the container was an MP4, it had an audio stream, the canvas played it. The
// `remotion` video guide was rewritten after that, and `test/film.test.mjs` measures the peak
// sample for the agent path. This is the same check for the server-run first cut, plus the half
// no peak can see: the embedded track must be *the narration this take says it used*, not some
// other take's voice, not a different file with the same length.
//
// Three facts, each of which can fail alone, and each sentence says which one:
//   1. the container holds a real video stream and a real duration;
//   2. the embedded audio is loud (a silent track is the failure that started this);
//   3. the embedded audio is the soundtrack it was given - correlated after alignment, because
//      an encoder delays a few hundred samples and that is not a different recording.
//
// Nothing here re-implements the render: ffmpeg and ffprobe come from the project's own Remotion
// install, the same binaries `test/film.test.mjs` uses, so a person and a test measure with one
// tool.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { wavSamples } from "../voice/wav.mjs";
import { correlation } from "../voice/bind.mjs";

const tool = (projectRoot, name) => join(projectRoot || process.cwd(), "node_modules/@remotion/compositor-linux-x64-gnu", name);

// Two wrong ways to make fact 3, both found by walking the real entry rather than by reading it.
// The shape of this file is the answer to them, not a matter of taste:
//
//   1. A fixed 0.25 s window from the *middle* of the take. A two-line script whose first sentence
//      ends near halfway has a pause there, both signals are nearly zero, and every lag scores
//      noise - so a correct film was refused with "playing something else" and 0.44. Where a pause
//      falls is a property of the script, not of the audio being wrong.
//   2. Probing only the *loud* windows. That fixed (1) and opened a worse hole: a film that kept
//      the first 3.23 s of a 5.57 s narration and replaced the rest with silence was accepted with
//      0.999, because every window the check looked at happened to be one of the kept ones. A check
//      that samples the parts most likely to be right cannot fail.
//
// So the work is split. A delay is a property of the whole recording, and finding it needs loud
// audio - silence cannot align anything - so the alignment comes from the loudest windows. Then
// *every* part of the narration is measured at that alignment, window by window. A window where
// the narration itself is quiet is a pause and is not required to match anything: that is what
// lets ordinary speech with a gap between sentences pass. A window where the narration speaks
// must agree, and one that does not is named by its time, so a refusal says where the sound stops
// being the narration rather than blaming the film as a whole.
function energyOf(samples, start, span) {
  let sum = 0;
  for (let i = start; i < start + span; i++) sum += samples[i] * samples[i];
  return sum / Math.max(1, span);
}

// The loudest third of the windows spread across the narration, where the delay search looks.
function loudWindows(samples, rate, count = 9, seconds = 0.25) {
  const span = Math.max(1, Math.round(rate * seconds));
  const windows = [];
  for (let i = 0; i < count; i++) {
    const start = Math.round((samples.length - span) * (i / Math.max(1, count - 1)));
    if (start < 0 || start + span > samples.length) continue;
    windows.push({ start, span, energy: energyOf(samples, start, span) });
  }
  windows.sort((x, y) => y.energy - x.energy);
  return windows.slice(0, Math.max(1, Math.ceil(windows.length / 3)));
}

// Where the narration starts in the film's audio. `heard` and `wanted` are already on one rate (the
// caller brings them there), so a window begins at the same index in both. Bounded to ±150 ms at
// 44.1 kHz: a real encoder delay is a few hundred samples, while a film playing the wrong take is
// not a small offset and must not be rescued by a wide search.
function findLag(heard, wanted, rate) {
  let best = { lag: 0, score: -2 };
  for (const { start, span } of loudWindows(wanted, rate)) {
    for (let lag = -6615; lag <= 6615; lag += 1) {
      const other = start + lag;
      if (other < 0 || other + span > heard.length) continue;
      const score = correlation(wanted.subarray(start, start + span), heard.subarray(other, other + span));
      if (score > best.score) best = { lag, score };
    }
  }
  return best;
}

// Every part of the narration, measured at that alignment. Windows are 0.25 s with a 0.1 s hop, so
// a window shorter than a word still overlaps its neighbours and a failure cannot slip between two
// of them. Each window's delay is refined by up to ±64 samples: an encoder's delay is not perfectly
// constant, and without that a correct window could be marked wrong for being a millisecond out.
function everyPart(heard, wanted, rate, lag, { seconds = 0.25, hopSeconds = 0.1, slip = 64 } = {}) {
  const span = Math.max(1, Math.round(rate * seconds)), hop = Math.max(1, Math.round(rate * hopSeconds));
  const parts = [];
  for (let start = 0; start + span <= wanted.length; start += hop) parts.push({ start, span, energy: energyOf(wanted, start, span) });
  // What counts as a pause: a window far below the loudest of the narration. Soft consonants and a
  // gap between words must not be read as silence, so this floor is deliberately low.
  const loudest = parts.reduce((most, w) => Math.max(most, w.energy), 0);
  const pauseBelow = loudest * 0.02;
  let worst = { score: 1, seconds: 0 }, missing = null, skipped = 0, firstFailure = null;
  const failed = [];
  for (const w of parts) {
    if (w.energy <= pauseBelow) { skipped += 1; continue; } // a written pause: nothing here has to match
    const at = w.start + lag;
    if (at < 0 || at + w.span > heard.length) {
      missing = missing ?? w.start / rate;
      continue;
    }
    let best = { score: -2 };
    for (let d = -slip; d <= slip; d++) {
      const other = at + d;
      if (other < 0 || other + w.span > heard.length) continue;
      const score = correlation(wanted.subarray(w.start, w.start + w.span), heard.subarray(other, other + w.span));
      if (score > best.score) best = { score };
    }
    if (best.score < worst.score) worst = { score: best.score, seconds: w.start / rate };
    if (best.score < 0.5) {
      // Is the film silent where the narration speaks? That is a hole, and it is a different defect
      // from playing something else: a person fixes it differently, so it is described differently.
      const heardEnergy = energyOf(heard, at, w.span);
      firstFailure = firstFailure ?? w.start / rate;
      failed.push({ seconds: Number((w.start / rate).toFixed(2)), score: Number(best.score.toFixed(3)), silent: heardEnergy < w.energy * 0.02 });
    }
  }
  // Where the narration first stops being heard is the one number a person needs; the rest of the
  // list only says how far it went. Sorted so the first entry is the earliest failure, not the
  // worst-scoring one, and deduplicated to a tenth of a second because windows overlap by design.
  failed.sort((a, b) => a.seconds - b.seconds);
  return { worst, failed, missing, loudest, pauseBelow, windows: parts.length, skipped, spoken: parts.length - skipped, firstFailure };
}

export function verifyFilm({ file, soundtrackFile, projectRoot }) {
  const problems = [];
  if (!file || !existsSync(file)) return { ok: false, problems: [`${file || "no film"} is not a file`], evidence: null };
  const ffmpeg = tool(projectRoot, "ffmpeg"), ffprobe = tool(projectRoot, "ffprobe");
  if (!existsSync(ffprobe) || !existsSync(ffmpeg)) {
    return { ok: false, problems: ["this project's Remotion install has no ffprobe/ffmpeg, so the film cannot be measured; nothing was published"], evidence: null };
  }

  let probe;
  try { probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" })); }
  catch (error) {
    return { ok: false, problems: [`ffprobe could not read the film (${error.message.split("\n")[0]}), so it is not a playable video`], evidence: null };
  }
  const streams = probe.streams || [];
  const video = streams.find(s => s.codec_type === "video");
  const audio = streams.find(s => s.codec_type === "audio");
  const seconds = Number(probe.format?.duration);
  if (!video) problems.push("the file has no video stream");
  if (!Number.isFinite(seconds) || seconds <= 0) problems.push("the file reports no usable duration");
  // The film has to be at least as long as what it says out loud. A film shorter than its own
  // soundtrack is the complaint the first agent take produced: a fixed 90 frames under a 6 s
  // narration cut the sentence in half.
  let soundtrackSeconds = null;
  if (soundtrackFile && existsSync(soundtrackFile)) {
    const { rate, samples } = wavSamples(readFileSync(soundtrackFile));
    soundtrackSeconds = samples.length / rate;
    if (Number.isFinite(seconds) && seconds + 0.1 < soundtrackSeconds) {
      problems.push(`the film lasts ${seconds.toFixed(2)}s but its narration lasts ${soundtrackSeconds.toFixed(2)}s, so the end of the sentence is cut off`);
    }
  } else {
    problems.push("no soundtrack to compare the film against, so the film cannot be shown to carry this narration");
  }
  if (!audio) problems.push("the film has no audio stream at all");
  if (problems.length) return { ok: false, problems, evidence: null };

  // The embedded track, measured: peak and, above all, whether every part of it is this narration.
  const extracted = `${file}.measured.wav`;
  try { execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "44100", extracted]); }
  catch (error) {
    return { ok: false, problems: [`the film's audio track could not be extracted (${error.message.split("\n")[0]}), so it cannot be shown to carry the narration`], evidence: null };
  }
  const heard = wavSamples(readFileSync(extracted));
  let peak = 0;
  for (const sample of heard.samples) { const value = Math.abs(sample); if (value > peak) peak = value; }
  if (peak === 0) {
    rmSync(extracted, { force: true });
    return { ok: false, problems: ["the film's audio track exists but every sample is zero, so it plays in silence"], evidence: { peak: 0 } };
  }
  const wantedRaw = wavSamples(readFileSync(soundtrackFile));
  // One rate for both signals before they are compared. The narration is the voice's 22.05 kHz and
  // the extracted track is 44.1 kHz, so the faster one is brought down by averaging a box of
  // samples - not by picking every second sample of a reference whose ratio may not be an exact
  // multiple, which leaves a different waveform and can halve the correlation between two copies of
  // the same speech. Averaging also removes what would otherwise fold back as an alias.
  const rate = Math.min(heard.rate, wantedRaw.rate);
  const toRate = (samples, from) => {
    if (from === rate) return samples;
    const factor = from / rate;
    const out = new Float32Array(Math.floor(samples.length / factor));
    for (let i = 0; i < out.length; i++) {
      const a = Math.floor(i * factor), b = Math.min(samples.length, Math.floor((i + 1) * factor));
      let sum = 0;
      for (let j = a; j < b; j++) sum += samples[j];
      out[i] = b > a ? sum / (b - a) : 0;
    }
    return out;
  };
  const heardAt = toRate(heard.samples, heard.rate), wantedAt = toRate(wantedRaw.samples, wantedRaw.rate);
  const { lag, score: anchor } = findLag(heardAt, wantedAt, rate);
  const parts = everyPart(heardAt, wantedAt, rate, lag);
  rmSync(extracted, { force: true });
  // Is this narration here at all? That question comes before "where does it stop", because a film
  // carrying a different recording also stops being *this* narration almost immediately - and
  // describing that as Truncation sends a person looking for a cut that was never made. The
  // alignment is the honest test: the loudest parts of the narration either line up with the film's
  // audio or they do not. A real encoder delay still scores near 1; another take's voice measured
  // 0.43 here and a good film 0.998, so the threshold sits well clear of both.
  if (anchor < 0.9) {
    return { ok: false, problems: [`the film's soundtrack is not the narration it was given: the narration's own loudest passages match nothing in the film's audio (best agreement ${anchor.toFixed(2)}), so this is a different recording`], evidence: { peak, correlation: Number(anchor.toFixed(3)), windows: parts.windows } };
  }
  if (parts.missing != null) {
    return { ok: false, problems: [`the film's audio stops at ${parts.missing.toFixed(2)}s, where the narration is still speaking, so the rest of the take is missing`], evidence: { peak, correlation: Number(parts.worst.score.toFixed(3)), alignment: Number(anchor.toFixed(3)), firstMissingAt: Number(parts.missing.toFixed(2)) } };
  }
  if (parts.failed.length) {
    // One defect, one sentence. A film that goes quiet where its narration speaks fails many windows,
    // and the first version of this printed two refusals for it - "plays nothing" and "is playing
    // something else" - which read as two problems and contradicted each other. What is described
    // here is the first window that disagrees and what was heard there instead: silence means the
    // take is missing a piece of itself, anything else means it is carrying the wrong sound.
    // Which defect it is, is decided by the *bulk* of the disagreement rather than by the first
    // window: the window where a cut lands is half speech and half silence, so it is never counted
    // as a hole, and reading the first one alone described a film that goes silent after 3.2 s as
    // "playing something else". The start of the trouble is that first window either way.
    const from = parts.firstFailure.toFixed(2), count = parts.failed.length;
    const silent = parts.failed.filter(f => f.silent).length, mostlySilent = silent * 2 >= count;
    const refusal = mostlySilent
      ? `from ${from}s the film plays nothing where its narration is speaking (${count} window${count === 1 ? "" : "s"} of the take), so part of the take is missing`
      : `from ${from}s the film's soundtrack is not the narration it was given (${count} window${count === 1 ? "" : "s"} of the take, ${silent} of them silent), so it is playing something else`;
    // A refused film reports the *worst* agreement, not the alignment's best one: a film that keeps
    // its first 3.23 s and goes silent was once accepted with "0.999" printed beside it, and a
    // refusal that quotes 0.998 next to "part of the take is missing" reads as a contradiction.
    return { ok: false, problems: [refusal], evidence: { peak, correlation: Number(parts.worst.score.toFixed(3)), alignment: Number(anchor.toFixed(3)), disagreements: parts.failed.slice(0, 12), windows: parts.windows, spokenWindows: parts.spoken } };
  }
  return {
    ok: true,
    problems: [],
    evidence: {
      seconds: Number(seconds.toFixed(2)),
      videoCodec: video.codec_name,
      audioCodec: audio.codec_name,
      width: Number(video.width),
      height: Number(video.height),
      // ffprobe reports a frame rate as a rational string (`30/1`); it is divided here rather than
      // printed, and a rate it cannot express is `null` rather than a plausible-looking zero.
      fps: (() => { const [num, den] = String(video.r_frame_rate || "").split("/").map(Number); return Number.isFinite(num) && Number.isFinite(den) && den > 0 ? Number((num / den).toFixed(3)) : null; })(),
      peak,
      // The *worst* speaking window's agreement, not the best one: a film whose middle is perfect
      // and whose end is silent must not report a good number. Kept on the card because it is the
      // figure that tells a person the sound was checked, rather than that a track merely exists.
      correlation: Number(parts.worst.score.toFixed(3)),
      alignment: Number(anchor.toFixed(3)),
      lagSamples: lag,
      // How much of the narration the number above covers: windows compared, and how many were
      // pauses the narration itself does not speak in. A card can say "checked 22 of 24 windows"
      // rather than leaving a person to wonder whether one lucky sample decided it.
      windows: parts.windows,
      spokenWindows: parts.spoken,
      soundtrackSeconds: Number((soundtrackSeconds ?? 0).toFixed(2))
    }
  };
}
