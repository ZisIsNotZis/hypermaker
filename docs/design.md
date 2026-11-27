# HyperMaker Design

Product and domain source of truth. Implementation architecture belongs in `impl.md`.

## Product

HyperMaker is a local-first node canvas. Codex turns directly connected artifacts into new reproducible artifacts. Initial types: `text`, `image`, `audio`, `video`.

## Workspace

One active workspace is open at a time. Default workdir is `.hypermaker`; opening another directory switches to it. `<workdir>/workspace.yml` is the only graph persistence, and it includes each node's last run status and error so a failure is not forgotten on restart. Node IDs are integers; inputs are ordered integer IDs. Input display names always come from source artifact filename. Node files live in `<workdir>/<id>/`; filenames are relative to that node directory.

Draft nodes have no directory until Generate. Imported external files are copied into their new node directory. Imported files are constant nodes: no method and no Generate. Generated nodes have optional script, artifact, `AGENTS.md`, and raw `codex.jsonl`. No manifest, recursive import discovery, copy-on-link, or simultaneous workspaces.

A card keeps its finished versions. Changing the material upstream and pressing Generate again must not cost the artifact already approved, so a run does two things in a fixed order: it freezes a copy of each direct input into `<workdir>/<id>/versions/` and hands the agent those copies, and on success it publishes its output under a fresh name in `versions/` and points the card at that. Nothing the agent writes is visible until the run succeeds, so a failure has nothing to roll back, and the artifact on the card and the materials recorded for it always describe the same bytes.

A run may only publish a file it wrote itself. An agent that names a path left by an earlier run - which a real one did, producing two "versions" of the same video for two different posters - is a failed run with a reason the person can act on, not a new version. The judgement is "was this file written during this run", and it is made without a clock: every file in the node directory is fingerprinted (device, inode, size, nanosecond mtime and ctime) before the run, and the named artifact must no longer match. Comparing modification time against the run's start *with a tolerance* was the first attempt and was wrong twice over: the tolerance had to be large enough for filesystem timestamp granularity, which meant two runs closer together than the slack let the earlier file through as the new result - change a prompt and press Generate again within a second and it happened every time. A fingerprint has no such window. It also leaves the opposite case alone: a deterministic renderer that produces identical bytes twice did write the file, so it is a second version, not a stale one.

What the fingerprint cannot see: an agent that rewrites a file *and* restores it to the
same bytes with the same size within the same timestamp tick of a coarse filesystem -
FAT, some SMB mounts, a few container overlays. The check would call that unwritten and
refuse a legitimate result. The failure is the safe direction (a retryable error, never a
duplicate version), and on the filesystems this runs on the nanosecond clock makes it
practically unreachable; it is written down because "never" would be a claim the check
does not earn. `workspace.yml` stores the kept versions with their source copies, so they survive a restart. Going back to an earlier version is a pointer move, is itself reversible, and is refused while the card is generating.

An instruction is provenance too. A card has two prompt fields: `prompt` is what the person is asking for next and stays theirs to edit, and `promptUsed` is what the artifact on the card was actually made from. They are separate because editing the text does not change the artifact on screen, and one field for both made an edit rewrite the history of an approved take; the replaced version's record was read from the box when the next run started. Each kept version carries its own `prompt`, and restoring a version restores its prompt with its bytes, so the box always describes the picture next to it. A version kept before prompts were recorded has `null`, and that travels with it: restoring such a version clears `promptUsed` rather than leaving the replaced take's instruction on the card, while `prompt` - the next take being written - is left alone, since a restore is not the moment to discard it. The card then reads `asked for: unknown (kept before prompts were recorded)`, because silence reads as agreement. Filling an unknown in with the card's current prompt would be the same lie in the other direction.

Two takes of one card can be compared without choosing between them: a `compare` button on the kept row opens both simultaneously, one pane per version, each captioned with its version and its prompt, and either pane can be pointed at any other version. It reads from the same node record and file endpoint as the card, and it never restores anything - what the card shows is unchanged when it closes. The canvas shows `asked for: …` under the prompt while the box and the artifact disagree, and puts each version's prompt in its tooltip.

A published name carries the card's publish ordinal, counted from the files in `versions/`: `v1-`, `v2-`. It is not derived from the version list (restoring empties a slot there, which once made a publish overwrite the artifact on the card) and not from filename collision (an agent naming each render freshly, as the video guide asks, produced `v1-shot-a` and `v1-shot-b` for two takes of one card).

## Canvas

Double-click empty canvas, or press **+ Card**, to create a generation node. Cards drag; canvas pans by dragging empty space and zooms with the wheel, anchored at the pointer. Artifact preview uses a 4:3 aspect ratio that reserves its space, so long text scrolls inside the card instead of pushing Delete and Generate off screen. Dragging A onto B's title bar creates input A on B; the source then returns to where it started. A drag that ends anywhere else keeps its new position, so cards can also be stacked on purpose. Only the primary button starts a drag or a pan. Dragging continues for the complete pointer gesture even when the pointer leaves the card title bar, and ends on pointerup or pointercancel. Links are directional arrows drawn in canvas coordinates, so they stay on their card edges through pan, zoom and drag. Panning moves the canvas and wheel zoom anchors at the pointer. Right-click a link cancels it and suppresses the browser menu; this still works when the link runs behind another card's body, and right-clicking a card's own control (prompt, select, Generate, Delete) never unlinks anything. Clicking any card raises it to the front, the raised card stays in front across server refreshes, and a covered card can be raised from its exposed edge so its own controls then accept input. Prompts save on a short debounce, on blur, and before Generate; a refresh never overwrites text being typed. Each card has a Delete button; clicking it asks for confirmation, then deletes. Reset layout reflows every card into a four-column grid with fixed spacing (no dependency layering yet).

## Generation

One Generate button produces one exact artifact, and one card has at most one run at a time: a second Generate while a card is running is refused, not queued. Generation is asynchronous and concurrent across cards. Start persists workspace and creates node directory; completion persists returned filenames and refreshes only that node. Agent returns only `{script?, artifact}`. Harness validates node-local paths and artifact type. Agent runs with repository root cwd so `.agents` loads, and writes only in a run directory of its own (`<workdir>/.runs/<id>/<start>`), never in the card's.

A card's directory is the person's. Before a run starts, every file in it is copied beside the run and hashed; after the run - success, Stop, failure, or the next startup when the server died - each file is checked by content and put back if it was deleted or changed, and the card says which file had to be restored. The copy is a copy rather than a hardlink because an ordinary save reopens the existing file and writes into it, which a shared inode would not reveal. A file over 64 MiB is kept by a link rather than a copy: a deletion is still repaired and an in-place rewrite is not, and that is said on the card before the agent starts. A stopped run stays `cancelled` even when its damage had to be repaired; a run that succeeded but touched the card is reported as an error, because its output was made from material it modified.

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

Direct inputs include directory; the frozen copy's path plus the artifact filename it came from, text contents or multimodal metadata; source filename and contents when present; and `AGENTS.md` when present. Only direct inputs are included. Text output is plain UTF-8 unless user requests Markdown. `AGENTS.md` always emitted; empty for ordinary nodes.

Quality choices: sketch, demo, standard, artistic, realistic. Sketch and demo omit background unless user explicitly asks for one. Preview displays exact artifact; no preview/final generation mode. Types and methods are filesystem registry entries under `types/<type>/methods/<method>`.
