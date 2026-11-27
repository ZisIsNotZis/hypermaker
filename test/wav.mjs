import { readFileSync } from "node:fs";

// Peak and non-silent count of a WAV's actual sample data.
//
// The `data` chunk is NOT always at byte 44. ffmpeg writes a `LIST` chunk first, so
// reading `subarray(44)` mixes 62 bytes of header into the samples and reports a
// peak nobody can hear: it said 30496 for audio whose real peak is 11506. Walk the
// chunk table instead, and treat an odd-sized chunk as padded.
export function wavStats(file) {
  const b = readFileSync(file);
  if (b.subarray(0, 4).toString("latin1") !== "RIFF" || b.subarray(8, 12).toString("latin1") !== "WAVE") {
    throw new Error(`${file} is not a RIFF/WAVE file`);
  }
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.subarray(at, at + 4).toString("latin1");
    const size = b.readUInt32LE(at + 4);
    if (id === "data") {
      const data = b.subarray(at + 8, Math.min(at + 8 + size, b.length));
      let peak = 0, nonzero = 0;
      for (let i = 0; i + 1 < data.length; i += 2) {
        const v = Math.abs(data.readInt16LE(i));
        if (v > peak) peak = v;
        if (v) nonzero++;
      }
      return { samples: Math.floor(data.length / 2), peak, nonzero, bytes: data.length };
    }
    at += 8 + size + (size & 1);
  }
  throw new Error(`${file} has no data chunk`);
}
