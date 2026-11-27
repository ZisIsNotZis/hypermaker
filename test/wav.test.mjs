import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wavStats } from "./wav.mjs";

// A measuring helper that assumed a 44-byte header published `peak 30496` for a film
// whose real peak is 11506, because ffmpeg puts a LIST chunk between `fmt ` and
// `data`. These cases pin the chunk walk so a plausible-looking number cannot be
// reported again.
const dir = mkdtempSync(join(tmpdir(), "hypermaker-wav-"));

function wav({ extraChunk = null, samples }) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(v, i * 2));
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "latin1"); fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(44100, 12);
  fmt.writeUInt32LE(44100 * 2, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const chunks = [fmt];
  if (extraChunk) chunks.push(extraChunk);
  const dataChunk = Buffer.alloc(8);
  dataChunk.write("data", 0, "latin1"); dataChunk.writeUInt32LE(data.length, 4);
  chunks.push(dataChunk, data);
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(body.length + 4, 4); header.write("WAVE", 8, "latin1");
  return Buffer.concat([header, body]);
}

test("samples are read from the data chunk, not from byte 44", () => {
  const plain = join(dir, "plain.wav");
  writeFileSync(plain, wav({ samples: [0, 1000, -2000, 0] }));
  assert.deepEqual(wavStats(plain), { samples: 4, peak: 2000, nonzero: 2, bytes: 8 });

  // The exact shape ffmpeg writes: a 62-byte LIST chunk before the data.
  const list = Buffer.alloc(8 + 62);
  list.write("LIST", 0, "latin1"); list.writeUInt32LE(62, 4);
  for (let i = 8; i < list.length; i++) list.writeUInt8(0xff, i); // bytes that look like loud audio
  const withList = join(dir, "with-list.wav");
  writeFileSync(withList, wav({ extraChunk: list, samples: [0, 1000, -2000, 0] }));

  const stats = wavStats(withList);
  assert.equal(stats.samples, 4, "the LIST chunk is not counted as audio");
  assert.equal(stats.peak, 2000, "the peak comes from the samples, not from header bytes");
  assert.equal(stats.nonzero, 2);
});

test("a silent track measures as silent, and a non-WAV is rejected", () => {
  const silentFile = join(dir, "silent.wav");
  writeFileSync(silentFile, wav({ samples: [0, 0, 0, 0] }));
  const silent = wavStats(silentFile);
  assert.equal(silent.peak, 0);
  assert.equal(silent.nonzero, 0, "silence is distinguishable from a container that merely has a track");

  const textFile = join(dir, "not-a-wav.wav");
  writeFileSync(textFile, "just text");
  assert.throws(() => wavStats(textFile), /not a RIFF\/WAVE file/);
});
