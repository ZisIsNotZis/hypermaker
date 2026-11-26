# HyperMaker Implementation Plan

Implementation source of truth. Product behavior belongs in `design.md`.

## Architecture

Small local Node HTTP server, static browser canvas, filesystem workspace, filesystem registry, and Codex CLI adapter. One in-memory active workspace mirrors `workspace.yml`. HTTP handles commands; SSE sends completion/error notifications. Raw Codex output goes to node `codex.jsonl` and `dev.log`; application does not parse trajectory.

## Workspace

`workspace.mjs` owns YAML-compatible serialization, parsing, atomic writes, integer IDs, and node-local path validation. Server loads active workspace and saves after graph mutations and generation start/end. Draft nodes remain memory-only until Generate. No old-manifest compatibility layer.

## Registry and prompts

Load type, method, and quality registry at startup. MIME/extensions drive type detection and UI options. Fixed prompt guidance lives in text files under `prompts/`; dynamic sections assemble current node and direct inputs. Preserve section order and user prompt. Do not inject skill names; repository-root cwd lets Codex discover them.

## Codex

Spawn one process per node with repository-root cwd, node directory context, model/effort, optional `gh/` prefix, and closed stdin. Pass `--json` for trajectory and `--output-last-message` for final result. Tee stdout/stderr unchanged to node `codex.jsonl` and timestamped `dev.log` plus terminal. Ignore trajectory for application logic; parse only final output file. Require artifact, allow optional script, enforce node-local paths, ensure type and `AGENTS.md`, then save workspace and emit completion. Runs never block HTTP or other nodes.

## HTTP and UI

Provide workspace open/read/save, node create, import, link/unlink, clone/delete, layout, file serving, and asynchronous generation. UI is compact canvas: pointer drag/link/pan, drag-end workspace persistence, 4:3 artifact preview, visible SVG marker arrows with hit paths, control-only wheel suppression, wrapped text, native media viewers, download/image popup, and preview errors. Card raising must not move a card during pointerdown on an interactive control. Delete control executes on click after confirmation.

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

## Verification

TDD seams: workspace round trip/atomic write/path safety; registry; prompt order/direct input metadata; node/import/link persistence; async result validation/concurrency/failure; UI creation, scrolling, drag-link, unlink, persistence, controls, preview/download. Run `npm test`, `npm run test:e2e`, `node --check`, and `git diff --check`. Browser tests launch Chromium through `test/browser.mjs`, honoring `HYPERMAKER_CHROME` or `CHROME_BIN` when Playwright's own browser is not installed. Every browser test asserts that the page raised no error, and the assertions are collected rather than thrown from the event listener, because a throw there surfaces after the test has ended.

`test/media.test.mjs` is the suite whose fixture renders rather than pretends: `test/fake-remotion-codex.mjs` bundles the composition with `@remotion/bundler`, selects it, and calls `renderStill` or `renderMedia`, then the test asserts the artifact's own bytes and the preview the canvas draws. For the image case that is the PNG signature plus a loaded `<img>` at 320x180; for the video case it is an ISO base media `ftyp` box with an h264 (`avc1`) track and a `moov` box, plus a `<video>` the browser actually decodes (`readyState >= 1`, `videoWidth` 320, non-zero duration). The two cases run against separate servers on separate ports, so the still and video fixtures cannot borrow each other's environment. Both skip (with a printed reason) when no browser exists, rather than passing green with nothing rendered. The negative controls are fixtures that only write text into a `.png` or `.mp4` file: they make the tests fail with `artifact has the PNG signature` and `a text file must not pass as an ISO base media container`, so a green result is load-bearing. The fixture takes its browser from `HYPERMAKER_CHROME`/`CHROME_BIN`; it previously hard-coded `chromium.executablePath()`, a path absent on machines that never ran `npx playwright install`, so it could not run at all.

What remains unproven locally: audio (`tts.cpp`, `bark.cpp`), `hyperframe`, the quality presets against a real model, and any real Codex CLI run. The fake agent reproduces the artifact contract, not agent judgment. The video path is proven at the harness level only: the render is real, but the two-frame fixture composition is not evidence that a real agent will choose sensible dimensions, codec or duration.
