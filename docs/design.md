# Hypermaker Design

This document is the product and domain source of truth. Implementation mechanics belong in [`impl.md`](impl.md).

<!-- UI: generation cards stay compact for dense canvases; artifact preview gets most of the card area. The live agent message is visible only while that node is generating. Generation errors appear inside the artifact preview area. -->

## Product

Hypermaker is a visual orchestration workspace. Codex turns connected supported artifacts into new reproducible artifacts.

It is not limited to video. Initial supported artifact types are `text`, `image`, `audio`, and `video`.

The user works with artifacts, prompts, previews, and links. The agent composes inputs, writes and runs scripts, inspects results, fixes problems, and delivers the final artifact.

## Artifacts and nodes

An artifact is a supported rendered file. A node is its canvas representation.

Each node has one artifact path when it has an artifact, one text prompt, zero or more named input links, an optional script path when regeneratable, a selected output type, a selected generation method when applicable, a canvas position, and transient generation trajectory while running. A draft node has no filesystem directory until it is generated; linking a draft does not create one.

Double-clicking empty canvas creates a new generation node at that position. The gesture must work anywhere in the canvas background, including the dotted world and empty SVG area, but never inside an existing card. New generation nodes start without an artifact, with an editable prompt, and with an initial supported output type and method. Generate creates a node-local working directory when needed; successful runs return node artifact and script paths. They become regeneratable when Generate succeeds.

An imported file with no valid adjacent `manifest.json` is a constant artifact. It can be used as input but has no Generate operation. An imported file with a valid adjacent manifest is regeneratable. Its manifest supplies prompt, script, output, type, method, and input links.

Artifact type describes rendered output only. Hypermaker does not classify whether an image or video is riggable, layered, or otherwise internally structured. Agent and script decide that.

## Import and DAG discovery

Importing an artifact adds it to canvas and recursively traverses its manifest inputs. Missing or invalid manifest stops traversal at that artifact, which remains usable as constant node.

Same canonical artifact path always maps to same in-memory node. Shared parents appear once and form DAG. Cycles are invalid and shown as errors.

No global project graph. Importing another output adds its upstream DAG. Deleting a node removes only that canvas node and never deletes filesystem artifacts or recursively removes parents.

## Prompts and links

Generated nodes always have text prompt. Prompt can reference linked inputs using `@input-name`.

Input names default to complete source filename, including extension. Duplicate defaults are disambiguated, for example `ribbon.jpg` and `ribbon_2.jpg`. Users may rename links without changing source artifact.

Every linked input is provided to agent. Removing a link excludes it. Unknown `@references` are allowed; editor may later highlight valid references and offer chooser.

## Manifest

`manifest.json` lives in same directory as artifact, script, and related generated files. Paths are relative to current node directory. Agent chooses informative output filenames.

```json
{
  "version": 1,
  "prompt": "Compose a calm opening scene.",
  "inputs": {
    "background.png": "../background/city-at-dawn.png",
    "voice.wav": "../voice/intro.wav"
  },
  "script": "compose.ts",
  "output": "opening-scene.mp4",
  "type": "video",
  "method": "hyperframe"
}
```

Harness validates manifest schema by version and stays backward compatible. Manifest is recipe/provenance, not run history.

## Generation

Generate is one button and produces one exact artifact. No preview/final dropdown or proxy mode. Each generation card exposes an output-type dropdown and a generation-method dropdown. The method choices are filtered by selected output type. A new generation node must have both before generation.

While running, card continuously displays the latest useful Codex trajectory item: reason/chat text directly; tool activity as tool name plus JSON arguments; tool results, questions, warnings, and errors in their useful text form. Decorative reasoning markers and lifecycle-only events are not shown in the card. The card is a live status display, not a transcript. Harness still writes every raw Codex JSONL event plus normalized trajectory to `dev.log`.

Generation prompt is assembled as clearly separated `#` sections in this exact order: `SHARED PROMPT`, `OUTPUT TYPE`, `GENERATION METHOD`, current-node `AGENTS.md`, direct `INPUTS`, `CONTEXT`, then `USER PROMPT`. Inputs of an input node are not repeated: only files directly linked to the current node are listed.

Each direct input describes its directory path, then its artifact. A text artifact includes its filename and UTF-8 contents in a code block. A non-text artifact includes its filename, path, and available metadata. If the input node has a source script, the input also includes that source filename and contents in a code block. If its node directory has `AGENTS.md`, that memory is included in a code block. The current node's `AGENTS.md`, when present, is included in its own section. `CONTEXT` contains runtime/node facts that are useful to the agent but are not fixed behavioral instructions. The final user prompt remains separate and authoritative.

Codex runs with the application project directory as its process working directory, so project-local `.agents` skills are available. Generated files remain restricted to the current node directory.

Agent receives the same sectioned prompt. Text output defaults to plain UTF-8 text with an informative `.txt` filename, not Markdown unless user asks. Agent may maintain current-node `AGENTS.md` with durable usage notes and caveats. Project-local skills are loaded by Codex from the application working directory; the assembled prompt does not name or instruct the agent to load them.

Agent executes script and performs inspect-and-fix loop. It returns metadata only after completion:

```json
{"prompt":"optimized prompt","script":"compose.ts","artifact":"opening-scene.mp4","type":"video","method":"hyperframe","error":null}
```

Harness consumes result, updates node and manifest, and displays non-null error as artifact warning. Agent activity is transient UI state and is not persisted.

Agent may modify only current node directory. It may not modify harness, shared utilities, or global agent memory. Generation replaces current script and artifact. No built-in artifact versioning; use clone plus naming or Git.

Changing prompt marks node dirty while retaining artifact. Changing upstream artifact marks descendants stale; no automatic regeneration.

## Preview

Preview is UI display of current artifact. It does not run renderer, create proxy, or alter artifact. Text uses a styled preformatted viewer, images use image viewer, audio/video use native browser controls.

## Generation methods

Methods are extensible and associated with supported output types. A method contributes instructions and structured details alongside shared prompt. Current methods are `text -> llm`, `image/video -> hyperframe`, `image/video -> remotion`, and `audio -> tts.cpp` or `bark.cpp`. Audio methods produce one ordinary WAV artifact plus their source script; the harness does not inspect or subtype the source. There is no `builtin` generation method. Output types and methods are registered in the filesystem under `types/<output-type>/`; each type declares MIME/extensions and each method lives under that type's `methods/` directory.

## Canvas

Canvas state is in memory only. It stores imported nodes, positions, link names, selection, and grouping. Canvas is a serious node-editor surface, similar in interaction to Node-RED, ComfyUI, or Blender: cards are draggable, the canvas pans and zooms, and dragging a card onto another creates a logical input link.

Links use directional arrows. Arrows remain visually above cards so direction stays visible. Clicking anywhere inside a card brings that card to the front. Live updates to one node must not interrupt editing or focus inside another node. Text entry controls wrap content and never expose horizontal scrolling.

Dragging source card A onto target card B creates A -> B: A output becomes B input, then A returns to its pre-drag position. Dragging a card to empty canvas repositions it normally. The target receives a default input name based on A's source filename; duplicate names are disambiguated. A visible edge represents each link. Cards remain movable without changing links. Right-clicking an edge cancels/removes that link.
Draft nodes may be linked before they have artifacts. Such a link uses the draft node identity until its first successful generation; harness then resolves that input to the newly returned artifact path.

Force-layout/reset applies to currently visible DAG. It places upstream nodes before downstream nodes, then relaxes positions globally until card rectangles have no overlap while preserving readable links and canvas bounds. Canvas need not display every project artifact.

Each node card has a download action for its current artifact. Clicking an image preview opens the full artifact in a separate browser window/tab. The top bar selects the Codex model and reasoning effort for future Generate runs; defaults are `gh/gpt-5.6-luna` and `medium`.

## Future and non-goals

Current version excludes diffusion/DiT generation, Hypermaker-owned rigging/bones/layers/timelines, automatic file copying, built-in artifact history, and arbitrary custom artifact types. Type/MIME mapping and generation-method registries remain modular for future extensions.
