**English** | [简体中文](README.zh-CN.md)

<div align="center">
  <img src="docs/logo.svg" alt="Hypermaker logo" width="112" />

  # Hypermaker

  ### A canvas for turning connected ideas into real artifacts. ✦

  <p><strong>A local-first node canvas where Codex writes the script, runs it, and hangs the resulting text, image, audio or video back on the graph — every prompt, script and output left readable on disk.</strong></p>

  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-8b7cf6?style=flat-square" alt="AGPL-3.0-or-later" /></a>
</div>

<p align="center">
  <img src="docs/screenshots/canvas.svg" alt="Hypermaker canvas with three connected artifact cards" width="94%" />
</p>

> **Status: closed milestone (0.1.0).** The prototype reached its experimental
> goal; no further development is planned unless the project's inputs or goals
> change. See [`docs/project-status.md`](docs/project-status.md).

## Why Hypermaker?

Terminal-driven generation is powerful, but it hides the structure of the work. Hypermaker puts that structure on a canvas:

```text
idea -> node -> artifact -> connected node -> larger artifact
                            \- inspect / repair / regenerate
```

Each generation node has a prompt, named inputs, an output type, a generation method, a quality preset, a script, and a rendered artifact. The agent writes and runs the script, checks the result, and hands the artifact back to the canvas. Everything stays inspectable on disk.

No diffusion or DiT model is required. Hypermaker is deliberately about code-generated, renderable work: the kind of work an LLM can explain, modify, execute, and debug.

## Quick start

Requirements:

- Node.js 20 or newer
- An authenticated [Codex CLI](https://github.com/openai/codex) available as `codex` (or pointed to by `CODEX_BIN`)
- A local browser

```bash
git clone --recurse-submodules https://github.com/ZisIsNotZis/hypermaker.git
cd hypermaker
npm install
npm run dev
```

Open <http://127.0.0.1:8787>.

Double-click empty canvas to create a node. Choose its type, method and quality, write a prompt, and press **Generate**. Drag one card onto another to make it an input; right-click the link to remove it. Every generated node gets its own directory under `.hypermaker/<id>/`.

The submodules in `vendor/` (the HyperFrames and Remotion skill sets) are what `.agents/skills/` symlinks into, so the `--recurse-submodules` clone is what makes agent skills resolve.

Server environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `HYPERMAKER_HOST` | `127.0.0.1` | bind address |
| `HYPERMAKER_WORKDIR` | `<repo>/.hypermaker` | workspace directory |
| `CODEX_BIN` | `codex` | CLI to spawn (a `.mjs` path is run with the current Node) |

## What it can do today

- Build a DAG by dragging cards together; only direct inputs enter a downstream prompt.
- Generate plain UTF-8 text with the `llm` method.
- Generate still images and video with the `hyperframe` or `remotion` methods.
- Generate WAV/MP3/OGG speech with the local `tts.cpp` or `bark.cpp` methods.
- Pick a quality preset — `sketch`, `demo`, `standard`, `artistic`, `realistic` — which changes how much inspection and repair the agent does.
- Import an existing local file as a constant node (no method, no Generate); the file is copied into its node directory.
- Run several generations concurrently; each card shows its own `draft` / `running` / `idle` / `error` state over SSE.
- Inspect the exact prompt, script, artifact, `codex.jsonl` transcript and node-local `AGENTS.md` on disk after every run.
- Preview text, image, audio and video natively in the card, download the artifact, and delete a node (with confirmation) from the canvas.
- Clone and relayout through the HTTP API (`POST /api/clone`, `POST /api/layout`); the canvas UI does not expose buttons for these yet.

The registry is filesystem-driven. A new output type is a directory under `types/`, and a new method is a file `types/<type>/methods/<method>.mjs`; both are loaded at startup, so the harness has no per-type special cases.

## The mental model

| Thing | Meaning |
| --- | --- |
| Card | One artifact-producing or imported node on the canvas |
| Input | A named direct link from another node; only direct inputs enter the prompt |
| Prompt | Human intent, combined with shared, type, method and quality guidance plus context |
| Script | The reproducible source the agent wrote for the artifact |
| Artifact | The actual output shown in the card preview |
| `workspace.yml` | The whole graph: position, inputs, type, method, prompt, quality, script, artifact per integer node id |
| `AGENTS.md` | Node-local memory for future generations in that node; empty when nothing is worth remembering |
| `codex.jsonl` | Raw Codex stdout/stderr for the run, kept for inspection only |

Imported files are copied into their new node directory, and they stay constant: no method, no Generate, no longer pointing at the original path. Draft nodes have no directory until the first Generate. The agent may choose an informative artifact filename; the harness rejects any path that escapes the node directory or whose extension does not match the node's type.

## Repository map

```text
server/index.mjs       local HTTP + SSE harness and route table
server/codex.mjs       Codex CLI adapter: one process per node, result validation
server/prompt.mjs      assembles the sectioned prompt from a node and its inputs
server/registry.mjs    filesystem type/method registry
server/workspace.mjs   workspace.yml serialization, atomic write, path safety
public/index.html      single-file canvas UI (drag, link, pan, zoom, preview)
prompts/               fixed prompt blocks: shared, output-*, type-*, quality-*
types/                 text, image, audio, video definitions + methods
test/                  node:test suites and fake Codex binaries
vendor/                pinned submodules: hyperframes, remotion skills
docs/                  design.md, impl.md, project-status.md
```

How the pieces talk: the browser sends JSON commands over HTTP, the server mutates the in-memory graph and rewrites `workspace.yml` atomically, and generation results come back as SSE events (`started`, `complete`, `error`) that make the canvas reload. Generation spawns the Codex CLI from the repository root — so `.agents` skills load — with the node directory in `HYPERMAKER_NODE_DIR`; the process writes `codex.jsonl` and a final JSON file, and the harness reads only that final file, validates the artifact, and records it in the workspace.

Project source of truth: [`docs/design.md`](docs/design.md) for product behavior, [`docs/impl.md`](docs/impl.md) for architecture. Agents read [`AGENTS.md`](AGENTS.md) first.

## How to develop

```bash
npm install          # Node.js 20+, installs Playwright and the Remotion packages
npm test             # deterministic harness/registry/workspace tests, fake Codex
npm run test:e2e     # canvas tests; needs a Chromium that Playwright can launch
node --check server/index.mjs
git diff --check
```

`npm test` uses `test/fake-codex.mjs` and its siblings, so it needs no model access. In the tests, set `HYPERMAKER_RESET_WORKSPACE=1` to start from an empty graph.

## How to contribute

Small, focused changes are easiest to review. Read [`AGENTS.md`](AGENTS.md), [`docs/design.md`](docs/design.md) and [`docs/impl.md`](docs/impl.md) first, keep type/method behavior under `types/`, add a focused regression test for behavior you change, and update the source-of-truth doc when behavior changes. Full rules are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

```bash
git checkout -b feat/your-idea
npm test
git diff --check
```

## Roadmap

**Implemented (0.1.0)**

- Integer-id node graph persisted as one `workspace.yml`, atomic writes, node-local paths.
- Filesystem registry with four output types and five methods (`llm`, `remotion`, `hyperframe`, `tts.cpp`, `bark.cpp`).
- Concurrent async generation through the Codex CLI, with per-node status over SSE and validated artifact/script output.
- Canvas: create, drag, link, unlink, pan, zoom, preview, download, delete-with-confirmation, import.
- Deterministic tests plus a Playwright browser suite running against fake Codex binaries.

**Deferred / not planned right now**

- More output types and generation methods.
- Richer graph editing (multi-select, undo, dependency-aware relayout), richer media metadata, collaboration.
- Benchmarks, a video, or a paper — none were produced and none are in scope for this milestone.

The registry boundary exists so that a future experiment (a new type, a different agent) does not require rewriting the core. If someone picks the project up, that is the seam to start from.

## License

Hypermaker is free software under the [GNU Affero General Public License v3.0 or later](LICENSE).

<div align="center">
  <br />
  <strong>Connect the work. Keep the source. Ship the artifact.</strong>
</div>
