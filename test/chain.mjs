// A short, intentional content chain through the ordinary entry point: one
// poster, a video derived from it, and a WAV derived from it, then a picture of
// the whole thing. This is not part of `npm test` because it spends real model
// calls; it is the script that produces the screenshots a person looks at.
//
//   CODEX_BIN=/path/to/codex HYPERMAKER_CHROME=/path/to/chrome \
//     node test/chain.mjs
//
// HYPERMAKER_SHOTS (default `.tmp/chain`) receives the screenshots and a JSON
// record of every fact asserted along the way. CHAIN_WORKDIR keeps the node
// directories somewhere inspectable; without it a scratch directory is used and
// printed, so the artifacts can be opened afterwards.
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";
import { wavStats } from "./wav.mjs";

const root = process.cwd();
// Remotion ships its own ffmpeg; a machine with no system ffmpeg still has this.
const ffmpeg = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");
const shots = process.env.HYPERMAKER_SHOTS || join(root, ".tmp", "chain");
const workdir = process.env.CHAIN_WORKDIR || mkdtempSync("/var/tmp/hypermaker-chain-");
const model = process.env.CHAIN_MODEL || "gpt-5.6-luna";
const effort = process.env.CHAIN_EFFORT || "low";
mkdirSync(shots, { recursive: true });
if (!process.env.CODEX_BIN) console.log("note: CODEX_BIN is unset, so this will use whatever `codex` is on PATH");

const port = await freePort();
const app = startServer({ cwd: root, port, env: { HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
app.stderr.on("data", chunk => process.stderr.write(chunk));
await waitReady(port);
const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const workspace = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
const steps = [];
const note = (step, detail) => { steps.push({ at: new Date().toISOString(), step, ...detail }); console.log(JSON.stringify(steps.at(-1))); };

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = []; page.on("pageerror", error => errors.push(error.stack || String(error)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => document.querySelector("#cards"));
const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: join(shots, `${name}.png`) }); };
async function settle(id, limitMs = 900000) {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const node = (await workspace()).nodes[id];
    if (node && node.status !== "running") return { node, seconds: Math.round((Date.now() - started) / 1000) };
    await new Promise(r => setTimeout(r, 2000));
  }
  return { node: (await workspace()).nodes[id], seconds: Math.round((Date.now() - started) / 1000), timedOut: true };
}

try {
  // 1. The poster. Everything downstream reads this card as its input.
  const yes = await post("/api/node", { x: 40, y: 40, type: "image", method: "remotion", quality: "demo", prompt: "A 1200x675 poster frame on a near-black background #101217. Large centered headline SOUND HAS A SHAPE. Under it, in small letterspaced type: A FIGURE IN THREE FREQUENCIES. Below, three stacked mint #53e0c1 sine waves of the same shape, offset vertically. Flat, no gradients, high contrast." });
  const imageId = Number(Object.keys(yes.nodes).at(-1));
  await post("/api/generate", { id: imageId, model, effort });
  const image = await settle(imageId);
  note("poster rendered", { id: imageId, seconds: image.seconds, status: image.node.status, artifact: image.node.artifact, error: image.node.error });
  await shot("01-poster");
  if (image.node.error) throw new Error(`poster failed: ${image.node.error}`);

  // 2. A video that uses the poster as material, not as a description.
  const vid = await post("/api/node", { x: 400, y: 40, type: "video", method: "remotion", quality: "demo", prompt: "Animate the three sine waves from the input image as a 3-second seamless loop at 720x405, 30fps: the waves travel sideways one wavelength and return to the exact starting frame. Keep the background #101217, mint strokes #53e0c1 and the headline fixed. Return an h264 .mp4." });
  const videoId = Number(Object.keys(vid.nodes).at(-1));
  await post("/api/link", { source: imageId, target: videoId });
  await post("/api/generate", { id: videoId, model, effort });
  const video = await settle(videoId);
  note("video rendered from the poster", { id: videoId, seconds: video.seconds, status: video.node.status, artifact: video.node.artifact, error: video.node.error, inputs: video.node.inputs });
  await shot("02-video");
  if (video.node.error) throw new Error(`video failed: ${video.node.error}`);

  // 3. A WAV that uses the same material. `synth` needs nothing installed.
  const aud = await post("/api/node", { x: 760, y: 40, type: "audio", method: "synth", quality: "demo", prompt: "A 4-second 44100 Hz mono WAV that matches the three stacked waves in the input image: three sine tones at 220, 330 and 440 Hz entering one after another, 300 ms attack, 600 ms release, peak below 0.6 of full scale. Write the RIFF/WAVE header yourself." });
  const audioId = Number(Object.keys(aud.nodes).at(-1));
  await post("/api/link", { source: imageId, target: audioId });
  await post("/api/generate", { id: audioId, model, effort });
  const audio = await settle(audioId);
  note("audio rendered from the poster", { id: audioId, seconds: audio.seconds, status: audio.node.status, artifact: audio.node.artifact, error: audio.node.error, inputs: audio.node.inputs });
  await shot("03-audio");
  if (audio.node.error) throw new Error(`audio failed: ${audio.node.error}`);

  // 4. The finished piece: one film card that takes the poster and the WAV as its
  //    materials, so the result is a single file you can play with sound rather
  //    than a silent video standing next to an audio file you would have to combine.
  const film = await post("/api/node", { x: 1120, y: 40, type: "video", method: "remotion", quality: "demo", prompt: "Build one short film from the input cards and return a single .mp4 that plays with sound. Use the input image as the look of the piece: near-black #101217 background, mint #53e0c1 wave lines, the headline fixed. Make the waves travel as a seamless loop at 720x404, 30fps, h264, and keep the picture alive for the whole length of the input audio. Mix the input audio file in as the film's soundtrack so the sound is inside the .mp4. Before finishing, extract the rendered audio and confirm its samples are not all zero, and say what you measured." });
  const filmId = Number(Object.keys(film.nodes).at(-1));
  await post("/api/link", { source: imageId, target: filmId });
  await post("/api/link", { source: audioId, target: filmId });
  await post("/api/generate", { id: filmId, model, effort });
  const piece = await settle(filmId);
  note("the film, made from the poster and the wav", { id: filmId, seconds: piece.seconds, status: piece.node.status, artifact: piece.node.artifact, error: piece.node.error, sources: piece.node.sources });
  await shot("04-film");
  if (piece.node.error) throw new Error(`film failed: ${piece.node.error}`);

  // "Has an audio track" is not "has sound": a real run once produced a valid AAC
  // track of pure digital silence. Decode the track and measure it.
  const filmFile = join(workdir, String(piece.node.id), piece.node.artifact);
  const check = join(workdir, "film-audio-check.wav");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", filmFile, "-map", "0:a:0", "-ac", "1", "-ar", "44100", check]);
  const stats = wavStats(check);
  const audible = stats.peak > 200 && stats.nonzero > 0;
  note("the film's own audio, measured", { seconds: +(stats.samples / 44100).toFixed(2), peak: stats.peak, nonzeroSamples: stats.nonzero, audible });
  // Exiting 0 here would be the same lie the container-level check told: a valid
  // AAC track of digital silence is a failed film, and a person reading only the
  // exit status has to be able to trust it.
  if (!audible) throw new Error(`the film's audio is silent (peak ${stats.peak} over ${stats.samples} samples): an audio track is not sound`);
  const expected = piece.node.sources.find(s => s.type === "audio");
  if (!expected) throw new Error("the film does not record an audio source, so its sound cannot be traced");
  const sourceWav = join(workdir, String(expected.id), expected.artifact);
  const source = wavStats(sourceWav);
  if (source.peak === 0) throw new Error(`the source WAV ${expected.artifact} is itself silent`);
  note("the sound came from the canvas material", { source: expected.artifact, sourcePeak: source.peak, sourceSamples: source.samples, sourceSeconds: +(source.samples / 44100).toFixed(2) });

  // The point of a media card is that it plays. Read the players, not the status.
  const players = await page.evaluate(async () => {
    const settleMedia = (el, event) => new Promise(r => { if (el.readyState >= 1) return r(); el.addEventListener(event, r, { once: true }); setTimeout(r, 8000); });
    const audio = document.querySelector(".preview audio"), video = document.querySelector(".preview video"), img = document.querySelector(".preview img");
    const out = {};
    if (audio) { await settleMedia(audio, "loadedmetadata"); out.audio = { duration: audio.duration, seekable: audio.seekable.length, readyState: audio.readyState, error: audio.error && audio.error.code }; }
    if (video) { await settleMedia(video, "loadedmetadata"); out.video = { width: video.videoWidth, height: video.videoHeight, duration: video.duration, readyState: video.readyState }; }
    if (img) out.image = { width: img.naturalWidth, height: img.naturalHeight };
    return out;
  });
  note("the canvas plays what was generated", players);

  // Bytes, not names: a file that is only a rename would still satisfy the UI.
  const files = Object.fromEntries([["image", image], ["video", video], ["audio", audio]].map(([kind, { node }]) => {
    const file = join(workdir, String(node.id), node.artifact);
    const bytes = readFileSync(file);
    const facts = { bytes: statSync(file).size };
    if (kind === "image") Object.assign(facts, { signature: bytes.subarray(0, 8).toString("hex") });
    if (kind === "video") Object.assign(facts, { container: bytes.subarray(4, 8).toString("latin1"), brand: bytes.subarray(8, 12).toString("latin1"), hasH264: bytes.includes(Buffer.from("avc1")), hasMoov: bytes.includes(Buffer.from("moov")) });
    if (kind === "audio") Object.assign(facts, { riff: bytes.subarray(0, 4).toString("latin1"), wave: bytes.subarray(8, 12).toString("latin1"), channels: bytes.readUInt16LE(22), rate: bytes.readUInt32LE(24), bits: bytes.readUInt16LE(34), dataMatches: bytes.readUInt32LE(40) === bytes.length - 44 });
    return [kind, facts];
  }));
  note("the artifacts are the formats they claim", files);

  // 4. Reopen: the chain, its links and its previews are the workspace, not a session.
  await post("/api/layout", {});
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".card"); await page.waitForTimeout(2500);
  await shot("05-chain-reopened");
  note("the chain survives a reopen", {
    nodes: Object.values((await workspace()).nodes).map(n => ({ id: n.id, type: n.type, method: n.method, inputs: n.inputs, artifact: n.artifact, status: n.status })),
    edges: await page.locator(".edge").count()
  });
  note("browser errors", { errors });
} finally {
  writeFileSync(join(shots, "chain.json"), JSON.stringify({ workdir, shots, steps }, null, 1));
  await browser.close(); stopServer(app); stopAll();
  console.log(`\nworkdir: ${workdir}\nshots:   ${shots}`);
}
