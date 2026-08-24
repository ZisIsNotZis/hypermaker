# HyperMaker Design

Product and domain source of truth. Implementation architecture belongs in `impl.md`.

## Product

HyperMaker is a local-first node canvas. Codex turns directly connected artifacts into new reproducible artifacts. Initial types: `text`, `image`, `audio`, `video`.

## Workspace

One active workspace is open at a time. Default workdir is `.hypermaker`; opening another directory switches to it. `<workdir>/workspace.yml` is the only graph persistence. Node IDs are integers; inputs are ordered integer IDs. Input display names always come from source artifact filename. Node files live in `<workdir>/<id>/`; filenames are relative to that node directory.

Draft nodes have no directory until Generate. Imported external files are copied into their new node directory. Imported files are constant nodes: no method and no Generate. Generated nodes have optional script, artifact, `AGENTS.md`, and raw `codex.jsonl`. No manifest, recursive import discovery, versioning, copy-on-link, or simultaneous workspaces.

## Canvas

Double-click empty canvas creates generation node. Cards drag; canvas pans/zooms. Dragging A onto B creates input A on B; source returns after linking. Dragging continues for the complete pointer gesture even when pointer leaves the card title bar. Links are directional arrows above cards. Right-click link cancels it and suppresses browser menu. Clicking any card raises it. Each card has a Delete button; deleting requires double-click and has no confirmation. Reset layout uses dependency layering and collision-free spacing.

Double-click empty canvas creates generation node. Cards drag; canvas pans/zooms. Dragging A onto B creates input A on B; source returns after linking. Dragging onto empty canvas moves card. Links are directional arrows above cards. Right-click link cancels it and suppresses browser menu. Clicking any card raises it. Reset layout uses dependency layering and collision-free spacing.

## Generation

One Generate button produces one exact artifact. Generation is asynchronous and concurrent. Start persists workspace and creates node directory; completion persists returned filenames and refreshes only that node. Agent returns only `{script?, artifact}`. Harness validates node-local paths and artifact type. Agent runs with repository root cwd so `.agents` loads, writes only current node directory.

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

Quality choices: sketch, demo, standard, artistic, realistic. Preview displays exact artifact; no preview/final generation mode. Types and methods are filesystem registry entries under `types/<type>/methods/<method>`.
