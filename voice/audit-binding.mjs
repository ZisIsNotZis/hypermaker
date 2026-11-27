#!/usr/bin/env node
// The numbers that justify how `voice/bind.mjs` compares a take with its script.
//
//   node voice/audit-binding.mjs
//
// Every threshold in the binding check comes from a measurement, and a measurement that only
// exists in a scratch directory nobody can open is a claim. This prints them again from the
// shipped voice: the same phrase, edits that keep the length, edits that change it, the
// reviewer's long take with a swapped ending, and the whole-phrase correlation that was tried
// first and rejected. Nothing here uses a fixture - it renders the real voice.
//
// Read it as: "the gap either side of SAME_TAKE (0.5) is this wide, on this build."
import { renderParagraph, RATE } from "./synth.mjs";
import { frameAgreement, correlation, bindTake, SAME_TAKE } from "./bind.mjs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const line = (label, whole, frame, note = "") =>
  console.log(`  ${label.padEnd(40)} whole-phrase ${whole.toFixed(3).padStart(6)}   worst-frame ${String(frame).padStart(7)}   ${note}`);

const same = (a, b) => {
  const x = renderParagraph([{ text: a }], {}).samples;
  const y = renderParagraph([{ text: b }], {}).samples;
  const n = Math.min(x.length, y.length);
  return { whole: correlation(x.slice(0, n), y.slice(0, n)), frame: frameAgreement(x, y, RATE).score, lengths: [x.length, y.length] };
};
const ACCEPT = s => (s >= SAME_TAKE ? "accept" : "refuse");

console.log("Same phrase, and edits to it (this is why the unit is the frame):\n");
{
  const cases = [
    ["the same phrase", "The path goes past the old stone wall.", "The path goes past the old stone wall."],
    ["one word changed", "The sea at night is never still.", "The sea at noon is never still."],
    ["a word at the very end", "Open the blue door.", "Open the blue gate."],
    ["reworded only at the end", "And then the room is quiet.", "And then the room is bright."]
  ];
  for (const [label, a, b] of cases) {
    const r = same(a, b);
    line(label, r.whole, r.frame, `frame ${ACCEPT(r.frame)}, whole-phrase would ${ACCEPT(r.whole)}`);
  }
}

console.log("\nSubstitutions that keep the rendered length exactly - invisible to any duration check:\n");
{
  const template = "The path goes past the old stone WORD.";
  for (const word of ["hedge", "mill", "well"]) {
    const r = same(template.replace("WORD", "wall"), template.replace("WORD", word));
    const equal = Math.abs(r.lengths[0] - r.lengths[1]) <= 2;
    line(`wall -> ${word}`, r.whole, r.frame, `${equal ? "same length to the sample" : "length differs"}; frame ${ACCEPT(r.frame)}, whole-phrase would ${ACCEPT(r.whole)}`);
  }
}

console.log("\nThe reviewer's long take: twelve sentences, only the last two clauses differ.\n");
{
  const head = [
    "The sea at night is never still.", "It carries every colour of the sky.",
    "The light is moving over the water.", "The room is silent as the night comes.",
    "Turn and look out at the street.", "There is a light under the bridge.",
    "Walk slowly down toward the house.", "The garden is quiet in the rain.",
    "A window shines in the distance.", "The path goes past the old stone wall."
  ];
  const spoken = [...head, "Open the blue door.", "Close the red gate."];
  const claimed = [...head, "Open the red gate.", "Close the blue door."];
  const dir = mkdtempSync(join(tmpdir(), "hypermaker-audit-"));
  const whole = renderParagraph(spoken.map(text => ({ text })), {});
  writeFileSync(join(dir, "n.wav"), Buffer.from(
    // write through the same encoder the renderer uses
    (() => {
      const data = Buffer.alloc(whole.samples.length * 2);
      whole.samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
      const h = Buffer.alloc(44);
      h.write("RIFF", 0, "ascii"); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8, "ascii");
      h.write("fmt ", 12, "ascii"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
      h.writeUInt32LE(whole.rate, 24); h.writeUInt32LE(whole.rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
      h.write("data", 36, "ascii"); h.writeUInt32LE(data.length, 40);
      return Buffer.concat([h, data]);
    })()
  ));
  const started = performance.now();
  const result = bindTake({ file: join(dir, "n.wav"), timeline: { voice: whole.voice, phrases: renderParagraph(claimed.map(text => ({ text })), {}).segments } });
  const ms = Math.round(performance.now() - started);
  const fileLevel = correlation(whole.samples, renderParagraph(claimed.map(text => ({ text })), {}).samples);
  console.log(`  a whole-file correlation of this mixed take: ${fileLevel.toFixed(3)}  (above 0.85, so the first design accepted it)`);
  console.log(`  the phrase-and-frame check:                  ok=${result.ok}, worst ${result.correlation}, ${result.problems.length} phrase(s) named, ${ms} ms`);
  for (const p of result.problems) console.log(`    ${p}`);
  console.log(`  honest version of the same recording:        ok=${bindTake({ file: join(dir, "n.wav"), timeline: { voice: whole.voice, phrases: whole.segments } }).ok}`);
}

console.log(`\nSAME_TAKE = ${SAME_TAKE}: an honest phrase measures 1.000 on every frame, an edited one is negative.`);
