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

// The delay an encoder introduces, searched rather than assumed. Bounded to ±150 ms at 44.1 kHz:
// a real encoder delay is a few hundred samples, while a film playing the wrong take is not a
// small offset and must not be rescued by a wide search.
function bestLag(a, b) {
  const window = Math.min(a.length, b.length, 11025);
  const mid = Math.floor((Math.min(a.length, b.length) - window) / 2);
  let best = { lag: 0, score: -2 };
  for (let lag = -6615; lag <= 6615; lag += 1) {
    const bStart = mid + lag;
    if (bStart < 0 || bStart + window > b.length) continue;
    const score = correlation(a.subarray(mid, mid + window), b.subarray(bStart, bStart + window));
    if (score > best.score) best = { lag, score };
  }
  return best;
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

  // The embedded track, measured: peak and, above all, whether it is this narration.
  const extracted = `${file}.measured.wav`;
  try { execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "44100", extracted]); }
  catch (error) {
    return { ok: false, problems: [`the film's audio track could not be extracted (${error.message.split("\n")[0]}), so it cannot be shown to carry the narration`], evidence: null };
  }
  const heard = wavSamples(readFileSync(extracted));
  let peak = 0;
  for (const sample of heard.samples) { const value = Math.abs(sample); if (value > peak) peak = value; }
  if (peak === 0) {
    return { ok: false, problems: ["the film's audio track exists but every sample is zero, so it plays in silence"], evidence: { peak: 0 } };
  }
  const wantedRaw = wavSamples(readFileSync(soundtrackFile));
  // Resample-free comparison: the narration is the voice's 22.05 kHz and the extracted track is
  // 44.1 kHz, so the narration is played back at its own rate but compared over the same time
  // window by stepping it. Comparing raw sample arrays of different rates would correlate two
  // different signals and refuse a correct film.
  const ratio = wantedRaw.rate / heard.rate;
  const wanted = new Float32Array(Math.floor(wantedRaw.samples.length / ratio));
  for (let i = 0; i < wanted.length; i++) wanted[i] = wantedRaw.samples[Math.floor(i * ratio)];
  const { lag, score } = bestLag(heard.samples, wanted);
  rmSync(extracted, { force: true });
  if (score < 0.9) {
    return { ok: false, problems: [`the film's soundtrack is not the narration it was given (best agreement ${score.toFixed(2)}), so it is playing something else`], evidence: { peak, correlation: Number(score.toFixed(3)) } };
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
      // How well the embedded track matches the narration, after the encoder's delay. Kept on
      // the card because it is the number that tells a person the sound was checked, rather than
      // that a track merely exists.
      correlation: Number(score.toFixed(3)),
      lagSamples: lag,
      soundtrackSeconds: Number((soundtrackSeconds ?? 0).toFixed(2))
    }
  };
}
