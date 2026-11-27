import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Which agent the film story runs, and whether it can be mistaken for the other one.
//
// The failure this is written against was reported by a supervisor against the delivery that
// first documented a real-model command: `test/film-story.mjs` always built its own stand-in
// binary and passed it as `CODEX_BIN`, so `CODEX_BIN=/path/to/codex node test/film-story.mjs`
// ran the fixture, produced three films, exited 0 - and never called the real CLI. A probe that
// records calls and exits immediately was called zero times while the story reported success.
// A receipt like that is worse than a missing one: it looks like evidence.
//
// So the choice is explicit (`--agent stand-in` / `--agent real`), the run is refused when the
// two are mixed up, and the receipt records which one it was. These checks run the real entry
// point with a probe binary and assert on what it printed and whether the probe was reached -
// they never start a server, because every refusal happens before one exists.
const root = process.cwd();
const story = join(root, "test", "film-story.mjs");

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [story, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
    // HYPERMAKER_CHROME is deliberately absent: a refusal must not depend on a browser, and a
    // run that got as far as needing one did not refuse.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

test("the story refuses to pretend a real model ran when it did not", () => {
  // 1. Real, with nothing to run.
  const missing = run(["--agent", "real"], { CODEX_BIN: "" });
  assert.notEqual(missing.status, 0, "`--agent real` with no CODEX_BIN exited successfully");
  assert.match(missing.out, /--agent real needs CODEX_BIN/, `the refusal does not say what is missing: ${missing.out}`);
  assert.match(missing.out, /no stand-in was substituted/, "the refusal does not say a stand-in was not used instead");

  // 2. Real, pointed at this repository's own stand-in: the receipt would lie.
  const fake = run(["--agent", "real"], { CODEX_BIN: join(root, "test", "film-story-agent.mjs") });
  assert.notEqual(fake.status, 0, "`--agent real` pointed at the stand-in exited successfully");
  assert.match(fake.out, /which is this repository's stand-in/, `the refusal does not name the problem: ${fake.out}`);

  // 3. `--agent` with nothing after it. This used to be indistinguishable from no flag at all,
  //    so it ran the stand-in - the one outcome a person writing `--agent` was not asking for.
  //    Absent and present-but-empty are different questions, and the second is a usage error.
  const bare = run(["--agent"]);
  assert.notEqual(bare.status, 0, "a bare `--agent` exited successfully");
  assert.match(bare.out, /--agent needs a value/, `a bare --agent did not say it needs a value: ${bare.out}`);
  assert.match(bare.out, /Nothing was started/, "the refusal does not say nothing started");

  // 3b. The same when another flag follows: `--agent --verbose` must not read `--verbose` as
  //     the agent, and must not fall through to the default either.
  const swallowed = run(["--agent", "--verbose"]);
  assert.notEqual(swallowed.status, 0, "`--agent --verbose` exited successfully");
  assert.match(swallowed.out, /--agent needs a value|must be stand-in or real/, `a flag after --agent was not refused: ${swallowed.out}`);

  // 4. A misspelling must not fall back to either.
  const bogus = run(["--agent", "reel"]);
  assert.notEqual(bogus.status, 0, "an unknown --agent value exited successfully");
  assert.match(bogus.out, /must be stand-in or real/, `the refusal does not list the choices: ${bogus.out}`);

  // None of the three got far enough to need a browser, which is the cheap proof that they
  // refused at the entry point rather than halfway through a run.
  for (const [name, result] of Object.entries({ missing, fake, bogus, bare, swallowed })) {
    assert.doesNotMatch(result.out, /HYPERMAKER_CHROME/, `${name} reached the browser step before refusing`);
  }
});

test("a CODEX_BIN that is set but unused is reported rather than ignored", () => {
  // The supervisor's exact situation: CODEX_BIN exported, no --agent flag. This is allowed -
  // the default is the stand-in - but it must say so, because the person exported it for a
  // reason. The run then stops at the browser check, which is where this test wants it.
  const warned = run([], { CODEX_BIN: "/nonexistent/probe-codex" });
  assert.match(warned.out, /is set but ignored, because this run uses the stand-in agent/,
    `an ignored CODEX_BIN was not reported: ${warned.out}`);
  assert.match(warned.out, /Pass --agent real to use it/, "the note does not say how to use it");
});

test("the receipt records which agent ran, and the entry point documents both", () => {
  const source = readFileSync(story, "utf8");
  // The receipt has to carry the answer, or the next reader is back to guessing.
  assert.match(source, /const out = \{ agent, codexBin/, "the receipt does not record the agent");
  assert.match(source, /out\.invocations =/, "the receipt does not count what the agent actually did");
  // And the unsafe default is spelt out in the command a person copies.
  assert.match(source, /node test\/film-story\.mjs\s+# stand-in|node test\/film-story\.mjs {2,}/,
    "the usage block does not mark the no-flag form as the stand-in");
  assert.match(source, /--agent real/, "the usage block does not show the real form");
});
