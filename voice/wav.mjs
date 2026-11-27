// Read a WAV's declared sample rate and its samples as floats in -1..1.
//
// `test/wav.mjs` walks the chunk table for peak and non-silent counts; this is the same
// walk with the samples returned, because the voice tools need the signal itself (formant
// energy, autocorrelation) and not just a summary. The chunk table has to be walked rather
// than assuming the data starts at byte 44: a file written by this voice does start there,
// but one written by ffmpeg has a `LIST` chunk first, and a probe that read from 44 measured
// audio that nobody can hear.
import { readFileSync } from "node:fs";

export function wavSamples(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : readFileSync(buffer);
  if (b.subarray(0, 4).toString("latin1") !== "RIFF" || b.subarray(8, 12).toString("latin1") !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let at = 12, rate = 0, channels = 1, bits = 16;
  while (at + 8 <= b.length) {
    const id = b.subarray(at, at + 4).toString("latin1");
    const size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      channels = b.readUInt16LE(body + 2);
      rate = b.readUInt32LE(body + 4);
      bits = b.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (!rate) throw new Error("data chunk before fmt chunk");
      if (bits !== 16) throw new Error(`only 16-bit PCM is read here, got ${bits}`);
      const end = Math.min(body + size, b.length);
      const count = Math.floor((end - body) / 2 / channels);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = b.readInt16LE(body + i * 2 * channels) / 32768;
      return { rate, channels, bits, samples };
    }
    at += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}
