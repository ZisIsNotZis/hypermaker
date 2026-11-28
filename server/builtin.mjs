// A generate run whose bytes are made by the server instead of by an agent.
//
// It exists in this shape - a promise carrying `cancel()`, exactly like `server/codex.mjs`'s - so
// that `/api/generate` does not need a second lifecycle. The claim at the press, the frozen
// material, the guard over the card, the success branch with its checks and its publish, and the
// failure branch that keeps the previous take are all written once and serve both. A builtin run
// that had its own endpoint would have its own version of each of those, and the two would drift.
//
// What a run produces is the same three things an agent produces: an artifact path, the script
// beside it, and - for a film - numbers that describe what was measured. The caller checks those
// claims before publishing; nothing here publishes.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { firstCut, readAloud, scriptFor, titleCard, StoppedError } from "./offline.mjs";

// The pace a card is asking for, or null for the voice's own ordinary speed.
//
// `n.wpm` is the box on the card, which now exists before the first take as well as after one, so
// the number a person typed is the number the first read uses. It is validated here rather than
// trusted: a NaN or a negative would reach the renderer, and the renderer's refusal would be about
// a command line instead of about a pace.
export function paceAsked(wpm) {
  if (wpm == null || wpm === "") return null;
  const number = Number(wpm);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`A pace is a positive number of words per minute, got ${JSON.stringify(wpm)}. Nothing was rendered.`);
  return number;
}

// `kind` is the method's own `builtin` name, so the registry decides what runs and this file does
// not carry a second list of method ids that could disagree with it.
export function runBuiltin({ kind, node, sources, prompt, attemptDir, projectRoot, wpm = null, assembledPrompt = null }) {
  const cancelRef = { stopped: false, child: null, cancelRenderer: null };
  const promise = (async () => {
    // The prompt is part of what the card was asked, so it is written where the agent path writes
    // it: next to the run, and copied onto the card when the take is published.
    if (assembledPrompt != null) writeFileSync(join(attemptDir, "prompt.txt"), assembledPrompt, "utf8");
    if (kind === "plain") {
      // The words as typed. A card with an empty box has nothing to write, and writing an empty
      // file would publish a take that says nothing - which is a card whose narration then has
      // nothing to read and whose film has no title. The refusal is at the press instead.
      const words = String(prompt || "").trim();
      if (!words) throw new Error("This card has no words yet: type the sentence you want kept, then press Generate. Nothing was written.");
      const file = join(attemptDir, "text.txt");
      writeFileSync(file, `${words}\n`, "utf8");
      return { artifact: file, script: null };
    }
    if (kind === "readaloud") {
      const { script, from } = scriptFor({ sources, prompt });
      const take = await readAloud({ projectRoot, attemptDir, script, wpm: paceAsked(wpm), cancelRef });
      return { artifact: take.artifact, script: take.script, timeline: take.timeline, scriptWords: script, from };
    }
    if (kind === "titlecard") {
      // One picture from this card's words, rendered by the server. Its size is the frame the film
      // will show it in, so a scene is not a letterboxed mistake.
      const picture = await titleCard({ attemptDir, sources, prompt, cancelRef });
      return { artifact: picture.artifact, script: picture.script, picture: { width: picture.width, height: picture.height, title: picture.title } };
    }
    if (kind === "firstcut") {
      const film = await firstCut({ attemptDir, sources, cancelRef });
      return {
        artifact: film.artifact,
        script: film.script,
        // The cut's own plan, handed to the check and to the card unchanged. The check measures the
        // film against *this*, so there is one answer in the program to "when is scene 2 on
        // screen" rather than a plan here and a re-derived one there.
        scenes: film.scenes,
        // THE CUT'S OWN FACTS, AT THE TOP LEVEL. These were first nested inside `film`, which is
        // where the card reads them from - but the checks in `index.mjs` read `result.placements` and
        // `result.cues`, and a nested field is `undefined` there. The effect was invisible to any
        // probe that called `firstCut` directly and fatal through the canvas: a scene's picture was
        // compared with a re-derived placement (wrong for a panorama, scored -0.391) and the caption
        // gate was skipped entirely because it was handed no cues. Every check gets the same values
        // the cut used, from one place.
        placements: film.placements,
        cues: film.cues,
        film: {
          seconds: Number(film.seconds.toFixed(2)),
          frames: film.frames,
          fps: 30,
          width: 1280,
          height: 720,
          // The first line of the linked text, which is also what is written on the film. On the
          // card it is how a person says "this is the film of that sentence" without opening it.
          title: film.title || null,
          // Which narration this is a film of, by card and by the file it froze: two takes of one
          // narration card are told apart here, and nowhere else on the film's own record.
          soundtrack: film.soundtrack ? { id: film.soundtrack.id, artifact: film.soundtrack.artifact, file: film.soundtrack.file ?? null } : null,
          poster: film.poster ? { id: film.poster.id, artifact: film.poster.artifact, file: film.poster.file ?? null } : null,
          // What the words under each scene measured: one cue per spoken phrase, how long it is on
          // screen, and how fast it has to be read. A film whose caption is on screen for eight
          // seconds is true but not necessarily followable, and "characters per second" is the
          // number that says which - it is measured from the cue's own frames, not estimated.
          // What each scene keeps of its picture, and a sentence when something is cropped. A person
          // who brought in a portrait deserves to know before the film is a surprise - the report
          // was "I could not foresee what the film would keep", so the answer travels with the take.
          placements: Array.isArray(film.placements) ? film.placements.map((p, i) => p ? {
            scene: i,
            source: p.source,
            fit: p.fit,
            kept: Number(p.kept.toFixed(3)),
            ...(p.notice ? { notice: p.notice } : {}),
          } : null) : null,
          cropped: (film.placements || []).some(p => p && p.kept < 0.995),
          captions: film.cues.length ? {
            cues: film.cues.map(({ scene, seconds, charactersPerSecond }) => ({ scene, seconds, charactersPerSecond })),
            worst: Math.max(...film.cues.map(c => c.charactersPerSecond)),
            // Stated with the number rather than left to the reader: the threshold above which text
            // is hard to follow at speed. A card that printed a bare number would make a person
            // guess whether 21 is good.
            comfortable: 20
          } : null
        }
      };
    }
    throw new Error(`Unknown built-in method ${JSON.stringify(kind)}; nothing was started.`);
  })().catch(error => {
    // A stop that arrives after the work already finished is not a failure of the work, and a
    // stop that arrives during it is not a failed render. Either way the answer is a stop.
    if (cancelRef.stopped && !(error instanceof StoppedError)) throw new StoppedError();
    throw error;
  });
  promise.cancel = () => {
    if (cancelRef.stopped) return false;
    cancelRef.stopped = true;
    // The renderer child and the Remotion renderer are different things, and only one of them is
    // a process group: both are told, so a film cannot keep encoding behind a stopped card.
    try { cancelRef.cancelRenderer?.(); } catch {}
    if (cancelRef.child) {
      try { process.kill(-cancelRef.child.pid, "SIGTERM"); } catch { try { cancelRef.child.kill("SIGTERM"); } catch {} }
    }
    return true;
  };
  return promise;
}
