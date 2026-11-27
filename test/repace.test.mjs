// Asking an approved narration for the same words at another pace.
//
// The user's question was whether a person can get a take at a pace that suits them and compare
// it with the previous pace "without redoing the whole film". Pressing Generate again is not that:
// it costs a model turn, re-chooses the script, and on this machine the model route does not
// answer at all (see `docs/evidence/`). So `/api/repace` re-reads the take's own recorded words
// with the repository's voice and publishes through the same gate an agent take faces.
//
// Three things have to be true for that to be worth having, and each is held down here:
//
//   1. the new take really is the same words at the pace that was asked for, measured from the
//      published bytes rather than read back from the tool's claim, and the earlier take is
//      still on the card one click away;
//   2. a take that cannot be re-read says why instead of producing something else - no take yet,
//      no recorded timeline, a tone card, a pace the voice cannot reach;
//   3. Stop during the re-read leaves the approved take exactly where it was, and a successful
//      re-read settles the card. The third one is written against a defect an operator found in
//      the first version of this route: the comparison against the previous take caught the kill
//      signal as if it were an answer, so a stopped re-read published a new take while the
//      receipt said the user had stopped it, and a *successful* one left the card on
//      `Generating…` forever because the success path never wrote `idle`.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";
import { wavSamples } from "../voice/wav.mjs";
import { paceOf } from "../voice/synth.mjs";

const root = process.cwd(), base = mkdtempSync(join(tmpdir(), "hypermaker-repace-")), bin = join(base, "codex");
// The same honest stand-in the narration test uses: it reads the text out of the prompt and runs
// the real `voice/render.mjs`, so the take this route re-reads is the shipped voice's output.
writeFileSync(bin, `#!/bin/sh
case "$HYPERMAKER_NODE_TYPE" in
  text) exec node ${JSON.stringify(join(root, "test/fake-narration-text-codex.mjs"))} "$@" ;;
  *) exec node ${JSON.stringify(join(root, "test/fake-narration-codex.mjs"))} "$@" ;;
esac
`);
chmodSync(bin, 0o755);

const SCRIPT = "The tide comes in at six.\nThe boat waits.";

let port, workdir, app;
before(async () => {
  port = await freePort();
  workdir = join(base, "ws");
  app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1", HYPERMAKER_PROJECT: root } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
});
after(async () => { stopServer(app); stopAll(); });

const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const workspace = () => fetch(`http://127.0.0.1:${port}/api/workspace`).then(r => r.json());
const latest = res => Number(Object.keys(res.nodes).at(-1));
async function settle(id, tries = 900) {
  for (let i = 0; i < tries; i++) {
    const n = (await workspace()).nodes[id];
    if (n && n.status !== "running" && (n.artifact || n.error)) return n;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`node ${id} never settled: ${JSON.stringify((await workspace()).nodes[id])}`);
}
// A card whose take is already published, made the way a person makes one: a text card, a linked
// narration card, one Generate.
async function narratedCard() {
  const text = latest(await post("/api/node", { x: 40, y: 40, type: "text", method: "llm", prompt: SCRIPT }));
  await post("/api/generate", { id: text, prompt: SCRIPT });
  const words = await settle(text);
  assert.ok(words.artifact, `the words did not publish: ${words.error}`);
  const audio = latest(await post("/api/node", { x: 400, y: 40, type: "audio", method: "narration", prompt: "Read this." }));
  await post("/api/link", { source: text, target: audio });
  await post("/api/generate", { id: audio, prompt: "Read this." });
  const first = await settle(audio);
  assert.ok(first.artifact, `the narration did not publish: ${first.error}`);
  return { text, audio, first };
}
// What the published bytes actually say, in words per minute: the timeline is what the tool
// claims, and this is the file. The window is generous because the whole line includes the gap
// after the last phrase; what matters is that the two takes are clearly apart.
// `artifact` is relative to the card's own directory (`versions/v2-narration.wav`), not to the
// workspace root - the same convention every other record uses.
function measuredWpm(id, file) {
  const { rate, samples } = wavSamples(join(workdir, String(id), String(file)));
  const words = SCRIPT.split(/\s+/).filter(Boolean).length;
  return paceOf([{ words, duration: samples.length / rate }]).wpm;
}

test("a take can be read again at another pace, and the earlier one is still there", async () => {
  const { audio, first } = await narratedCard();
  const beforeWpm = first.narration.pace.wpm;
  assert.ok(beforeWpm > 100 && beforeWpm < 200, `the first take reads at an ordinary pace, got ${beforeWpm}`);

  const reply = await post("/api/repace", { id: audio, wpm: 200 });
  assert.equal(reply.code ?? 202, 202, `the re-read was refused: ${reply.error}`);
  const second = await settle(audio);
  assert.equal(second.error, null, `the re-read failed: ${second.error}`);
  // 3. A finished re-read settles the card. The first version of this route did not, and the
  // card sat on `Generating…` with a done take behind it.
  assert.equal(second.status, "idle", `the card did not settle after a successful re-read: ${second.status}`);

  assert.notEqual(second.artifact, first.artifact, "the re-read published over the take it was asked to re-read");
  assert.equal(second.versions.length, 1, "the take it was re-read from is kept as a version");
  assert.equal(second.versions[0].artifact, first.artifact, "the kept version is the take that was on the card before");
  assert.equal(second.versions[0].prompt, first.promptUsed, "the kept version keeps the instruction it was made from");

  // 1. The same words, at the pace that was asked for, measured from the published bytes.
  assert.equal(second.narration.words, first.narration.words, "a re-read says the same number of words");
  assert.equal(second.narration.phrases.map(p => p.text).join("\n"), first.narration.phrases.map(p => p.text).join("\n"), "a re-read says the same sentences");
  assert.ok(Math.abs(second.narration.pace.wpm - 200) <= 4, `asked for 200 wpm, the take reads at ${second.narration.pace.wpm}`);
  assert.ok(measuredWpm(audio, second.artifact) > measuredWpm(audio, first.artifact) * 1.15,
    `the re-read is not audibly faster: ${measuredWpm(audio, first.artifact).toFixed(1)} then ${measuredWpm(audio, second.artifact).toFixed(1)} wpm`);

  // The claim that only the pace changed is measured: the earlier take's own settings are
  // re-rendered and must reproduce its bytes. If they cannot, the take is still an honest re-read
  // of the same words, and the record has to say why the stronger claim is not made.
  assert.equal(second.narration.repace.sameWords, true);
  assert.equal(second.narration.repace.onlyThePaceChanged, true,
    `only the pace should have changed; the record says ${JSON.stringify(second.narration.repace.notReproduced)}`);
  assert.equal(second.narration.repace.askedWpm, 200);
  assert.equal(second.narration.repace.from, first.artifact);

  // What it was asked for is a real instruction, not a copy of the previous one: a card whose
  // `asked for` line still read the old prompt would be the provenance lie versions exist for.
  assert.match(second.promptUsed, /re-read the same words at 200 words a minute/);

  // The new take has its own record beside it, so `voice/verify-take.mjs` can check it tomorrow.
  const takeNo = (second.artifact.match(/^versions\/v(\d+)-/) || [])[1];
  assert.ok(takeNo, `the re-read is published as one numbered take, got ${second.artifact}`);
  const timeline = join(workdir, String(audio), "versions", `${second.artifact.split("/").pop().replace(/\.wav$/i, "")}.timeline.json`);
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(timeline), `the re-read left no timeline of its own at ${timeline}`);
});

test("asking for the pace a take already has is not a new take", async () => {
  // An operator walked the canvas with a normal gesture: the box already showed 147, they pressed
  // Read again without editing it, and the card made and selected a second take (147.2 -> 147.0) -
  // no new intent, one more version, and two takes in the comparison panel nobody could tell apart.
  // The box shows whole words per minute, so a request for that integer is the no-op a press
  // without an edit produces. A rendered pace can land a rounding away from what was asked, so the
  // guard is on the number the person actually saw, not on the rendered value.
  const { audio, first } = await narratedCard();
  const shown = Math.round(first.narration.pace.wpm);
  const reply = await post("/api/repace", { id: audio, wpm: shown });
  assert.equal(reply.code ?? 200, 200, `a no-op pace was refused as an error: ${reply.error}`);
  assert.match(reply.notice || "", /already reads at/, `the card does not say why nothing happened: ${JSON.stringify(reply.notice)}`);
  // The reply settles the card on the take it already had, and it is still a settled card: a no-op
  // that left it `running`, or that published, would both be the defect this is written against.
  await new Promise(r => setTimeout(r, 500));
  const after = (await workspace()).nodes[audio];
  assert.equal(after.artifact, first.artifact, `a no-op pace replaced the take with ${after.artifact}`);
  assert.equal(after.status, "idle", `a no-op pace left the card ${after.status}`);
  assert.equal((after.versions || []).length, 0, "a no-op pace spent a version");
  assert.equal(after.narration.pace.wpm, first.narration.pace.wpm, "a no-op pace changed the measured pace");
});

test("a card that cannot be re-read says why instead of producing something else", async () => {
  // A tone card has no words to say, and was not made by this voice.
  const tone = latest(await post("/api/node", { x: 40, y: 400, type: "audio", method: "synth", prompt: "a low hum" }));
  const onTone = await post("/api/repace", { id: tone, wpm: 150 });
  // The refusal names both methods that *can* be re-read, because there are now two: an agent's
  // take and the server's own first read are the same kind of bytes once they exist, and a person
  // who read the README's "make a first film with no account" has the second kind.
  assert.match(onTone.error || "", /Only a card read out loud by this voice can be re-read/, `a tone card was not refused: ${JSON.stringify(onTone.error)}`);

  // A pace is a number, and zero is not one.
  const { audio } = await narratedCard();
  const zero = await post("/api/repace", { id: audio, wpm: 0 });
  assert.match(zero.error || "", /positive number of words per minute/, `a zero pace was not refused: ${JSON.stringify(zero.error)}`);

  // A pace the voice cannot reach is the renderer's refusal, in the renderer's words, and it
  // leaves the take that is on the card exactly where it was.
  const before = (await workspace()).nodes[audio];
  const fast = await post("/api/repace", { id: audio, wpm: 4000 });
  assert.equal(fast.code ?? 202, 202, "the impossible pace was accepted for rendering");
  const after = await settle(audio);
  assert.equal(after.status, "error", `an impossible pace should end as an error, got ${after.status}`);
  assert.match(after.error, /outside what this voice can do/, `the refusal does not name the limit: ${after.error}`);
  assert.match(after.error, /words per minute/, `the refusal does not name the pace the script reads at: ${after.error}`);
  assert.equal(after.artifact, before.artifact, "a refused pace replaced the take on the card");

  // A card with nothing published has no recorded words, and inventing them is not a re-read.
  const empty = latest(await post("/api/node", { x: 400, y: 400, type: "audio", method: "narration", prompt: "Read this." }));
  const onEmpty = await post("/api/repace", { id: empty, wpm: 150 });
  assert.match(onEmpty.error || "", /no published take yet/, `an empty card was not refused: ${JSON.stringify(onEmpty.error)}`);
});

test("Stop during a re-read keeps the approved take and cancels the run", async () => {
  // The window a person presses Stop in is the comparison render, which takes a second on a
  // longer script. A hold makes the window deterministic instead of racing it: it sits in the
  // last step before publishing and does nothing else.
  const holdPort = await freePort(), holdWorkdir = join(base, "hold-ws");
  const holding = startServer({ cwd: root, port: holdPort, env: {
    CODEX_BIN: bin, HYPERMAKER_WORKDIR: holdWorkdir, HYPERMAKER_RESET_WORKSPACE: "1",
    HYPERMAKER_PROJECT: root, HYPERMAKER_REPACE_HOLD_BEFORE_PUBLISH_MS: "4000",
  } });
  holding.stderr.on("data", chunk => process.stderr.write(chunk));
  try {
    await waitReady(holdPort);
    const call = (path, body) => fetch(`http://127.0.0.1:${holdPort}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
    const state = () => fetch(`http://127.0.0.1:${holdPort}/api/workspace`).then(r => r.json());
    const wait = async (id, ok, tries = 900) => {
      for (let i = 0; i < tries; i++) { const n = (await state()).nodes[id]; if (n && ok(n)) return n; await new Promise(r => setTimeout(r, 100)); }
      throw new Error(`node ${id} never reached the expected state`);
    };
    const text = latest(await call("/api/node", { x: 40, y: 40, type: "text", method: "llm", prompt: SCRIPT }));
    await call("/api/generate", { id: text, prompt: SCRIPT });
    await wait(text, n => n.status !== "running" && n.artifact);
    const audio = latest(await call("/api/node", { x: 400, y: 40, type: "audio", method: "narration", prompt: "Read this." }));
    await call("/api/link", { source: text, target: audio });
    await call("/api/generate", { id: audio, prompt: "Read this." });
    const approved = await wait(audio, n => n.status !== "running" && n.artifact);
    assert.ok(approved.artifact, `the first take did not publish: ${approved.error}`);

    const asked = await call("/api/repace", { id: audio, wpm: 200 });
    assert.equal(asked.error, undefined, `the re-read was refused: ${asked.error}`);
    // Let the render finish and the comparison begin, then stop inside the held window.
    await new Promise(r => setTimeout(r, 1500));
    const stopped = await call("/api/cancel", { id: audio });
    assert.equal(stopped.error, undefined, `Stop was refused: ${stopped.error}`);

    const final = await wait(audio, n => n.status !== "running" && n.artifact);
    // The two things the operator's receipt disagreed about: it said the user stopped, and it
    // published a new take anyway. Both halves are checked, and so is the card settling.
    assert.equal(final.artifact, approved.artifact, `a stopped re-read replaced the approved take with ${final.artifact}`);
    assert.equal(final.status, "cancelled", `a stopped re-read ended as ${final.status}`);
    assert.match(final.error, /stopped/i, `the card does not say the run was stopped: ${final.error}`);
    assert.equal((final.versions || []).length, 0, "a stopped re-read kept a version of the take it never published");
  } finally { stopServer(holding); }
});
