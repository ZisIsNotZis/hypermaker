import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A stand-in agent that produces a genuinely playable WAV with nothing installed:
// the same thing the `synth` method asks a real agent to do. It exists so the
// audio card path (artifact on disk, file endpoint, <audio> preview) can be
// exercised on a machine with no tts.cpp, bark.cpp, ffmpeg or sox.
const dir = process.env.HYPERMAKER_NODE_DIR || process.cwd();
mkdirSync(dir, { recursive: true });
// Length matters: with no content-length the WAV player only reports a duration
// while the whole file fits its read-ahead buffer. A 2-second clip (176 KB) came
// back with `duration: 2` even from the broken endpoint, so it proved nothing;
// the real 4-second agent WAV (352 KB) reported `null`. This fixture is a normal
// clip length so the player assertion fails when the endpoint regresses.
const rate = 44100, seconds = 6, frames = rate * seconds;
const samples = Buffer.alloc(frames * 2);
for (let i = 0; i < frames; i++) {
  const t = i / rate, env = Math.min(1, t / 0.05, (seconds - t) / 0.1);
  const value = env * 0.5 * (Math.sin(2 * Math.PI * 440 * t) + 0.4 * Math.sin(2 * Math.PI * 660 * t));
  samples.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + samples.length, 4); header.write("WAVE", 8, "ascii");
header.write("fmt ", 12, "ascii"); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write("data", 36, "ascii"); header.writeUInt32LE(samples.length, 40);

const script = join(dir, "make-tone.mjs");
writeFileSync(script, "// written by the stand-in agent\n");
const artifact = join(dir, "tone-test.wav");
writeFileSync(artifact, Buffer.concat([header, samples]));
const result = { prompt: "a test tone", script, artifact, type: "audio", method: "synth", error: null };
const output = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (output) writeFileSync(output, JSON.stringify(result));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
