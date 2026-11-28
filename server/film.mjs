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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { wavSamples } from "../voice/wav.mjs";
import { correlation } from "../voice/bind.mjs";

const tool = (projectRoot, name) => join(projectRoot || process.cwd(), "node_modules/@remotion/compositor-linux-x64-gnu", name);

// SCENES. One picture is one scene, and the cut between two of them is a measured fact about the
// narration rather than a number someone typed.
//
// Why this exists at all: a film was one still with a title over it, and a second picture could
// not be reached without a model - an image card's only methods handed the work to an agent, and
// the model route on this machine does not answer. "Continue with independently editable scenes"
// is the next thing the project index asks for, and it is exactly the thing that needs a rule
// rather than a feature: what decides when the picture changes?
//
// The rule: the narration's own measured phrase times. Phrase boundaries are where the voice
// actually stops and starts, so a cut there lands between sentences instead of in the middle of
// one. Scenes are apportioned by *spoken duration* - not by phrase count - so that a scene holding
// three short lines is not given the same screen time as one holding a long one.
const captionOf = (phrases, limit = 120) => {
  const words = phrases.map(p => String(p.text || "").trim()).filter(Boolean).join(" ");
  if (words.length <= limit) return words;
  const cut = words.slice(0, limit);
  return `${cut.slice(0, Math.max(0, cut.lastIndexOf(" ")))}…`;
};

// `pictures` are the linked image sources in link order; `phrases` are the narration's measured
// phrases; `seconds` is the film's real length. The result is one entry per scene with the times
// the cutter and the checker must agree on, which is why it lives here rather than in the cutter:
// a plan the checking code re-derives is a plan that can disagree with the one that was rendered.
export function planScenes({ pictures = [], phrases = [], seconds = 0 }) {
  if (!pictures.length) return [];
  const usable = phrases.filter(p => Number.isFinite(Number(p.start)) && Number.isFinite(Number(p.duration)) && String(p.text || "").trim());
  // More than one picture without measured phrase times is a cut nobody can justify. Distributing
  // the narration evenly instead would put a cut in the middle of a sentence and call it a scene,
  // and the film would look deliberate. Refusing is the honest answer, and the person can fix it
  // by regenerating the narration (every take this build publishes carries its phrase times).
  if (pictures.length > 1 && usable.length < 2) return null;
  if (!usable.length) {
    // One picture, no phrase times: the whole film is one scene, which is what a film of a take
    // that predates phrase records is.
    return [{ index: 0, start: 0, end: Number(seconds) || 0, picture: pictures[0], phrases: [], caption: "" }];
  }
  const total = usable.reduce((sum, p) => sum + Math.max(0, Number(p.duration)), 0) || 1;
  const count = Math.min(pictures.length, usable.length);
  // Boundaries at equal spoken durations: the k-th cut is the phrase start nearest k*T/count.
  const bounds = [0];
  for (let k = 1; k < count; k++) {
    const target = (total * k) / count;
    let acc = 0, best = 1, bestGap = Infinity;
    for (let i = 1; i < usable.length; i++) {
      acc += Math.max(0, Number(usable[i - 1].duration));
      const gap = Math.abs(acc - target);
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    bounds.push(Math.max(best, bounds[bounds.length - 1] + 1));
  }
  bounds.push(usable.length);
  // A picture nobody is given time for is not a scene. When there are more pictures than phrases
  // the extra ones are dropped rather than shown for a frame, and the count says so.
  const scenes = [];
  for (let k = 0; k < count; k++) {
    const group = usable.slice(bounds[k], bounds[k + 1]);
    if (!group.length) continue;
    const start = k === 0 ? 0 : Number(group[0].start);
    const end = k === count - 1 ? Number(seconds) || start : Number(usable[bounds[k + 1]]?.start ?? seconds) || start;
    scenes.push({ index: scenes.length, start, end, picture: pictures[Math.min(k, pictures.length - 1)], phrases: group, caption: captionOf(group) });
  }
  return scenes.map((s, i) => ({ ...s, index: i }));
}

// One frame of the film as a small grid of colours, and one picture as the same grid. `cover`
// rather than `stretch`, because that is what the composition does with a poster whose aspect is
// not the frame's: scaling differently on each side would compare two different crops and call a
// correct film wrong.
function asGrid(tool, file, { at = null, scratch, crop } = {}) {
  const out = join(scratch, `f${Math.random().toString(36).slice(2)}.rgb`);
  const filters = [crop ? "crop=iw:ih*2/3:0:0" : null, "scale=32:18:force_original_aspect_ratio=increase", "crop=32:18"].filter(Boolean).join(",");
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (at != null) args.push("-ss", Number(at).toFixed(3));
  args.push("-i", file, "-frames:v", "1", "-vf", filters, "-pix_fmt", "rgb24", "-c:v", "rawvideo", "-f", "image2", out);
  execFileSync(tool, args, { stdio: "pipe" });
  return readFileSync(out);
}

// Does the film show the picture each scene says it does?
//
// Measured on pixels, at the middle of each scene, with the caption band cropped off, against the
// frozen poster bytes the run was given rather than against anything the renderer wrote. A film that
// shows scene one's picture for the whole length is the failure this is for: every cheaper check
// passes it, because the film is a real h264 file carrying the right narration.
//
// A FIXED THRESHOLD WAS NOT ENOUGH, and that is the shape of this function rather than a detail.
// The first version refused a scene below 0.8 agreement with its own picture. Then a real two-scene
// film was re-cut with its second picture replaced, and the replacement - a different sentence drawn
// by the same server-run method, so the same layout with different words - measured 0.865 against
// the *first* picture and 0.95 against its own. The two populations were 0.065 apart while the
// threshold sat 0.065 below the honest one: a scene showing the wrong picture would have passed.
// Two pictures made by one method look alike; no absolute number can tell "this scene's picture"
// from "that scene's picture" when both are 32x18 gradients of the same layout.
//
// So the question asked is the relative one, which is the question a viewer asks: *is this scene
// showing the picture it names, rather than one of the other pictures in this film?* Each scene's
// frame is compared with every distinct picture the film uses, and it must rank as its own best
// match by a margin. Absolute agreement is still reported and still has a floor, but the ranking is
// what decides, because that is the comparison with any margin at all in it.
//
// When a film has only one picture the ranking is vacuous - there is nothing to confuse it with - so
// the absolute floor alone decides, and it is stated as such rather than pretended to be stronger.
function verifyScenes({ file, scenes, tool }) {
  const usable = scenes.filter(s => s.picture && (s.picture.frozen || s.picture.file) && existsSync(s.picture.frozen || s.picture.file));
  if (!usable.length) return { problems: [], evidence: null };
  const scratch = mkdtempSync(join(tmpdir(), "hypermaker-scenes-"));
  const problems = [], measured = [];
  try {
    // Each distinct picture once: a picture used by two scenes is one candidate, not two.
    const pictures = new Map();
    for (const scene of usable) {
      const path = scene.picture.frozen || scene.picture.file;
      if (!pictures.has(path)) pictures.set(path, asGrid(tool, path, { scratch, crop: true }));
    }
    for (const scene of usable) {
      const mid = (Number(scene.start) + Number(scene.end)) / 2;
      const own = scene.picture.frozen || scene.picture.file;
      const frame = asGrid(tool, file, { at: mid, scratch, crop: true });
      // Every candidate, in one pass, so the ranking is over the same pixels the ratio uses.
      const scores = [...pictures].map(([path, grid]) => ({ path, score: correlation(frame, grid) })).sort((a, b) => b.score - a.score);
      const mine = scores.find(s => s.path === own).score;
      const best = scores[0];
      const rival = best.path === own ? (scores[1] ?? null) : best;
      const margin = rival ? mine - rival.score : null;
      measured.push({ scene: scene.index, at: Number(mid.toFixed(2)), agreement: Number(mine.toFixed(3)), ...(rival ? { rivalAgreement: Number(rival.score.toFixed(3)), margin: Number(margin.toFixed(3)) } : {}) });
      if (rival) {
        // Its own picture has to be the best match, by a visible distance. 0.02 is well below the
        // 0.065 that two genuinely different pictures measured, and well above encoder noise, which
        // on a correct scene measured 0.000 - the same picture through h264 and as a PNG agree to
        // three places.
        // Pictures are named by the CARD they came from, not only by filename. Every picture card
        // publishes the same name (`card.png`), so a sentence naming the file alone read `shows
        // card.png rather than the picture it was cut from (card.png)` - true, useless, and found by
        // reading the refusal rather than the check.
        const card = path => scenes.find(s => (s.picture?.frozen || s.picture?.file) === path)?.picture;
        if (best.path !== own) {
          const shownBy = card(best.path), wanted = card(own);
          problems.push(`at ${mid.toFixed(2)}s scene ${scene.index + 1} shows the picture from card #${shownBy?.id ?? "?"} rather than the one it was cut from, card #${wanted?.id ?? "?"} (agreement ${best.score.toFixed(3)} against ${mine.toFixed(3)})`);
        } else if (margin < 0.02) {
          const rivalBy = card(rival.path);
          problems.push(`at ${mid.toFixed(2)}s scene ${scene.index + 1} cannot be told apart from card #${rivalBy?.id ?? "?"}'s picture in the same film (${mine.toFixed(3)} against ${rival.score.toFixed(3)}), so it cannot be shown to show the picture it names`);
        }
      } else if (mine < 0.8) {
        problems.push(`at ${mid.toFixed(2)}s scene ${scene.index + 1} does not show the picture it was cut from (agreement ${mine.toFixed(2)} with ${basename(own)})`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { problems, evidence: measured };
}

// A picture that a film is about to use has to be a real picture, and it has to be the size the
// film will show it in.
//
// Both halves are things a person meets rather than things a renderer asserts. A method that exits
// successfully and leaves a zero-byte or 1x1 file would be published as "your picture", and the
// first film made from it would fail its scene check several minutes later with a sentence about
// the *film* - sending someone to look at the wrong card. The size matters for the same reason: a
// 320x180 picture stretched to fill 1280x720 is a decision, not an accident, but a film that puts
// one in a scene is making it silently, so a mismatch is named here while it is still one card's
// problem.
export function verifyPicture({ file, projectRoot, width = null, height = null }) {
  if (!file || !existsSync(file)) return { ok: false, problems: [`${file || "no picture"} is not a file`], evidence: null };
  const ffprobe = tool(projectRoot, "ffprobe");
  if (!existsSync(ffprobe)) return { ok: false, problems: ["this project's Remotion install has no ffprobe, so the picture cannot be measured; nothing was published"], evidence: null };
  let probe;
  try { probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", file], { encoding: "utf8" })); }
  catch (error) { return { ok: false, problems: [`ffprobe could not read the picture (${error.message.split("\n")[0]}), so it is not a decodable image`], evidence: null }; }
  const stream = (probe.streams || []).find(s => s.codec_type === "video");
  if (!stream) return { ok: false, problems: ["the file holds no picture stream"], evidence: null };
  const at = { width: Number(stream.width), height: Number(stream.height), codec: stream.codec_name };
  if (!(at.width > 1) || !(at.height > 1)) return { ok: false, problems: [`the picture is ${at.width}x${at.height}, which is not a picture`], evidence: at };
  const problems = [];
  if (width != null && height != null && (at.width !== width || at.height !== height)) {
    problems.push(`the picture came out ${at.width}x${at.height} where the card asked for ${width}x${height}, so it would be stretched in a film`);
  }
  return { ok: !problems.length, problems, evidence: at };
}

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

// `scenes` is what the cut says it shows and where. It is optional so that a film made before
// scenes existed is still measured by everything above; a film that claims scenes is also measured
// on its pictures, because "the right narration over a real video stream" is true of a film that
// shows the first picture for its whole length.
export function verifyFilm({ file, soundtrackFile, projectRoot, scenes = null }) {
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
  // The sound is this narration, all of it. Now the pictures, when the take claims scenes: one
  // check per scene, at its middle, against the frozen bytes of the picture that scene names.
  // A film that shows scene one's picture for its whole length passes every check above - it is
  // a real film carrying the right voice - so this is the only thing that can see it.
  const pictures = scenes ? verifyScenes({ file, scenes, tool: ffmpeg }) : { problems: [], evidence: null };
  if (pictures.problems.length) return { ok: false, problems: pictures.problems, evidence: { peak, correlation: Number(parts.worst.score.toFixed(3)), scenes: pictures.evidence } };
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
      soundtrackSeconds: Number((soundtrackSeconds ?? 0).toFixed(2)),
      // What each scene was measured to show. `null` for a film made before scenes existed, which
      // is how the card knows not to promise a picture check nobody made - the same rule as an old
      // take's sentence about its own measurement.
      scenes: pictures.evidence
    }
  };
}
