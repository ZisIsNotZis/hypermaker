// Re-read a narration that already exists at a different pace.
//
// WHY THIS IS NOT A GENERATE PRESS. A pace is a mechanical property of a recording: the same
// words, the same voice, the same reading table, spoken at a different number of words per
// minute. Until now the only way to change it was to press Generate again and hope the agent
// passed `--wpm`, which costs a model turn, cannot be checked before it lands, and re-decides
// the script and the voice along with the speed. A writer who has approved a take and only
// wants it slower should not have to re-open any of those decisions - and on a machine where
// the model route is unreachable (see `docs/evidence/`), pressing Generate is not even an
// option.
//
// So this path has no agent in it at all. It reads the words out of the take's OWN record (the
// published `timeline.json`, which is what the bytes were verified against when they were
// made), renders them again with `voice/render.mjs`, and publishes only after the same check
// that would have refused a bad agent take has passed. Nothing here is a second implementation
// of the voice: the tool is invoked, not reimplemented, and the server verifies its output with
// `verifyNarration` exactly as it does for an agent.
//
// WHAT IT REFUSES TO DO, and why each refusal is a sentence rather than a guess:
//   * a card with no published take, or a take with no timeline, has no recorded script - the
//     words would have to be invented, and a re-read is only honest if it says the same words;
//   * a card whose method is not `narration` was made by something other than this voice, so
//     "the same recording, slower" is not a thing that exists for it;
//   * a pace the voice cannot reach is refused by the renderer, which names the limit and the
//     pace the script actually reads at; that sentence is passed through instead of clamping.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// Where a published take's own record lives. Publishing names it after the artifact it
// describes (`v2-narration.wav` -> `v2-narration.timeline.json`), which is how a person finds
// it by hand and how `voice/verify-take.mjs` finds it too.
export function timelinePathFor(cardDir, artifact) {
  if (!artifact) return null;
  const name = basename(String(artifact)).replace(/\.wav$/i, "");
  return join(cardDir, "versions", `${name}.timeline.json`);
}

// The words a take said, and the settings its bytes were made with. Read from the published
// timeline, never from the card's prompt or from today's build: the point is to say the same
// thing again, not to re-decide what was said.
export function readTake({ cardDir, artifact }) {
  const problems = [];
  const file = artifact ? join(cardDir, String(artifact)) : null;
  if (!artifact) problems.push("this card has no published take yet, so there are no words to read again");
  else if (!existsSync(file)) problems.push(`the take on the card (${artifact}) is not a file in its own directory, so its words cannot be read back`);
  const timelinePath = timelinePathFor(cardDir, artifact);
  let timeline = null;
  if (!timelinePath || !existsSync(timelinePath)) {
    // A take published by an older build can be older than the copy of its timeline. Saying so
    // is the difference between "re-read the card" and "this build cannot re-read this take".
    problems.push(`no recorded timeline beside ${artifact || "the take"}, so nothing says which words these bytes say; make one new take with Generate and this card can be re-read from then on`);
  } else {
    try { timeline = JSON.parse(readFileSync(timelinePath, "utf8")); }
    catch (error) { problems.push(`the timeline beside ${artifact} could not be read (${error.message})`); }
  }
  const phrases = Array.isArray(timeline?.phrases) ? timeline.phrases : [];
  const words = phrases.map(p => String(p?.text || "").trim()).filter(Boolean);
  if (timeline && !words.length) problems.push(`the timeline beside ${artifact} lists no phrases, so there is no script to speak`);
  const wpm = Number(timeline?.pace?.wpm);
  return {
    problems,
    script: words.join("\n"),
    phrases: words,
    wpm: Number.isFinite(wpm) ? wpm : null,
    // A take published before `voice` was recorded has settings this build cannot name. That is
    // not a refusal - the words are still the words - but it is why the stronger "only the pace
    // changed" check may come back false, and the caller says so rather than pretending.
    voice: timeline?.voice && typeof timeline.voice === "object" ? timeline.voice : null,
    timeline,
    timelinePath,
  };
}

// One child process, cancellable, because a person may press Stop while it renders. The
// renderer's own last useful sentence is what a refusal carries: `¥ is a currency this voice
// does not name` and `2000 words per minute is outside what this voice can do for this script`
// are actionable, and `Command failed` is not.
// A Stop is not a failure of the thing being measured, and the difference matters here in a way
// it does not for ordinary errors: this module probes the previous take to ask "can its own
// settings still reproduce it?", and the honest answer to that question when the user pressed
// Stop is *no answer*, not "no". An earlier version caught every rejection from that probe -
// including the one raised by the kill - and turned it into `same: false`, so a stopped re-read
// went on to publish a new take while the receipt said the user had stopped it. Typing the stop
// as its own error is what lets the caller refuse to publish instead of reasoning about it.
class StoppedError extends Error {
  constructor(message = "Re-read stopped by the user") { super(message); this.stopped = true; this.name = "StoppedError"; }
}
export const stopped = (message) => new StoppedError(message);
export const isStopped = error => error instanceof StoppedError || error?.stopped === true;

function render(args, cancelRef) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    cancelRef.child = child;
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("error", error => fail(error));
    child.on("close", (code, signal) => {
      cancelRef.child = null;
      if (cancelRef.stopped) return fail(stopped());
      if (code === 0) return done({ stdout, stderr });
      const lines = stderr.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const useful = lines.find(l => /outside what this voice can do|no way to say|is a (currency|fraction|mathematical|unit)|does not verify/.test(l))
        ?? lines.find(l => !/^\s*at |^node:internal|^\^+$/.test(l))
        ?? `the renderer exited with code ${code}${signal ? ` (${signal})` : ""}`;
      fail(new Error(useful));
    });
  });
}

// Render the recorded words at a pace, into the run directory the caller created, and parse
// back what was written. The renderer is the only thing that decides whether a pace is
// reachable: it measures the script and refuses a multiplier outside what the voice can do.
export async function renderAt({ projectRoot, scriptFile, outDir, wpm, voice = null, cancelRef = {} }) {
  const out = join(outDir, "narration.wav"), timeline = join(outDir, "timeline.json");
  const args = [join(projectRoot, "voice", "render.mjs"), "--file", scriptFile, "--out", out, "--timeline", timeline, "--wpm", String(wpm)];
  // The mouth travels with the pace, for the same reason the reading table does and more strongly:
  // re-reading a take that an engine spoke with the built-in voice would be a different recording
  // of the same words, and the card would say "only the pace changed" about a take where the voice
  // did too. `pitch` is on the engine's 0-99 scale here and on hertz for the built-in voice, which
  // is why the engine is named before the pitch is passed.
  if (voice?.engine) args.push("--engine", String(voice.engine));
  if (voice?.engineVersion != null) args.push("--engine-version", String(voice.engineVersion));
  if (voice?.engineVoice != null) args.push("--engine-voice", String(voice.engineVoice));
  if (voice?.pitch != null) args.push("--pitch", String(voice.pitch));
  // The reading table travels with the pace. Re-reading with today's table would change which
  // syllables are stressed, which is a different take wearing the same pace - exactly the
  // confusion the versioned reading table exists to prevent.
  if (voice?.readings != null) args.push("--readings", String(voice.readings));
  await render(args, cancelRef);
  if (!existsSync(out) || !existsSync(timeline)) throw new Error("the renderer reported success but wrote no take");
  return { artifact: out, timeline: JSON.parse(readFileSync(timeline, "utf8")), timelinePath: timeline };
}

// Was the previous take made by exactly these words at exactly the settings its record names?
// If yes, the new take differs from it in the pace alone, and that is worth stating on the
// card: it is the difference between "I asked for a re-read" and "I got a different recording".
// When it cannot be reproduced - an older table, a record that predates `voice` - the answer is
// `same: false` with the reason, never an assumption.
export async function reproducesPrevious({ projectRoot, scriptFile, previousFile, timeline, scratch, cancelRef = {} }) {
  if (!previousFile || !existsSync(previousFile)) return { same: false, why: "there is no earlier take to compare with" };
  if (!timeline?.voice || (timeline.voice.rate == null && !timeline.voice.engine)) return { same: false, why: "the earlier take records no voice settings to reproduce it with" };
  const out = join(scratch, "previous.wav");
  // An engine take is reproduced by its engine's own settings - `--speed`, not `--rate`: the engine
  // was never given a duration multiplier, and passing rate 1 would produce the engine's default
  // speed, which is a different recording from the one on the card.
  const engine = timeline.voice.engine ? ["--engine", String(timeline.voice.engine), "--speed", String(timeline.voice.speed ?? "")] : ["--rate", String(timeline.voice.rate)];
  if (timeline.voice.engineVersion != null && timeline.voice.engine) engine.push("--engine-version", String(timeline.voice.engineVersion));
  if (timeline.voice.engineVoice != null && timeline.voice.engine) engine.push("--engine-voice", String(timeline.voice.engineVoice));
  const args = [join(projectRoot, "voice", "render.mjs"), "--file", scriptFile, "--out", out, ...engine];
  if (timeline.voice.pitch != null) args.push("--pitch", String(timeline.voice.pitch));
  if (timeline.voice.readings != null) args.push("--readings", String(timeline.voice.readings));
  try { await render(args, cancelRef); }
  catch (error) {
    // A stop while this probe runs is not evidence about the earlier take. Rethrowing it is the
    // whole point: the caller has to abandon the re-read, not publish one on top of a take the
    // user was in the middle of keeping.
    if (isStopped(error)) throw error;
    return { same: false, why: `the earlier take's own settings no longer render: ${error.message}` };
  }
  if (!existsSync(out)) return { same: false, why: "re-rendering at the earlier take's settings wrote nothing" };
  return readFileSync(out).equals(readFileSync(previousFile))
    ? { same: true }
    : { same: false, why: "re-rendering at the earlier take's own settings did not reproduce its bytes" };
}

// The script goes into the run directory so the new take has its own `script.txt` beside it,
// published under its own number exactly like an agent take. A re-read that left no record of
// the words would be the one take nobody could check tomorrow.
export function writeScript(dir, script) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "script.txt");
  writeFileSync(file, `${script}\n`, "utf8");
  return file;
}
