# Hypermaker Implementation Plan

This document is implementation source of truth. Product behavior belongs in [`design.md`](design.md).

## Architecture

Build local web app: browser frontend, local Node/TypeScript harness, Codex CLI provider, filesystem artifacts/manifests, and in-memory canvas state. Frontend uses HTTP; generation activity uses SSE or equivalent server push. User answers return by HTTP and go to active Codex process. `npm run dev` logs every Codex command, raw Codex stdout/stderr JSONL, and normalized trajectory event to stdout and root `dev.log`.

## Model

Use canonical absolute artifact paths as imported-node identity. Draft generation nodes without artifacts use an in-memory generated ID until successful generation returns an artifact path.

```ts
type SupportedType = "text" | "image" | "audio" | "video";
type Node = { id: string; artifactPath?: string; type: SupportedType; prompt: string; method?: string; scriptPath?: string; manifestPath?: string; inputs: Map<string, string>; position: { x: number; y: number }; status: "idle" | "dirty" | "stale" | "running" | "warning" | "error"; trajectory: RunEvent[]; error?: string };
type Canvas = { nodes: Map<string, Node>; selectedNode?: string };
```

Same canonical path returns same imported node. Double-clicking empty canvas creates a draft generation node with an in-memory ID, empty prompt, default output type `text`, method `llm`, and no artifact. Generate allocates a node-local working directory for drafts before launching Codex. Clone creates a new working directory with parent links and no children. Canvas deletion removes only memory, never files.

## Import and manifests

For imported artifact: canonicalize path, infer type from MIME/extension registry, find `manifest.json` in containing directory, validate version, create/reuse node, load metadata, resolve inputs relative to node directory, recursively import inputs, connect them, and detect cycles. Invalid manifests remain visible with warning. Missing inputs become broken links but do not block generation.

Manifest paths use relative paths. Writes use current schema version and old supported versions remain readable.

## Registries

Keep type and method registries filesystem-data-driven. Each `types/<type>/index.mjs` declares its ID, MIME types, extensions, and preview kind. Each implemented method is `types/<type>/methods/<method>.mjs` and declares compact instructions and common-tool inventory. Load the registry once at startup and derive import detection, selectable methods, prompt guides, and UI metadata from it. Register `llm` for text, and `hyperframe` plus `remotion` for image/video. Remotion scripts use project-local Remotion packages to render one still or video artifact; the agent owns composition source, render invocation, inspection, and repair. Keep future methods such as `bark.cpp` and `tts.cpp` out of the selectable registry until implemented. No plugin installer or arbitrary custom renderer in v1.

## Agent adapter

Launch one autonomous Codex CLI process per Generate. Different nodes run in parallel; one node has one active run. Codex `cwd` is the application project directory; prompt gives the absolute current node directory and restricts generated writes there. The selected model is passed with `--model`; selected effort is passed as Codex `model_reasoning_effort` configuration. Defaults are `gh/gpt-5.6-luna` and `medium`. Context includes current prompt, direct linked inputs, names, paths, types, previews, manifests/scripts, method instructions, and current node files. Project-local skills are discovered by Codex from that working directory rather than named in the assembled prompt. Log exact command before launch. Preserve raw process lines separately from normalized UI events.

Normalize process output and agent result type/method casing, then emit each event immediately to node, SSE clients, stdout, and `dev.log`:

```ts
type RunEvent = { kind: "status" | "tool_call" | "tool_result" | "question" | "warning" | "complete" | "failure"; text?: string; name?: string; input?: unknown; output?: unknown; id?: string; options?: string[]; result?: AgentResult; error?: string };
type AgentResult = { prompt: string; script: string; artifact: string; type: SupportedType; method: string; error?: string | null };
```

Questions use interactive stdin. Card renders only the latest trajectory item as a refreshing status display while the run is active; full events remain in stdout and `dev.log`. Activity is UI-only and not persisted. Reject malformed results, unsupported types/methods, missing files, and paths outside current node directory.

## Generation

Agent owns script execution, output naming, inspection, repair, and current-node `AGENTS.md`. Harness builds a compact, clearly separated `#`-section prompt in exact order: shared prompt, output-type prompt, generation-method prompt with method-specific common-tool inventory, current-node `AGENTS.md`, direct inputs, runtime context, and user prompt. Remove only duplicate, stale, or contradictory instructions; preserve useful context. Each direct input includes its directory, artifact filename and either text contents or multimodal path/metadata, plus source filename/contents and input-node `AGENTS.md` when present. Only direct inputs are listed. Text output defaults to plain `.txt`, not Markdown. Harness owns draft-directory allocation, process lifecycle, result validation, manifest writing, trajectory logging, and UI updates. Agent may read relevant local files and use network, but writes only current node directory; enforce after symlink resolution. Every successful node has `AGENTS.md`; simple nodes leave it empty, while agent records only useful reusable memory.

On success validate result, normalize common MIME-style output types such as `image/png` to the registered artifact type, atomically replace script/artifact, write manifest from returned prompt/inputs/script/output/type/method, and update node/stale descendants. Use temporary directory inside node directory. Preserve previous valid artifact on failure. Built artifact plus returned error remains usable with warning. No artifact versions; transient logs/errors stay outside manifest.

Prompt edits mark dirty. Upstream changes mark descendants stale. No automatic downstream generation.

## UI

Implement a real node-editor canvas: compact draggable cards with an artifact-dominant preview, pan by dragging empty canvas, wheel/pinch zoom only when pointer is not over a scrollable card control, visible SVG links, and drag-card-over-card linking. Double-click any empty background area creates a draft generation node at the canvas coordinate; double-clicking a card must not create one. Surface failed node creation in the UI. Generation cards expose output-type and generation-method dropdowns; method options are filtered by output type and both selections are sent with Generate. Support connect/disconnect, rename links, edit prompts, clone, delete one node, select/Generate, show latest live events/questions, display artifact, and force-layout visible DAG. Force layout combines topological layering with global collision relaxation so card rectangles do not overlap. Preview text via styled preformatted bytes; images/audio/video use native viewers. No proxy render. Show the latest agent message only while a node is running; show generation errors inside the artifact preview.

Keep link SVG above cards with directional markers and event metadata. Right-clicking an edge calls unlink for its target/name. Maintain card z-order in canvas state. Apply live events incrementally to the affected card; do not rebuild unrelated cards or focused editors. CSS must force wrapping and hide horizontal overflow for all text-entry and text-display controls. Add per-card artifact download and open image previews in a new browser tab. Put model and effort selectors in the top bar; apply them to later runs without changing existing nodes.

## Tests

Test type detection; valid/invalid/old manifests; recursive DAG, shared deduplication, cycles, missing inputs; filename defaults and duplicates; deletion and clone; dirty/stale states; question round-trip; event normalization; parallel runs and duplicate rejection; strict result and path validation; atomic replacement and failure preservation; warnings; manifest update; preview; force layout.

E2E: import generated output, see upstream DAG, add/rename input, edit prompt, Generate, answer question, observe events, let Codex execute/repair, and see exact artifact. Reload clears canvas; re-import reconstructs DAG.


## Defaults

Local web app; React/Vite; Node/TypeScript; Codex CLI; HTTP + SSE; stdin answers; one run/node and parallel nodes; sibling `manifest.json`; no canvas persistence, copying, versions, plugins, or custom types; full agent network; current-node-only writes; default Codex model `gh/gpt-5.6-luna`; default effort `medium`.
