import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

// A stand-in for the Codex CLI that really renders with Remotion: bundling,
// selecting the composition and rendering happen for real, only the "agent" is
// fake. That makes it usable as evidence that image/video generation works.
//
// The browser comes from HYPERMAKER_CHROME or CHROME_BIN when set, because
// chromium.executablePath() reports a path that may not exist when Playwright's
// own browser was never downloaded - this fixture used to hard-code that path,
// so it could never run and no test referenced it.
const dir = process.env.HYPERMAKER_NODE_DIR || process.cwd();
mkdirSync(dir, { recursive: true });
const entry = join(dir, "remotion-entry.jsx");
const script = join(dir, "render-remotion.mjs");
const video = Boolean(process.env.REMOTION_TEST_VIDEO);
const artifact = join(dir, video ? "remotion-square.mp4" : "remotion-square.png");
const fromEnv = [process.env.HYPERMAKER_CHROME, process.env.CHROME_BIN].filter(Boolean)[0];
const browser = fromEnv || chromium.executablePath();
if (fromEnv && !existsSync(fromEnv)) throw new Error(`HYPERMAKER_CHROME points at a missing browser: ${fromEnv}`);
const browserArgs = { browserExecutable: browser, chromiumOptions: { executablePath: browser } };

writeFileSync(entry, `import React from 'react';\nimport { AbsoluteFill, Composition, registerRoot } from 'remotion';\nconst Scene = () => <AbsoluteFill style={{background:'#7c3aed',justifyContent:'center',alignItems:'center',color:'white',fontSize:72}}>Remotion</AbsoluteFill>;\nconst Root = () => <Composition id="Main" component={Scene} durationInFrames={${video ? 2 : 1}} fps={30} width={320} height={180} />;\nregisterRoot(Root);\n`);
writeFileSync(script, `import { bundle } from '@remotion/bundler';\nimport { selectComposition, renderStill, renderMedia } from '@remotion/renderer';\nconst serveUrl = await bundle({ entryPoint: ${JSON.stringify(entry)}, rspack: true });\nconst composition = await selectComposition({ serveUrl, id: 'Main', browserExecutable: ${JSON.stringify(browser)} });\n${video ? `await renderMedia({ serveUrl, composition, codec: 'h264', outputLocation: ${JSON.stringify(artifact)}, browserExecutable: ${JSON.stringify(browser)}, concurrency: 1 });` : `await renderStill({ serveUrl, composition, output: ${JSON.stringify(artifact)}, frame: 0, browserExecutable: ${JSON.stringify(browser)} });`}\n`);

const { bundle } = await import("@remotion/bundler");
const { selectComposition, renderStill, renderMedia } = await import("@remotion/renderer");
const serveUrl = await bundle({ entryPoint: entry, rspack: true });
const composition = await selectComposition({ serveUrl, id: "Main", ...browserArgs });
if (video) await renderMedia({ serveUrl, composition, codec: "h264", outputLocation: artifact, ...browserArgs, concurrency: 1 });
else await renderStill({ serveUrl, composition, output: artifact, frame: 0, ...browserArgs });
const result = { prompt: "remotion test", script, artifact, type: video ? "video" : "image", method: "remotion", error: null };
const output = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (output) writeFileSync(output, JSON.stringify(result));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
