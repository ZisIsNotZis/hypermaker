// Offline stand-in agent for the short-film story (`test/film-story.mjs`), dispatching
// on the node's type. Every artifact is rendered for real - Remotion for the picture,
// the project's own voice (`voice/render.mjs`) for the narration, ffmpeg/Remotion for
// the film - so "the two takes are playable" is a fact about bytes, not a caption.
//
// It is deliberately not creative: the picture carries the prompt and the spoken words
// it was given, so a person can read which material and which instruction went into
// which take by looking at (or listening to) the published file.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";

const dir = process.env.HYPERMAKER_NODE_DIR;
const type = process.env.HYPERMAKER_NODE_TYPE;
const prompt = readFileSync(join(dir, "prompt.txt"), "utf8");
mkdirSync(dir, { recursive: true });

// The server's own section splitter. Splitting on a `m`-flagged `$` lookahead reads one
// line of each section, so the headings are matched literally instead.
const section = name => {
  const at = prompt.indexOf(`\n# ${name}\n`);
  if (at < 0) return "";
  const from = at + name.length + 4;
  const next = prompt.indexOf("\n\n# ", from);
  return (next < 0 ? prompt.slice(from) : prompt.slice(from, next)).trim();
};
const asked = section("USER PROMPT").trim();
const inputs = section("INPUTS");
const frozenText = (/artifact content:\n```\n([\s\S]*?)```/.exec(inputs) || [])[1] || "";
const text = (frozenText || asked).trim();

const chrome = process.env.HYPERMAKER_CHROME || process.env.CHROME_BIN;
const browserArgs = chrome ? { browserExecutable: chrome, chromiumOptions: { executablePath: chrome } } : {};
const buildDir = join(dir, "build");

async function render(entry, comp, opts) {
  const serveUrl = await bundle({ entryPoint: entry, rspack: true, outDir: buildDir, ...(opts.publicDir ? { publicDir: opts.publicDir } : {}) });
  try {
    const composition = await selectComposition({ serveUrl, id: comp, ...browserArgs });
    if (opts.video) await renderMedia({ serveUrl, composition, codec: "h264", outputLocation: opts.output, audioCodec: "aac", concurrency: 1, ...browserArgs });
    else await renderStill({ serveUrl, composition, output: opts.output, frame: 0, ...browserArgs });
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

let artifact, script, typeOut = type;
if (type === "text") {
  script = join(dir, "write-lines.mjs");
  writeFileSync(script, "// stand-in text agent\n");
  artifact = join(dir, "lines.txt");
  writeFileSync(artifact, `${text}\n`, "utf8");
} else if (type === "audio") {
  // The narration card: the project's real renderer and the guide's own check.
  const scriptText = join(dir, "script.txt");
  writeFileSync(scriptText, text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join("\n"), "utf8");
  artifact = join(dir, "narration.wav");
  const timeline = join(dir, "timeline.json");
  // The pace is read out of the card's instruction the way the guide tells an agent to: "at
  // 200 words a minute" and "200 wpm" mean the same thing to a person. A card that asks for
  // no pace gets the ordinary reading.
  const paceAsked = /(\d{2,3})\s*(?:words?\s*(?:a|per)\s*minute|wpm)/i.exec(asked);
  execFileSync(process.execPath, [join(process.cwd(), "voice/render.mjs"), "--file", scriptText, "--out", artifact, "--timeline", timeline, ...(paceAsked ? ["--wpm", paceAsked[1]] : [])], { stdio: "inherit" });
  if (paceAsked) {
    // The wording came from the prompt; the number is checked from the timeline afterwards, so
    // this stand-in cannot claim a pace it did not reach.
    const recorded = JSON.parse(readFileSync(timeline, "utf8"));
    if (!recorded.pace || Number(recorded.pace.askedWpm) !== Number(paceAsked[1])) throw new Error(`the card asked for ${paceAsked[1]} words a minute and the tool did not record that request`);
    if (Math.abs(recorded.pace.wpm - Number(paceAsked[1])) / Number(paceAsked[1]) > 0.02) throw new Error(`asked for ${paceAsked[1]} words a minute and the audio reads at ${recorded.pace.wpm}`);
  }
  const words = text.replace(/\s+/g, " ").trim();
  const report = JSON.parse(execFileSync(process.execPath, [join(process.cwd(), "voice/render.mjs"), "--check", artifact, "--words", words], { encoding: "utf8" }));
  if (report.verdict !== "speech") throw new Error(`the narration did not measure as speech: ${report.problems.join("; ")}`);
  writeFileSync(join(dir, "AGENTS.md"), `Narrated ${report.words} words in ${report.seconds.toFixed(2)}s: ${report.onsets} syllable onsets, ${report.vowelKinds} vowel regions, verdict ${report.verdict}.\n`, "utf8");
  script = scriptText;
} else if (type === "image") {
  // The poster says what it was asked for, and its background follows the words, so a
  // second take is visibly a different picture rather than a different file name.
  const storm = /storm/i.test(text) ? true : false;
  script = join(dir, "render-poster.mjs");
  writeFileSync(script, "// stand-in poster agent\n");
  artifact = join(dir, "poster.png");
  const entry = join(dir, "poster-entry.jsx");
  writeFileSync(entry, `
import React from 'react';
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
const Poster = () => <AbsoluteFill style={{ background: '${storm ? "#1a2338" : "#101217"}', justifyContent: 'center', alignItems: 'center' }}>
  <div style={{ color: '#f5f1e8', fontSize: 52, fontFamily: 'Arial', letterSpacing: 2 }}>${text.replace(/[<>&]/g, "").toUpperCase()}</div>
</AbsoluteFill>;
const Root = () => <Composition id="Poster" component={Poster} width={480} height={270} fps={30} durationInFrames={1} />;
registerRoot(Root);
`);
  await render(entry, "Poster", { output: artifact });
} else if (type === "video") {
  // The film: the freeze-dried narration copy and the frozen poster, both read from the
  // prompt the server assembled, so the picture and the voice are the material this run
  // was actually given - not the live cards upstream.
  const audioSrc = (/artifact path: (\S+\.wav)/.exec(inputs) || [])[1];
  const posterSrc = (/artifact path: (\S+\.png)/.exec(inputs) || [])[1];
  if (!audioSrc) throw new Error("the prompt did not name the narration it was given");
  if (!posterSrc) throw new Error("the prompt did not name the poster it was given");
  const { wavStats } = await import("./wav.mjs");
  const { samples } = wavStats(audioSrc);
  const rate = readFileSync(audioSrc).readUInt32LE(24);
  const fps = 30, durationInFrames = Math.ceil(samples / rate * fps);
  const publicDir = join(dir, "public");
  mkdirSync(publicDir, { recursive: true });
  copyFileSync(audioSrc, join(publicDir, "track.wav"));
  copyFileSync(posterSrc, join(publicDir, "poster.png"));
  const entry = join(dir, "film-entry.jsx");
  // The caption is built as an array of lines: a nested template literal inside a
  // template literal is how an earlier fixture lost its own escaping.
  writeFileSync(entry, `
import React from 'react';
import { AbsoluteFill, Audio, Composition, Img, interpolate, registerRoot, staticFile, useCurrentFrame } from 'remotion';
const Film = () => {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [0, ${durationInFrames}], [0, 60]);
  return <AbsoluteFill style={{ background: '#0b0d12' }}>
    <Img src={staticFile('poster.png')} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.6 }} />
    <AbsoluteFill style={{ justifyContent: 'flex-end', padding: 26 }}>
      <div style={{ color: '#53e0c1', fontSize: 20, fontFamily: 'Arial', transform: 'translateX(' + x + 'px)' }}>CUT: ${asked.replace(/[<>&{}]/g, "").replace(/'/g, "\\'")}</div>
      <div style={{ color: '#ffffff', fontSize: 24, fontFamily: 'Arial' }}>${text.replace(/[<>&{}]/g, "").replace(/'/g, "\\'")}</div>
    </AbsoluteFill>
    <Audio src={staticFile('track.wav')} />
  </AbsoluteFill>;
};
const Root = () => <Composition id="Film" component={Film} width={720} height={404} fps={30} durationInFrames={${durationInFrames}} />;
registerRoot(Root);
`);
  artifact = join(dir, "film.mp4");
  await render(entry, "Film", { output: artifact, video: true, publicDir });
  script = join(dir, "render-film.mjs");
  writeFileSync(script, "// stand-in film agent\n");
  // The guide's own check: a container with an all-zero track is a silent film, and a
  // silent film is a failure even when the canvas plays it.
  const ff = join(process.cwd(), "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");
  const check = join(dir, "check.wav");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", artifact, "-map", "0:a:0", "-ac", "1", "-ar", "44100", check]);
  const { peak } = wavStats(check);
  if (peak === 0) throw new Error("the rendered film has a silent audio track");
} else {
  throw new Error(`unknown type ${type}`);
}

const result = { prompt: asked || "stand-in", script, artifact, type: typeOut, method: type === "audio" ? "narration" : "remotion", error: null };
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (out) writeFileSync(out, JSON.stringify(result));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
