// The first take, and the first film, with no model in the path.
//
// WHY THIS EXISTS. Every method in `types/` until now handed the job to Codex: the agent read
// the guide, called `voice/render.mjs` or Remotion, and wrote a JSON line naming what it made.
// That is the right shape for a creative decision, and the wrong shape for the two decisions a
// first film does not actually contain. Reading a sentence out loud and putting a picture under
// it are mechanical: the words are already on the card, the voice ships in this repository, and
// the film is one audio track over one still. Pressing Generate for that used to require a Codex
// install with a working model route - and on this machine the route does not answer at all
// (see `docs/evidence/README.md`), so a person with a sentence and no account could not get a
// single playable film out of the canvas.
//
// So these two are methods the *server* runs. They are still methods: they appear in the same
// dropdown, they get the same run directory, the same guard over the card's files, the same
// `publish` under a fresh `v2-` name, the same kept versions and the same settling - because
// they are dispatched inside `/api/generate`, not beside it. The only thing that changes is
// what produces the bytes.
//
// WHAT IS NOT SIMPLIFIED. Neither path trusts itself:
//   * a narration is checked by `verifyNarration` exactly as an agent's take is - the timeline
//     must describe this WAV, the WAV must measure as speech, and every spoken word must be one
//     of the words the card was given;
//   * a film is checked by `verifyFilm`, which is a real video stream, a real duration, and an
//     embedded track that is loud *and* correlated with the narration the take says it used. A
//     render that came out silent is refused, which is the failure a real agent produced once
//     and every cheaper check passed.
//
// A refusal is a sentence the person can act on, and it never publishes: the error goes back
// through the same branch that keeps the previous take on the card.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { wavSamples } from "../voice/wav.mjs";
import { audit } from "../voice/lexicon.mjs";
import { paceOf } from "../voice/synth.mjs";

// A Stop is a Stop, whether it arrived while a renderer was running or between two renders. The
// caller answers it with `cancelled` and the previous take intact, which is what every other
// stopped run does; typing it is what stops a Stop being reported as a failed render.
export class StoppedError extends Error {
  constructor(message = "Run stopped by the user") { super(message); this.stopped = true; this.name = "StoppedError"; }
}
export const isStopped = error => error instanceof StoppedError || error?.stopped === true;

// The words this card is asking to hear, one phrase per line.
//
// Two sources, in the order a person would expect: a linked text card, whose frozen copy is what
// this run was given, and otherwise the card's own prompt. Both are *material* - the same two
// places `materialText` reads - so the take can be checked for having added nothing. Blank lines
// are dropped rather than kept: the voice turns a line into a phrase, and an empty line would
// become a phrase with no words in it, which the timeline check refuses. A line with a symbol
// the voice cannot name is refused here, by name, before a render is spent.
export function scriptFor({ sources = [], prompt = "" }) {
  const text = sources.find(s => s.type === "text" && s.frozen && existsSync(s.frozen));
  const raw = text ? readFileSync(text.frozen, "utf8") : String(prompt || "");
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) {
    throw new Error("There is nothing to read out loud yet: write a sentence in the prompt, or link a text card with the words. Nothing was rendered.");
  }
  const refused = [];
  for (const line of lines) {
    const checked = audit(line);
    if (!checked.unreadable.length) continue;
    const why = [...new Set(checked.reasons || [])];
    refused.push(`${[...new Set(checked.unreadable)].join(", ")}${why.length ? ` (${why.join("; ")})` : ""}`);
  }
  if (refused.length) {
    throw new Error(`This voice cannot say ${refused.join("; ")}. Spell it out in words in the script instead; nothing was rendered.`);
  }
  return { script: lines.join("\n"), from: text ? { id: Number(text.id), artifact: text.artifact } : null };
}

// One child process for `voice/render.mjs`, cancellable, so Stop reaches the renderer the same
// way it reaches an agent. The renderer's own sentence is carried out rather than "Command
// failed": `200 words per minute is outside what this voice can do for this script` names both
// the limit and the pace the script reaches as written.
function render(args, cancelRef = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    cancelRef.child = child;
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("error", error => fail(error));
    child.on("close", (code, signal) => {
      cancelRef.child = null;
      if (cancelRef.stopped) return fail(new StoppedError());
      if (code === 0) return done({ stdout, stderr });
      const lines = stderr.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const useful = lines.find(l => /outside what this voice can do|no way to say|is a (currency|fraction|mathematical|unit)/.test(l))
        ?? lines.find(l => !/^\s*at |^node:internal|^\^+$/.test(l))
        ?? `the renderer exited with code ${code}${signal ? ` (${signal})` : ""}`;
      fail(new Error(useful));
    });
  });
}

// THE FIRST TAKE. `--wpm` is the pace a person set on the card before pressing Generate, so the
// first recording is at the pace they chose instead of at whatever an instruction in the prompt
// happened to produce. With no pace set the voice reads at its own ordinary speed, and the take
// records the pace it reached, so the card says a number either way.
//
// A `--wpm` the voice cannot reach is refused by the renderer before the WAV exists, so nothing
// is published at all; the sentence names the limit and the pace the script reaches as written.
export async function readAloud({ projectRoot, attemptDir, script, wpm = null, cancelRef = {} }) {
  const scriptFile = join(attemptDir, "script.txt");
  writeFileSync(scriptFile, `${script}\n`, "utf8");
  const out = join(attemptDir, "narration.wav"), timeline = join(attemptDir, "timeline.json");
  const args = [join(projectRoot || process.cwd(), "voice", "render.mjs"), "--file", scriptFile, "--out", out, "--timeline", timeline];
  if (wpm != null) args.push("--wpm", String(wpm));
  await render(args, cancelRef);
  if (!existsSync(out) || !existsSync(timeline)) throw new Error("the renderer reported success but wrote no take");
  return { artifact: out, script: scriptFile, timeline: JSON.parse(readFileSync(timeline, "utf8")) };
}

// What a film's own record keeps: the pace it reads at, measured from the take it turns into a
// film rather than read back from the number that was asked for.
export function paceOfTimeline(timeline) {
  const phrases = Array.isArray(timeline?.phrases) ? timeline.phrases : [];
  const at = paceOf(phrases.map(p => ({ words: String(p.text || "").split(/\s+/).filter(Boolean).length, duration: Number(p.duration) || 0 })));
  return { wpm: Number(at.wpm.toFixed(1)), words: at.words, seconds: Number(at.seconds.toFixed(2)), ...(timeline?.pace?.askedWpm ? { askedWpm: Number(timeline.pace.askedWpm) } : {}) };
}

const chromePath = () => process.env.HYPERMAKER_CHROME || process.env.CHROME_BIN || null;

// THE FIRST FILM. The picture is the linked poster when there is one, a title from the linked
// text when there is one, and the narration as the soundtrack. The duration is the soundtrack's
// own length, computed from its sample count and rate, because a fixed length is what cut the
// last half of a sentence off a film once and every cheap check still passed.
//
// The `public/` and `build/` directories are inside the run directory, so nothing is written
// next to what a person keeps and the whole attempt is dropped with the run.
export async function firstCut({ attemptDir, sources = [], cancelRef = {} }) {
  const audio = sources.find(s => s.type === "audio" && s.frozen && existsSync(s.frozen));
  if (!audio) {
    throw new Error("A film needs a soundtrack: link an audio card with the narration, then press Generate. Nothing was rendered.");
  }
  const poster = sources.find(s => s.type === "image" && s.frozen && existsSync(s.frozen));
  const words = sources.find(s => s.type === "text" && s.frozen && existsSync(s.frozen));
  const chrome = chromePath();
  if (!chrome) throw new Error("Rendering a film needs a browser for Remotion. Set HYPERMAKER_CHROME (or CHROME_BIN) to a Chromium build and press Generate again. Nothing was rendered.");
  if (!existsSync(chrome)) throw new Error(`HYPERMAKER_CHROME points at ${chrome}, which does not exist, so Remotion cannot start. Nothing was rendered.`);

  const { rate, samples } = wavSamples(readFileSync(audio.frozen));
  const seconds = samples.length / rate;
  const fps = 30, durationInFrames = Math.max(1, Math.ceil(seconds * fps));
  // The title is the first line of the linked text: the words the narration is reading, so a
  // person can see the film belongs to the take rather than to some other sentence.
  const title = words ? (readFileSync(words.frozen, "utf8").split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0] || "").slice(0, 90) : "";

  const publicDir = join(attemptDir, "public");
  mkdirSync(publicDir, { recursive: true });
  copyFileSync(audio.frozen, join(publicDir, "track.wav"));
  const posterExt = poster ? (/\.(\w+)$/.exec(basename(poster.frozen))?.[0] || ".png") : null;
  const posterName = posterExt ? `poster${posterExt}` : null;
  if (poster && posterName) copyFileSync(poster.frozen, join(publicDir, posterName));

  // The composition is written out per run rather than shipped as a template, because every part
  // of it is a fact about this attempt: which poster, how long, and which words are on screen.
  // React escapes nothing in a text node built from a template, so the title is escaped here.
  const titleJsx = JSON.stringify(title).slice(1, -1).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const entry = join(attemptDir, "first-cut.jsx");
  writeFileSync(entry, [
    "import React from 'react';",
    "import { AbsoluteFill, Audio, Composition, Img, interpolate, registerRoot, staticFile, useCurrentFrame } from 'remotion';",
    "const Film = () => {",
    "  const frame = useCurrentFrame();",
    "  const fade = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' });",
    "  return <AbsoluteFill style={{ background: '#0d0f13' }}>",
    posterName
      ? `    <Img src={staticFile(${JSON.stringify(posterName)})} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />`
      : "    <AbsoluteFill style={{ background: 'radial-gradient(circle at 30% 20%, #1d2733, #0d0f13 70%)' }} />",
    "    <AbsoluteFill style={{ justifyContent: 'flex-end', padding: 56, background: 'linear-gradient(to top, rgba(0,0,0,0.72), rgba(0,0,0,0))', opacity: fade }}>",
    `      <div style={{ color: '#f2f4f7', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 44, lineHeight: 1.2, maxWidth: '86%', textShadow: '0 2px 12px rgba(0,0,0,0.6)' }}>${titleJsx}</div>`,
    "    </AbsoluteFill>",
    "    <Audio src={staticFile('track.wav')} />",
    "  </AbsoluteFill>;",
    "};",
    `const Root = () => <Composition id="Film" component={Film} width={1280} height={720} fps={${fps}} durationInFrames={${durationInFrames}} />;`,
    "registerRoot(Root);",
    ""
  ].join("\n"));

  const { bundle } = await import("@remotion/bundler");
  const { renderMedia, selectComposition, makeCancelSignal } = await import("@remotion/renderer");
  const browserArgs = { browserExecutable: chrome, chromiumOptions: { executablePath: chrome } };
  const buildDir = join(attemptDir, "build");
  const artifact = join(attemptDir, "film.mp4");
  // Remotion 4.0.513's own shape, checked against the installed package rather than assumed:
  // `makeCancelSignal()` returns `{cancelSignal, cancel}`, not the `[signal, cancel]` tuple this
  // line first destructured. That mistake is what stopped the first real film one frame in - the
  // narration had already been rendered and published, so the card showed a take and no film, and
  // the error was a TypeError about destructuring rather than anything to do with the render.
  const { cancelSignal, cancel: cancelRenderer } = makeCancelSignal();
  // Stop during a render has to reach the renderer, not only the next check after it: a film
  // takes seconds to minutes, which is exactly the window a person presses Stop in.
  cancelRef.cancelRenderer = cancelRenderer;
  try {
    const serveUrl = await bundle({ entryPoint: entry, publicDir, rspack: true, outDir: buildDir });
    const composition = await selectComposition({ serveUrl, id: "Film", ...browserArgs });
    await renderMedia({ serveUrl, composition, codec: "h264", outputLocation: artifact, audioCodec: "aac", concurrency: 1, cancelSignal, ...browserArgs });
  } catch (error) {
    if (cancelRef.stopped) throw new StoppedError();
    throw new Error(`the film did not render: ${error.message}`);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
    cancelRef.cancelRenderer = null;
  }
  if (!existsSync(artifact) || statSync(artifact).size === 0) throw new Error("the renderer reported success but wrote no film");
  // What made the picture, kept beside the film: the composition itself, not a description of it.
  //
  // The first version published a file of comments naming the soundtrack, the length and the
  // poster, and a supervisor opened it expecting the render's source and found that the thing
  // that decided how the film looks was not in it at all - the actual JSX lived in the run
  // directory, which is dropped as soon as the run succeeds. A take whose record cannot reproduce
  // its own bytes is the failure the narration timeline exists to prevent, and the film had the
  // same hole in a place nobody had looked. The composition is small JSON-free JSX on purpose, so
  // saving it costs a few hundred bytes and answers "what made this film?" with the file itself.
  const script = join(attemptDir, "first-cut-source.jsx");
  const provenance = [
    "// Written by the server for this take and published beside the film it rendered.",
    "// To re-render the same picture: bundle this file with a publicDir holding",
    `// track.wav${posterName ? ` and ${posterName}` : ""}, then render composition Film.`,
    `// soundtrack: ${basename(audio.frozen)} (${seconds.toFixed(2)} s at ${rate} Hz)`,
    `// ${fps} fps, ${durationInFrames} frames, 1280x720, h264 with an AAC track`,
    poster ? `// poster: ${basename(poster.frozen)}` : "// no poster: a flat gradient",
    title ? `// title: ${title}` : "// no title: no linked text card",
    ""
  ].join("\n");
  writeFileSync(script, provenance + readFileSync(entry, "utf8"), "utf8");
  // The bundle's own entry is not kept: it is the same composition without the header, and two
  // copies of one source is how they drift. The published file is this one.
  return { artifact, script, seconds, frames: durationInFrames, rate, soundtrack: audio, poster, title };
}
