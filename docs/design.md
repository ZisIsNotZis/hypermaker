# HyperMaker Design

Product and domain source of truth. Implementation architecture belongs in `impl.md`.

## Product

HyperMaker is a local-first node canvas. Codex turns directly connected artifacts into new reproducible artifacts. Initial types: `text`, `image`, `audio`, `video`.

## Workspace

One active workspace is open at a time. Default workdir is `.hypermaker`; opening another directory switches to it. `<workdir>/workspace.yml` is the only graph persistence, and it includes each node's last run status and error so a failure is not forgotten on restart. Node IDs are integers; inputs are ordered integer IDs. Input display names always come from source artifact filename. Node files live in `<workdir>/<id>/`; filenames are relative to that node directory.

Draft nodes have no directory until Generate. Imported external files are copied into their new node directory. Imported files are constant nodes: no method and no Generate. Generated nodes have optional script, artifact, `AGENTS.md`, and raw `codex.jsonl`. No manifest, recursive import discovery, versioning, copy-on-link, or simultaneous workspaces.

## Canvas

Double-click empty canvas, or press **+ Card**, to create a generation node. Cards drag; canvas pans by dragging empty space and zooms with the wheel, anchored at the pointer. Artifact preview uses a 4:3 aspect ratio that reserves its space, so long text scrolls inside the card instead of pushing Delete and Generate off screen. Dragging A onto B's title bar creates input A on B; the source then returns to where it started. A drag that ends anywhere else keeps its new position, so cards can also be stacked on purpose. Only the primary button starts a drag or a pan. Dragging continues for the complete pointer gesture even when the pointer leaves the card title bar, and ends on pointerup or pointercancel. Links are directional arrows drawn in canvas coordinates, so they stay on their card edges through pan, zoom and drag. Panning moves the canvas and wheel zoom anchors at the pointer. Right-click a link cancels it and suppresses the browser menu; this still works when the link runs behind another card's body, and right-clicking a card's own control (prompt, select, Generate, Delete) never unlinks anything. Clicking any card raises it to the front, the raised card stays in front across server refreshes, and a covered card can be raised from its exposed edge so its own controls then accept input. Prompts save on a short debounce, on blur, and before Generate; a refresh never overwrites text being typed. Each card has a Delete button; clicking it asks for confirmation, then deletes. Reset layout reflows every card into a four-column grid with fixed spacing (no dependency layering yet).

## Generation

One Generate button produces one exact artifact, and one card has at most one run at a time: a second Generate while a card is running is refused, not queued. Generation is asynchronous and concurrent across cards. Start persists workspace and creates node directory; completion persists returned filenames and refreshes only that node. Agent returns only `{script?, artifact}`. Harness validates node-local paths and artifact type. Agent runs with repository root cwd so `.agents` loads, writes only current node directory.

A running card shows its state and offers Stop. Stop ends the agent and every process it started, then leaves the card `cancelled` with the previous artifact intact. A failed run leaves the previous artifact intact too and shows its reason on the card; the reason is stored, so it is still there after reopening the page or restarting the server. A run that was cut off by the server stopping is shown as interrupted, never as a draft that never started. A missing agent is reported as an install-or-configure instruction.

Prompt sections, exact order:

```text
# SHARED PROMPT
# OUTPUT TYPE
# GENERATION METHOD
# QUALITY
# AGENTS
# INPUTS
# CONTEXT
# USER PROMPT
```

Direct inputs include directory; artifact filename plus text contents or multimodal path and metadata; source filename and contents when present; and `AGENTS.md` when present. Only direct inputs are included. Text output is plain UTF-8 unless user requests Markdown. `AGENTS.md` always emitted; empty for ordinary nodes.

Quality choices: sketch, demo, standard, artistic, realistic. Sketch and demo omit background unless user explicitly asks for one. Preview displays exact artifact; no preview/final generation mode. Types and methods are filesystem registry entries under `types/<type>/methods/<method>`.
