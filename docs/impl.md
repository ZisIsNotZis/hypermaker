# HyperMaker Implementation Plan

Implementation source of truth. Product behavior belongs in `design.md`.

## Architecture

Small local Node HTTP server, static browser canvas, filesystem workspace, filesystem registry, and Codex CLI adapter. One in-memory active workspace mirrors `workspace.yml`. HTTP handles commands; SSE sends completion/error notifications. Raw Codex output goes to node `codex.jsonl` and `dev.log`; application does not parse trajectory.

## Workspace

`workspace.mjs` owns YAML-compatible serialization, parsing, atomic writes, integer IDs, and node-local path validation. Server loads active workspace and saves after graph mutations and generation start/end. Draft nodes remain memory-only until Generate. No old-manifest compatibility layer.

A node's `status` and `error` are persisted fields, not view state. The last run's outcome is what a person looks for when they reopen the app, so a failure or a Stop has to be on disk: an in-memory-only error made a failed run reappear as a quiet draft after a restart. A run still marked `running` when the workspace is loaded was cut off, and `adopt()` rewrites it as an error before the canvas can show it.

## Registry and prompts

Load type, method, and quality registry at startup. MIME/extensions drive type detection and UI options. Fixed prompt guidance lives in text files under `prompts/`; dynamic sections assemble current node and direct inputs. Preserve section order and user prompt. Do not inject skill names; repository-root cwd lets Codex discover them.

## Codex

Spawn one process per node with repository-root cwd, node directory context, model/effort, optional `gh/` prefix, and closed stdin. Pass `--json` for trajectory and `--output-last-message` for final result. Tee stdout/stderr unchanged to node `codex.jsonl` and timestamped `dev.log` plus terminal. Ignore trajectory for application logic; parse only final output file. Require artifact, allow optional script, enforce node-local paths, ensure type and `AGENTS.md`, then save workspace and emit completion. Runs never block HTTP or other nodes.

Each run is spawned `detached`, so it leads its own process group: an agent spawns shells and renderers, and Stop must end all of them. `generate()` returns a promise carrying `cancel()`, which signals the group with SIGTERM and escalates to SIGKILL after 3 s; a test whose agent leaves a continuously-writing grandchild is what catches a child-only kill. The real CLI reports why a turn failed as JSON events, so a non-zero exit quotes its last `error`/`turn.failed` message; a missing binary (ENOENT) becomes an instruction naming `CODEX_BIN` instead of a bare errno.

One run per node is enforced in the server, not the UI. `running` maps node id to the agent promise; a second Generate returns 409 rather than spawning a second process into the same node directory. A successful run replaces `artifact`/`script`; a failed or stopped run leaves the previous artifact in place and records `status` + `error`. SIGINT/SIGTERM cancel live agents so no renderer outlives the server.

## HTTP and UI

Provide workspace open/read/save, node create, import, link/unlink, clone/delete, layout, file serving, asynchronous generation, and cancel. The card shows *Generating…* with a Stop button while a run is live; Stop is hidden otherwise. The stored error renders on the card both when it happens and on a fresh page load — a card built by `shell()` used to skip it, so a failure was visible only until the page was reopened. UI is compact canvas: pointer drag/link/pan, drag-end workspace persistence, 4:3 artifact preview, visible SVG marker arrows with hit paths, control-only wheel suppression, wrapped text, native media viewers, download/image popup, and preview errors. Card raising must not move a card during pointerdown on an interactive control. Delete control executes on click after confirmation.

Canvas implementation invariants (each has a regression test; two were once live bugs):

- Cards are stable DOM nodes keyed by `data-id` and updated in place by `sync()`; `render()` never rebuilds a card, so raising, focus and half-typed text survive API and SSE refreshes.
- Raise order is one `order` map plus a monotonic counter, applied as `z-index` by `paintOrder()`. The top card is marked `raised`. Order is client-side and deliberately not persisted.
- One module-level drag record owned by `beginDrag`/`dragTo`/`endDrag`, with a single window `pointermove`/`pointerup`/`pointercancel` listener. Per-card closures plus per-card window listeners let a finished drag keep following the pointer, and moved several cards at once.
- Only the primary button starts a drag or a pan. A right-click must reach the link hit path so it can unlink.
- `setView()` applies `translate(ox,oy) scale(scale)` to `#world`; pan and zoom both call it. It was called but never defined, so pan and zoom threw and the canvas silently never moved.
- A card being dragged carries `.dragging` with `pointer-events:none`, and the drop hit test runs *before* that class is removed. Clearing it first made every drop miss: the dragged card sits under the cursor, so it is always the topmost element and never the card being dropped onto.
- Links are one SVG per canvas, addressed in world coordinates inside `#world`, so pan/zoom/drag keep them on the card edges. `.edge` ignores pointer events; the 20 px `.edge-hit` stroke receives the context menu.
- `.cards` is `pointer-events:none` and each card opts back in, so empty canvas and link hit paths receive events.
- `safe()` takes a function; callers pass `safe(() => promise)`, never a promise. `changeField` resolves the method list first, then patches.
- Prompt saves are debounced, on blur, and flushed before Generate; `sync()` skips the textarea while it is focused.

## Media

`types/audio/methods/synth.mjs` exists because the two speech methods name binaries under `~/tts.cpp` and `~/bark.cpp`; when those are absent an audio card had no usable method at all. `synth` asks the agent to synthesize PCM in Node and write the RIFF header itself, so it needs nothing installed, and its guide says plainly that it makes tones and rhythm, not words. It is not a replacement for `tts.cpp`/`bark.cpp`, and the docs never present it as speech.

The file endpoint had two defects with one cause. It sent no `content-length` and ignored `Range`, so a media element could not learn a length or seek: Chromium reported `duration: null` for a real WAV, while an MP4 survived on its own `moov` box and looked healthy. The failure was also size-dependent — a 176 KB clip still reported a duration, a 352 KB one did not — so a short test fixture proves nothing. `sendFile` now sends a length, advertises `accept-ranges: bytes`, and answers a range request with `206`, a `content-range`, and exactly that slice (or `416` when unsatisfiable). `test/audio.test.mjs` uses a six-second clip for that reason, and fails with `Infinity` as the duration when the endpoint regresses.

## A film from canvas material

Video has its own method guide rather than re-exporting the image one, because a video card
is the only card that can be handed audio. A real run showed the cost of staying quiet about
it: the agent rendered an MP4 whose container carried a valid AAC track of pure digital
silence (`peak 0` on every sample). Every cheap check passed - MP4 container, audio stream
present, canvas plays it - and the result was a silent film. The guide now states how to mix
an input file (`publicDir` in `bundle()`, `<Audio src={staticFile(...)}/>`), requires the
picture to last as long as the sound, and requires the agent to extract the rendered track
and confirm its samples are not all zero before reporting success.

A later real run of the same shape produced **4.05 s of audible audio at peak 30496** inside a
720x404 h264 MP4, so the contract is reachable, not merely stated.

`prompt.txt` is written **before** the child is spawned. A child can be running before the
next line of the parent executes, and a run's own type and id are therefore also passed in
the environment (`HYPERMAKER_NODE_TYPE`, `HYPERMAKER_NODE_ID`) rather than re-derived by
reading that file; reading it early made a test pick the wrong fixture intermittently.

## Provenance of an artifact

A node's `sources` records what a finished artifact was built from: `{id, type, artifact}`
per input, persisted in `workspace.yml` and shown on the card as `made from #1 image
poster.png - #3 audio tone.wav`. The rules, each with a regression test that was checked by
breaking the behaviour:

- **Frozen at start.** The set is captured when the run is launched, not read again when it
  finishes. A film takes minutes; a person may rewire the canvas while watching it, and
  reading the links at completion labelled the film with materials it never saw.
- **Links are the person's.** A link added during a run is not undone when that run
  finishes: it is preparation for the next run. Only `sources` describes the finished file.
- **A failed or stopped re-run changes nothing about provenance.** The previous artifact is
  still the one on the card, so it keeps the sources it was made with.
- **Identification comes from the map key.** A node loaded from `workspace.yml` carries no
  `id` field of its own, so reading `s.id` wrote `null` for every source of a workspace read
  back from disk - which is the ordinary case after a restart. The label read `made from
  #null image`.

## Verification

TDD seams: workspace round trip/atomic write/path safety; registry; prompt order/direct input metadata; node/import/link persistence; async result validation/concurrency/failure; UI creation, scrolling, drag-link, unlink, persistence, controls, preview/download. Run `npm test`, `npm run test:e2e`, `node --check`, and `git diff --check`. `npm test` is 36 cases with a browser: registry/prompt/workspace checks, three canvas-script checks, eight canvas browser cases, two media renders, one audio render, one film built from canvas material, three provenance cases, seven lifecycle cases, and two Stop/failure UI cases. Browser tests launch Chromium through `test/browser.mjs`, honoring `HYPERMAKER_CHROME` or `CHROME_BIN` when Playwright's own browser is not installed. Every browser test asserts that the page raised no error, and the assertions are collected rather than thrown from the event listener, because a throw there surfaces after the test has ended.

If `/tmp` is small or full, point the fixtures somewhere roomy (`TMPDIR=/var/tmp/x npm test`). Remotion writes real video next to its workspace, and a full scratch disk fails the media cases with `ENOSPC` — which looks like a code failure but is not. A directory on a Windows drive is not a substitute: Chromium cannot create its profile there.

`test/media.test.mjs` is the suite whose fixture renders rather than pretends: `test/fake-remotion-codex.mjs` bundles the composition with `@remotion/bundler`, selects it, and calls `renderStill` or `renderMedia`, then the test asserts the artifact's own bytes and the preview the canvas draws. For the image case that is the PNG signature plus a loaded `<img>` at 320x180; for the video case it is an ISO base media `ftyp` box with an h264 (`avc1`) track and a `moov` box, plus a `<video>` the browser actually decodes (`readyState >= 1`, `videoWidth` 320, non-zero duration). The two cases run against separate servers on separate ports, so the still and video fixtures cannot borrow each other's environment. Both skip (with a printed reason) when no browser exists, rather than passing green with nothing rendered. The negative controls are fixtures that only write text into a `.png` or `.mp4` file: they make the tests fail with `artifact has the PNG signature` and `a text file must not pass as an ISO base media container`, so a green result is load-bearing. The fixture takes its browser from `HYPERMAKER_CHROME`/`CHROME_BIN`; it previously hard-coded `chromium.executablePath()`, a path absent on machines that never ran `npx playwright install`, so it could not run at all.

`test/lifecycle.test.mjs` covers the run lifecycle with `test/fake-agent.mjs`, whose modes are slow, failing, and process-tree. Each assertion was checked by breaking the behaviour it protects: removing the 409, dropping `status`/`error` from the serializer, removing `adopt()`, and replacing the group kill with a child kill all make the suite red. The Stop and overlap cases wait for the agent to record its argv or start its grandchild first; without that wait an immediate Stop killed nothing and the orphan check passed vacuously.

Real Codex CLI runs were taken on 2026-11-27 (`codex-cli 0.172.0`, ChatGPT auth). The first produced a plain-text artifact; Stop and a deliberate model rejection were exercised the same way, and the rejected card carried the CLI's own message. A later **content chain** produced three artifacts in one workspace through the HTTP entry point: a 1200x675 PNG poster, a 720x405 h264 MP4 (3 s, 30 fps) rendered from that poster taken as a direct input, and a 4-second 44.1 kHz mono WAV rendered from the same input, all previewed by the canvas. `node test/chain.mjs` reproduces exactly that chain, spends real model calls, and writes screenshots plus a JSON record of every checked fact.

Two things that chain taught, which the tests alone had not:

- The agent rendered a correct PNG on the first run without using Remotion at all — it screenshotted with Playwright, because the method guide never said where a browser was. The image was fine; the *method contract* was underspecified. The guide now names `HYPERMAKER_CHROME`/`CHROME_BIN`.
- The audio card looked green while being unusable: the file existed and played, but the player could not report a length. That is why the audio test reads `audio.duration` and `audio.seekable` from the browser rather than trusting the node's `status`.

What the chain does not show is quality. One render per medium says the path works; it says nothing about whether the words, pacing or composition are good, and the fixture compositions remain two frames and a test tone.

What remains unproven locally: audio (`tts.cpp`, `bark.cpp`), `hyperframe`, and the quality presets against a real model. The fake agent reproduces the artifact contract, not agent judgment. The video path is proven at the harness level only: the render is real, but the two-frame fixture composition is not evidence that a real agent will choose sensible dimensions, codec or duration.
