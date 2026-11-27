import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

// A stand-in for the agent that builds a film from the input cards. It does the
// thing the video method guide now requires: copies the input WAV into public/,
// references it with <Audio src={staticFile(...)}/>, renders with h264, then
// extracts the embedded track and refuses to return a silent film. The render is
// real; only the "creative" choices are fixed, because the point of the test is
// that a film made from a canvas audio card is audible.
const dir = process.env.HYPERMAKER_NODE_DIR || process.cwd();
const workspace = dir.replace(/\/\d+$/, "");
mkdirSync(dir, { recursive: true });

// Read the prompt the server assembled to find the audio input it was given.
const promptFile = join(dir, "prompt.txt");
const prompt = existsSync(promptFile) ? readFileSync(promptFile, "utf8") : "";
const audioMatch = prompt.match(/artifact path: (\S+\.wav)/);
if (!audioMatch) throw new Error("the prompt did not name an audio input artifact");
const audioSrc = audioMatch[1];

const publicDir = join(dir, "public");
mkdirSync(publicDir, { recursive: true });
const trackName = "track.wav";
copyFileSync(audioSrc, join(publicDir, trackName));

// The film has to last as long as the audio it carries, which the video method's guide says
// in so many words: a fixed 90 frames (3 s) under a 6 s narration cut the last half of the
// sentence off, and every cheap check still passed. Frames are computed from the real sample
// count, rounded up so nothing is lost to the tail.
const { wavStats } = await import("./wav.mjs");
const { samples } = wavStats(audioSrc);
// The rate comes from the file, not from an assumption: the canvas WAVs are 44.1 kHz and the
// narration voice is 22.05 kHz, and dividing a 22.05 kHz sample count by 44100 would cut the
// film to half the length of its own soundtrack.
const rate = readFileSync(audioSrc).readUInt32LE(24);
const fps = 30, durationInFrames = Math.ceil(samples / rate * fps);

const entry = join(dir, "film-entry.jsx");
writeFileSync(entry, `
import React from 'react';
import { AbsoluteFill, Audio, Composition, interpolate, registerRoot, staticFile, useCurrentFrame } from 'remotion';
const Film = () => {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [0, ${durationInFrames}], [0, 120]);
  return <AbsoluteFill style={{ background: '#101217', justifyContent: 'center', alignItems: 'center' }}>
    <div style={{ color: '#53e0c1', fontSize: 64, fontFamily: 'Arial', transform: \`translateX(\${x}px)\` }}>SOUND HAS A SHAPE</div>
    <Audio src={staticFile('${trackName}')} />
  </AbsoluteFill>;
};
const Root = () => <Composition id="Film" component={Film} width={720} height={404} fps={30} durationInFrames={${durationInFrames}} />;
registerRoot(Root);
`);

const chrome = process.env.HYPERMAKER_CHROME || process.env.CHROME_BIN;
const browserArgs = chrome ? { browserExecutable: chrome, chromiumOptions: { executablePath: chrome } } : {};
const serveUrl = await bundle({ entryPoint: entry, publicDir, rspack: true });
const composition = await selectComposition({ serveUrl, id: "Film", ...browserArgs });
const artifact = join(dir, "sound-has-a-shape-film.mp4");
await renderMedia({ serveUrl, composition, codec: "h264", outputLocation: artifact, audioCodec: "aac", concurrency: 1, ...browserArgs });

// The check the guide demands, and the one a silent track would pass without.
const { execFileSync } = await import("node:child_process");
const ff = join(process.cwd(), "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");
const check = join(dir, "check.wav");
execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", artifact, "-map", "0:a:0", "-ac", "1", "-ar", "44100", check]);
const { peak } = wavStats(check);
if (peak === 0) throw new Error("rendered film has a silent audio track");

const script = join(dir, "render-film.mjs");
writeFileSync(script, "// written by the stand-in agent\n");
const result = { prompt: "a film from the canvas audio", script, artifact, type: "video", method: "remotion", error: null };
const output = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (output) writeFileSync(output, JSON.stringify(result));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
