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

Provide workspace open/read/save, node create, import, link/unlink, clone/delete, layout, file serving, and asynchronous generation. UI is compact canvas: pointer drag/link/pan, SVG marker arrows with hit paths, control-only wheel suppression, wrapped text, native media viewers, download/image popup, and preview errors.

## Verification

TDD seams: workspace round trip/atomic write/path safety; registry; prompt order/direct input metadata; node/import/link persistence; async result validation/concurrency/failure; UI creation, scrolling, drag-link, unlink, persistence, controls, preview/download. Run `npm test`, `npm run test:e2e`, `node --check`, and `git diff --check`.
