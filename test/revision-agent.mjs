// Offline stand-in for the agent in the revision story. It renders real media so
// "which material and which prompt went into which take" is readable from the
// bytes a person actually sees, not from metadata.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";

const dir = process.env.HYPERMAKER_NODE_DIR;
const type = process.env.HYPERMAKER_NODE_TYPE;
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
mkdirSync(dir, { recursive: true });
const prompt = readFileSync(join(dir, "prompt.txt"), "utf8");
// Split on the prompt's own top-level headings. A `m`-flagged `$` lookahead
// stopped at the first line end and quietly handed this fixture one line of each
// section, so the film rendered from an empty INPUTS block.
const section = name => {
  const at = prompt.indexOf(`\n# ${name}\n`);
  if (at < 0) return "";
  const from = at + name.length + 4;
  const next = prompt.indexOf("\n\n# ", from);
  return (next < 0 ? prompt.slice(from) : prompt.slice(from, next)).trim();
};
const userPrompt = section("USER PROMPT").trim();
const inputs = section("INPUTS");
const textBlock = (/artifact content:\n```\n([\s\S]*?)```/.exec(inputs) || [])[1] || "";
const poster = (/artifact path: (\S+\.png)/.exec(inputs) || [])[1] || "";

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

let artifact, script;
if (type === "text") {
  artifact = join(dir, "note.txt");
  writeFileSync(artifact, userPrompt + "\n");
  script = join(dir, "write-note.mjs");
  writeFileSync(script, "// stand-in text\n");
} else if (type === "image") {
  artifact = join(dir, "poster.png");
  const entry = join(dir, "poster-entry.jsx");
  const bg = /second/.test(userPrompt) ? "#2b1d4f" : "#101217";
  writeFileSync(entry, `
import React from 'react';
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
const Poster = () => <AbsoluteFill style={{ background: '${bg}', justifyContent: 'center', alignItems: 'center' }}>
  <div style={{ color: '#f5f1e8', fontSize: 56, fontFamily: 'Arial' }}>${userPrompt.replace(/[<>&]/g, "")}</div>
</AbsoluteFill>;
const Root = () => <Composition id="Poster" component={Poster} width={320} height={180} fps={30} durationInFrames={1} />;
registerRoot(Root);
`);
  await render(entry, "Poster", { output: artifact });
  script = join(dir, "render-poster.mjs");
  writeFileSync(script, "// stand-in poster render\n");
} else if (type === "video") {
  artifact = join(dir, "film.mp4");
  const publicDir = join(dir, "public");
  mkdirSync(publicDir, { recursive: true });
  if (poster && existsSync(poster)) copyFileSync(poster, join(publicDir, "poster.png"));
  const entry = join(dir, "film-entry.jsx");
  writeFileSync(entry, `
import React from 'react';
import { AbsoluteFill, Composition, Img, staticFile, registerRoot } from 'remotion';
const Film = () => <AbsoluteFill style={{ background: '#0b0d12' }}>
  <Img src={staticFile('poster.png')} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.55 }} />
  <AbsoluteFill style={{ justifyContent: 'flex-end', padding: 28 }}>
    <div style={{ color: '#53e0c1', fontSize: 22, fontFamily: 'Arial' }}>PROMPT: ${JSON.stringify(userPrompt)}</div>
    <div style={{ color: '#ffffff', fontSize: 26, fontFamily: 'Arial' }}>TEXT: ${JSON.stringify(textBlock.trim())}</div>
  </AbsoluteFill>
</AbsoluteFill>;
const Root = () => <Composition id="Film" component={Film} width={640} height={360} fps={30} durationInFrames={45} />;
registerRoot(Root);
`);
  await render(entry, "Film", { output: artifact, video: true, publicDir });
  script = join(dir, "render-film.mjs");
  writeFileSync(script, "// stand-in film render\n");
} else {
  throw new Error(`unknown type ${type}`);
}

const result = { prompt: "stand-in", script, artifact, type, method: "remotion", error: null };
if (out) writeFileSync(out, JSON.stringify(result));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
