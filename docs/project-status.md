# Project status

## Classification

`useful`, local-canvas milestone: a runnable, inspectable local application for
composing generated artifacts, with one real Codex run taken as evidence.

## Status

Canvas and generation lifecycle re-verified 2026-11-27 on `fix/canvas-usable`.
The last upstream commit planned work; this milestone closed the gap between the
canvas being reachable and the canvas being usable, and then checked the one path
a local fixture cannot stand in for: a real Codex CLI run.

No further development is planned. The sections below say what that claim rests
on, so the next person can decide whether to reopen it.

## What is real and what is simulated

The distinction matters because a first-time reader reasonably assumes "tests
pass" means "generation works". Both are true, but for different reasons.

| Path | Exercised by | Simulated part | Real part |
| --- | --- | --- | --- |
| Text artifact | `test/e2e.test.mjs`, one real run | the agent's words | CLI spawn, prompt assembly, node directory, artifact validation, canvas preview |
| Image (PNG) | `test/media.test.mjs` | the agent's creative choice | Remotion bundling and `renderStill`, a real PNG, the decoded `<img>` |
| Video (MP4) | `test/media.test.mjs` | two-frame composition, codec choice | Remotion `renderMedia` with h264, a real `ftyp`/`avc1`/`moov` file, the decoded `<video>` |
| Run lifecycle (Stop, failure, restart) | `test/lifecycle.test.mjs`, `test/stop-ui.test.mjs`, real-CLI checks | the agent's slowness and exit codes | process-group Stop, persisted outcome, the card's visible reason |
| Test isolation | `test/server.mjs` | — | OS-assigned ports and process-group teardown, so a crashed fixture cannot answer a later test |
| Text via **real Codex CLI** | 2026-11-27, this machine | nothing | one `codex exec` run: wrote and ran `generate.mjs`, produced a `.txt` artifact, 37 s, 48k input tokens |
| Audio (`tts.cpp`, `bark.cpp`) | — | everything | nothing: no run has been taken as evidence |
| `hyperframe` image/video | — | everything | nothing beyond the method guidance being passed to the agent |
| Quality presets | — | — | passed as guidance only; never measured against a real model |

The real run used `codex-cli 0.172.0` with ChatGPT authentication and the
adapter's own flags (`exec --json --output-last-message … --sandbox
danger-full-access --skip-git-repo-check --ephemeral`). It is evidence that the
adapter, the prompt and the artifact contract work against the real binary. It
is **not** evidence about output quality, and one run is one run.

## What a first run is like

1. `npm install && npm run dev`, open <http://127.0.0.1:8787>, double-click the
   canvas, write a prompt, press **Generate**.
2. The card shows `running` while the agent works; **Generate** becomes
   *Generating…* and **Stop** appears. Stop kills the agent's whole process
   group, and the card reports `cancelled` while keeping the previous artifact.
3. On success the card shows the artifact and its filename; the node directory
   holds the prompt, the script, the artifact, `codex.jsonl` and `AGENTS.md`.
4. On failure the card shows the reason, including the CLI's own last error, or
   a plain instruction when the CLI is not installed at all. The reason is
   stored in `workspace.yml`, so reopening the page — or restarting the server —
   does not turn a failure into a quiet draft.
5. Closing the server mid-run marks that run as interrupted rather than letting
   it reappear as something that never started.

Two honest gaps a first-time user will meet:

- `vendor/` is a submodule pair. Without `--recurse-submodules` the
  `.agents/skills` symlinks dangle, so the agent loses the Remotion and
  HyperFrames skill knowledge. The canvas still works; media quality suffers.
- The default model id in the header (`gpt-5.6-luna`) is what this machine's
  account accepts. A different account may need a different id, and the app
  will say so on the card rather than fail silently.

## Evidence

- Product source of truth: [`design.md`](design.md).
- Implementation source of truth: [`impl.md`](impl.md).
- `npm test`: 30 cases — 3 registry/prompt, 5 workspace round trips, 3 canvas
  script checks, 8 browser canvas cases, 2 media renders, 7 lifecycle cases, and
  2 Stop/failure UI cases. Without a browser it is 18 pass + 12 skip + 0 fail;
  every skipped case says which browser it looked for.
- `node test/journey.mjs`: walks the ordinary path once — create, overlap, raise,
  move, link, unlink, generate, Stop, regenerate, reopen, delete — and
  screenshots each step into `.tmp/journey/`, printing the facts as JSON.
- Real-CLI checks live under `.tmp/` (gitignored) because they need a logged-in
- Fixture servers use `test/server.mjs`: an OS-assigned port and process-group
  teardown. This was not cosmetic — a server left on a fixed port by an interrupted
  run answered a later "negative control", which then looked green while testing
  nothing. For a related reason the first version of the Stop check also passed
  vacuously: it cancelled before the agent had started, so no orphan could exist.
  It now waits for the agent to actually be running.
  teardown. This was not cosmetic — a server left on a fixed port by an interrupted
  run answered a later "negative control", which then looked green while testing
  nothing. Two of the lifecycle checks below were caught this way.

## Boundaries

Local-first. One workspace at a time. It depends on an authenticated Codex CLI
for real generation and makes no claim about hosted collaboration, multi-user
access, or production reliability. `workspace.yml` is the only graph
persistence; z-order, undo and multi-select are canvas state, not stored.

## Deferred

No benchmark results, project video, or paper were produced; these remain out of
scope. Generated video *output* is a product feature and is covered by a
real-render test — see [impl.md](impl.md). Audio, `hyperframe`, and the quality
presets remain unverified (table above), and are the natural next evidence to
collect, not new features to add.

## Versioning

The current version is `0.1.0` in [`VERSION`](../VERSION). Update it with the
changelog when a release changes the user-visible contract.
