import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

// Renders the poster for real, so a downstream film card is linked to an artifact
// that exists and can be read - which is what "made from these materials" means.
const dir = process.env.HYPERMAKER_NODE_DIR || process.cwd();
mkdirSync(dir, { recursive: true });
const entry = join(dir, "poster-entry.jsx");
writeFileSync(entry, `
import React from 'react';
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
const Poster = () => <AbsoluteFill style={{ background: '#101217', justifyContent: 'center', alignItems: 'center' }}>
  <div style={{ color: '#f5f1e8', fontSize: 64, fontFamily: 'Arial', letterSpacing: 3 }}>SOUND HAS A SHAPE</div>
  <div style={{ color: '#53e0c1', fontSize: 20, fontFamily: 'Arial', letterSpacing: 6, marginTop: 12 }}>A FIGURE IN THREE FREQUENCIES</div>
</AbsoluteFill>;
const Root = () => <Composition id="Poster" component={Poster} width={480} height={270} fps={30} durationInFrames={1} />;
registerRoot(Root);
`);
const chrome = process.env.HYPERMAKER_CHROME || process.env.CHROME_BIN;
const browserArgs = chrome ? { browserExecutable: chrome, chromiumOptions: { executablePath: chrome } } : {};
const serveUrl = await bundle({ entryPoint: entry, rspack: true });
const composition = await selectComposition({ serveUrl, id: "Poster", ...browserArgs });
const artifact = join(dir, "sound-poster.png");
await renderStill({ serveUrl, composition, output: artifact, frame: 0, ...browserArgs });

const script = join(dir, "render-poster.mjs");
writeFileSync(script, "// written by the stand-in agent\n");
const result = { prompt: "the poster", script, artifact, type: "image", method: "remotion", error: null };
const output = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (output) writeFileSync(output, JSON.stringify(result));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
