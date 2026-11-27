**English** | [简体中文](README.zh-CN.md)

> **Status: an ordinary creative session works, and is now what the tests follow (0.1.0, 2026-11-27).** You can make a film from canvas material, change the material, keep the take you approved, compare two takes, go back to one, and survive a failure, a Stop or a restart without losing the one you liked. `npm test` passes **81/81** with a usable Chromium; [Verification limits](#verification-limits) separates what is real from what a fixture stands in for, says what the offline voice was **measured** to do and that a *natural* voice is still unproven, and that nothing here has been judged on *taste*.

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

> **Status: 0.1.0, still being developed.** This is not a closed experiment. The
> canvas and the generation path are usable and covered by tests; the open work is
> evidence rather than features — output quality has not been judged, the offline voice
> is measured but robotic while a *natural* voice has never run, and the `realistic`
> preset has not been measured. See
> [`docs/project-status.md`](docs/project-status.md) for the real-vs-simulated table
> and what a first run is like.

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

Double-click empty canvas to create a node. Choose its type, method and quality, write a prompt, and press **Generate**. While the agent works the card reads `running`, Generate becomes *Generating…*, and **Stop** appears; Stop ends the agent and everything it spawned, marks the card `cancelled`, and keeps the previous artifact. A failure puts its reason on the card. Drag one card onto another to make it an input; right-click the link to remove it. Every generated node gets its own directory under `.hypermaker/<id>/`.

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
- Generate still images and video with the `hyperframe` or `remotion` methods. Both are verified end to end through real Remotion renders (`test/media.test.mjs`, `demo` quality): a 320x180 PNG asserted by signature and by the loaded preview, and a 320x180 h264 MP4 asserted by container and by the `<video>` the browser decodes.
- Generate audio two ways, both with nothing installed. `synth` writes a real WAV of tones, chords, rhythm and sound effects. `narration` reads a card's text out loud with a formant synthesizer written in this repository (`voice/` — no model, no download, no network), **robotic; it says English words and digits only**; the card then shows what the audio measured and which phrases it said. Link a text card into an audio card and that text is what gets spoken. The `tts.cpp` and `bark.cpp` methods stay the path to a natural voice, and still need binaries under `~/tts.cpp` and `~/bark.cpp` that this machine does not have — see **Verification limits**.
- Pick a quality preset — `sketch`, `demo`, `standard`, `artistic`, `realistic` — which changes how much inspection and repair the agent does.
- **The method list follows the card's type, and says which methods can run here.** Switching a card's output type refills its method list; a method whose local tool is missing stays selectable but is labelled `(needs a local install)`, and pressing Generate on it is refused with a sentence naming the missing binary and the method that works instead. Before this, switching a text card to audio left `llm` in the dropdown (so the offline `synth` method could not be picked at all) while the server would have run `bark.cpp`, whose binary does not exist.
- Import an existing local file as a constant node (no method, no Generate); the file is copied into its node directory. Import is HTTP-only today (`POST /api/import`), like clone and relayout below.
- Run several generations concurrently, one per card; each card shows its own `draft` / `running` / `idle` / `cancelled` / `error` state over SSE. While a card is running it offers **Stop**, which ends the agent and everything it started; a second Generate on the same card is refused rather than starting a second agent.
- Read the reason a run stopped or failed on the card itself, including the agent's own last error message. The outcome is stored, so reopening the page or restarting the server does not turn a failure into a quiet draft.
- Inspect the exact prompt, script, artifact, `codex.jsonl` transcript and node-local `AGENTS.md` on disk after every run.
- Preview text, image, audio and video natively in the card, download the artifact, and delete a node (with confirmation) from the canvas.
- Work on overlapping cards: the card you touched last is drawn in front, and clicking a covered card's exposed edge brings it forward, so its controls stay reachable.
- Link lines are drawn in canvas space, so they stay attached to their cards through pan, zoom and drag.
- Pan the canvas by dragging empty space, zoom with the wheel (anchored at the pointer), and edit the prompt without the card losing focus or text.
- Clone and relayout through the HTTP API (`POST /api/clone`, `POST /api/layout`); the canvas UI does not expose buttons for these yet.

The registry is filesystem-driven. A new output type is a directory under `types/`, and a new method is a file `types/<type>/methods/<method>.mjs`; both are loaded at startup, so the harness has no per-type special cases.

### Verification limits

This section mixes two kinds of evidence, and they are marked as they appear:

- **Offline and free** - `npm test` and `node test/journey.mjs`. Every agent they use is a
  fixture (`test/fake-codex.mjs`, `test/fake-agent.mjs`, `test/fake-remotion-codex.mjs`,
  `test/fake-audio-codex.mjs`, `test/fake-film-codex.mjs`, `test/fake-poster-codex.mjs`).
  They need no model, no account and no network. Where a fixture still does real work -
  Remotion really bundles and renders, Chromium really decodes the result - it says so.
- **Subscription runs** - labelled "real Codex CLI run" wherever they appear. These spent a
  logged-in ChatGPT account on this machine (`codex-cli 0.172.0`), produce real artifacts,
  and each was a single run. They prove the contract and the plumbing, not output quality,
  and they are not reproducible without such an account.

- **Text** generation is exercised end to end against `test/fake-codex.mjs`, which writes the artifact a real agent would. Separately, one **real Codex CLI run** was taken on 2026-11-27 (`codex-cli 0.172.0`, ChatGPT auth): the agent wrote `generate.mjs`, ran it, and returned a plain-text artifact the canvas previewed (37 s, ~48k input tokens). That proves the adapter matches the real binary's `exec --json --output-last-message …` contract; it says nothing about output quality.
- **Image** generation is exercised end to end against `test/fake-remotion-codex.mjs`, which really bundles and renders with Remotion; the artifact is checked to be a real PNG. The "agent" is fake, the render is not. A **real Codex CLI run** also rendered a 1200x675 PNG whose preview the canvas showed. It is worth knowing what that run did: the agent produced a correct image, but it reached for a Playwright screenshot because the method guide never told it where a browser was, so Remotion could not start. The guide now names `HYPERMAKER_CHROME`/`CHROME_BIN`.
- **Video** generation is exercised end to end against the same fixture with `REMOTION_TEST_VIDEO=1`: Remotion bundles, selects, and calls `renderMedia` with h264, and the test asserts an `ftyp`/`avc1`/`moov` container plus a preview `<video>` that decodes 320x180 with a non-zero duration. Beyond the fixture, a **real Codex CLI run** took the generated poster as an input card, rendered a 720x404 h264 MP4 (3 s, 30 fps) from it - h264 needs even dimensions, so the requested 405 becomes 404, and the canvas played it — so a realistic composition is now covered once, by one run. What is still not proven is that the result is *good*: the fixture composition is two frames, and one real render says nothing about wording, pacing or how often a model picks sensible dimensions.
- **Audio.** The **artifact path** is proven, including against a real model: `test/audio.test.mjs` drives a card whose agent writes a real 6-second 44.1 kHz mono PCM WAV with nothing installed, and asserts the RIFF header, the sample rate, that the data chunk size matches the bytes, that the samples are not silence, and that the canvas player reports the true length and can seek. Separately, a real Codex CLI run produced a 4-second WAV the canvas played (`0:00 / 0:04`) through the offline `synth` method, which produces tones, chords and rhythm, not words.
- **Narration is measured, not asserted.** The offline voice is measured on the bytes, not on a function having been called. `node voice/render.mjs --check file.wav --words "…"` reports what it heard, and a published narration is checked three times before it appears: the `timeline.json` beside the WAV must describe *this* file (phrases contiguous, adding up to its real length, every word pronounceable by the shipped voice), the published bytes must **be that recording** - rendering is deterministic, so the server re-renders the timeline's own phrases and requires the result to correlate with the file (1.000 for the same words; 0.515 for one word changed; 0.166 for two clauses swapped; a take is refused below 0.85) - and every spoken word must appear, in order, in the material the card was given, **and** the file itself must measure as speech — periodic rather than noisy, syllable onsets for the words it claims, and more than one vowel region. Sentence "The sea at night is never still. It carries every colour of the sky." measures 14 words, 18 syllables, 5.98 s, peak 29489, 87% voiced frames, 38 onsets for 18 syllables and several vowel regions. The onset count is a *floor*, roughly two rises per syllable — pinning it to one per syllable would be fitting the threshold to its own answer. The check that separates speech from a plausible impostor is the vowel regions: a 220 Hz tone amplitude-modulated at 4 Hz rings up 15 onsets, as many as a sentence, and never leaves one formant pair. `test/voice.test.mjs` pins tone, noise, sweep and silence as failures; `test/narration.test.mjs` drives a real WAV through a real Remotion film and measures the film's own audio track; `test/narration.test.mjs` also reopens the workspace after a restart and reads the phrase record back. **What this does not prove:** the voice is robotic, not natural, and its quality on a longer script has not been judged. It is also worth being precise about the word *intelligible*: everything above is a measurement of the signal, and a measurement can show that the formants move, the syllables are there and the file says what its script says - it cannot show that a person understood a sentence. There is no recogniser or speech model on this machine to check that independently, so the intelligibility claim rests on listening: `node voice/render.mjs --text "…" --out out.wav`, then play it. The probe that found the current wording (`science` → "S-S-IY-N-S", `moved` → "M-AA-V-EH-D") is exactly the kind of defect a listener hears and a measurement does not. For a natural voice, `tts.cpp` and `bark.cpp` name binaries (`~/tts.cpp/build/bin/tts-cli`, `~/bark.cpp/build/examples/main/main`) that this machine does not have, so no natural-voice run has been taken.
- **A creator's own file next to a card survives the harness, not the agent.** The cleanup rule
  cannot reach it: a run writes only in `attempts/<start>/`, and nothing in a run's
  bookkeeping reads or deletes anything in the card's own directory. That is the
  guarantee the four `test/attempts.test.mjs` cases pin, and it is what a person needs
  after a fifth retry. It is **not** a guarantee against the agent itself: the run is
  launched with `HYPERMAKER_CARD_DIR` set to that directory and
  `--sandbox danger-full-access`, so an agent that decides to tidy its surroundings can
  delete a file you put there, and the run still ends `idle`. Probed on 2026-11-27 with a
  stand-in agent that removes exactly one file and nothing else (`.tmp/probe-card-reach.mjs`):
  the file answered `200` before the run and `404` after it. Closing this means not
  handing the agent the card directory at all, or giving it a read-only view; neither is
  done.
- **A film from canvas material** is the headline outcome, and it was taken with the real
  CLI: a real poster card and a real 4-second WAV card were linked to one video card, the
  agent rendered a 720x404 h264 MP4, and the embedded audio measured **4.05 s, peak 11506,
  176739 non-zero samples** - audible sound inside the film, not a separate file beside it.
  `test/film.test.mjs` reproduces that shape with real Remotion renders on both sides. The
  trap this closed: a real agent earlier produced an MP4 with a valid AAC track of **pure
  digital silence** (peak 0), and every cheap check - MP4 container, audio stream present,
  the canvas plays it - passed. The video method guide now requires copying an audio input
  into `public/`, referencing it through `<Audio src={staticFile(...)}/>`, and **measuring
  the extracted track** before claiming audio. The first published peak for this film was 30496 and it was wrong: the measuring
script assumed the WAV `data` chunk starts at byte 44, but ffmpeg writes a `LIST` chunk
first, so 62 header bytes were counted as samples. Walking the chunk table gives **peak
11506** over 178752 samples, and its correlation with the source 4-second WAV is ~0.9997 -
that is the number to trust, and `test/wav.mjs` now parses chunks so the mistake cannot
quietly return.
- **Versions** answer the ordinary creative move: change the material upstream, keep the
  film you already liked, try a new one. Two failures made this necessary, both reproduced
  by hand first. A real agent answers the same prompt with the same filename, so a run that
  wrote its file and then failed left the card showing the old film's name and provenance
  over the failed attempt's bytes. And a film that reads its material and renders for
  minutes would record whatever the poster said when it *finished*, not what it read. Both
  come from the same cause and are fixed by one rule: **a run is given a frozen copy of its
  material and publishes its result under a name nothing can write to** (`versions/v1-…`).
  Nothing the agent writes is visible until the run succeeds, so a failure has nothing to
  roll back, and the card's artifact and provenance always describe the same bytes. Click a
  `v1`/`v2` button on the card to go back; that is itself reversible, and refused with a
  reason while the card is generating. A run may only publish a file it wrote itself: a
  real agent handed back the film it had already rendered, so two different posters became
  two "versions" with byte-identical video. That is now a failure with the reason on the
  card, with the approved version still playable and its material still recorded;
  `test/versions.test.mjs` pins it.
  The first version of this check compared the artifact's modification time against the
  run's start with a second of slack for timestamp granularity, which quietly made the rule
  inapplicable to any two runs closer together than that: change a prompt and press
  Generate again within a second and the previous file was published as a new version.
  Each run now works in an empty directory of its own (`attempts/<start>/`), so a previous
  run's file is not reachable by name at all: naming one is rejected as outside the run's
  directory. A deterministic render that writes the same bytes again in its own directory
  is still a real second result - both directions are pinned.
- **Two takes can be compared.** A `compare` button on the kept row opens both versions at
  once, one pane each, captioned with which take it is and what it was asked for; either
  side can be pointed at another version; closing leaves the card exactly as it was.
  Comparing used to mean swapping the card and remembering what it looked like.
- **The instruction is provenance too.** A version kept its bytes and its materials but not
the prompt that made it, so going back to an earlier idea left the box holding the newer
one - show one take, describe another, and the next Generate redoes the take you thought
you were looking at. A card now has both `prompt` (what you want next, yours to edit) and
`promptUsed` (what the artifact on screen was made from); each kept version carries its own,
and going back restores it. Editing the box no longer rewrites the history of the approved
take - that record used to be read from the box when the next run started. While the box
and the artifact disagree the card says `asked for: …`, and each version's tooltip names
its prompt. A version kept before prompts were recorded has none and stays unknown rather
than being filled in with today's words.
- **Takes are numbered by the card, not by filename.** Publishing numbered a version by
  whether that filename already existed, so an agent that renders to a fresh path each run -
  which the video guide asks it to do - produced `v1-shot-a.mp4` and `v1-shot-b.mp4`, two
  takes of one card both labelled `v1`. The number is now the card's publish ordinal. The
  browser test that pins this had to be given an agent that renames its output: with one
  that always writes the same file, the broken rule and the right one agree.
- **Provenance** ("made from #1 image poster.png - #3 audio tone.wav") is a persisted
  snapshot, not a rendering of the current links, because links are the wrong source of
  truth in three ways. Each rule is pinned by a test in `test/sources.test.mjs` and each was
  checked by breaking the behaviour and watching it fail: the set is **frozen when the run
  starts** (a film takes minutes and the canvas can be rewired meanwhile); a link added
  mid-run is **kept**, since it is the person's preparation for the next run; and a re-run
  that **fails or is stopped** leaves the previous artifact's provenance alone, because that
  is still the artifact on the card. Sources are also identified by **map key, not by a
  record field**: a node read back from `workspace.yml` has no `id` of its own, so using
  `s.id` wrote `#null` for every source of a workspace loaded from disk - the ordinary case,
  since a film is usually made after a restart.
- **Media serving** used to break players in a way that was easy to miss: the file endpoint sent no `content-length` and ignored `Range`, so Chromium reported `duration: null` for a real WAV while an MP4 survived on its own `moov` box — video looked fine, audio looked broken, same cause. Worse, the failure depended on size: a 176 KB clip still reported a duration, a 352 KB one did not. The endpoint now sends a length, advertises `accept-ranges`, and answers `206` with the exact slice; `test/audio.test.mjs` fails (with `Infinity` as the reported duration) if that regresses.
`node test/chain.mjs` is the reproducible entry point for the film: it builds a poster, a WAV,
and then one film card that takes both as its materials, through the ordinary HTTP entry
point, and writes screenshots plus a JSON record of every checked fact. It spends real model
calls, so it is not part of `npm test`. It **exits non-zero** if the finished film's audio
measures silent, and again if the film does not record an audio source or that source is
itself silent - so its exit status is a usable verdict, not just "the agent came back".
Measured on the run recorded here: 4.05 s of audio, peak 11506 over 178739 non-silent
samples, tracking the source WAV at ~0.9997 correlation.
- **`hyperframe`** image/video and the quality presets are passed to the agent as guidance; they were not measured against a real model.
- **The run lifecycle** is covered by `test/lifecycle.test.mjs` and `test/stop-ui.test.mjs`: Stop kills the whole process group (checked against an agent that leaves a writing grandchild), a failure or a Stop is persisted and survives a restart, a run cut off with the server is reported as interrupted, and a missing CLI produces an instruction naming `CODEX_BIN`. Each of those was verified by breaking the behaviour and watching the test go red.
- `test/fake-codex.mjs` and `test/fake-agent.mjs` reproduce the contract (final artifact JSON, exit codes, error events), not the agent's judgment. Stop and a deliberately rejected model were additionally exercised through the real CLI; the rejected card carried the CLI's own message.

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
| `codex-command.json` | The exact CLI invocation for the last run: model, flags, timestamp (the prompt itself is in `prompt.txt`) |
| `versions/` | Every take that is still reachable: `v2-film.mp4` plus `v2-prompt.txt` and `v2-…` script, the frozen material copies, and nothing else |
| `attempts/` | Working directories of recent runs, one per start. A successful run's is dropped; a failed or stopped one is kept (five at most) so you can see what it produced |

Imported files are copied into their new node directory, and they stay constant: no method, no Generate, no longer pointing at the original path. Draft nodes have no directory until the first Generate. The agent may choose an informative artifact filename; the harness rejects any path that escapes the node directory or whose extension does not match the node's type.

**Each run works in `attempts/<start time>/`, not in the card's own folder.** That is a deliberate separation of two things that used to share a directory: what a person puts next to a card (their own reference file, a note, anything they copied in) and what an agent produces. Because they are apart, throwing an attempt away is one recursive delete of a directory the harness created, with no rule like "delete whatever appeared during the run" - which is a rule that cannot tell a creator's file from an agent's and eventually eats one. A file you put in a card's folder keeps its path through any number of failed or stopped attempts.

A run may publish only a file it wrote in its own attempt directory. Naming a kept version, an earlier take, or anything else in the card is rejected with a reason on the card, so an agent cannot hand back an old result as a new one.

## Repository map

```text
server/index.mjs       local HTTP + SSE harness and route table
server/codex.mjs       Codex CLI adapter: one process per node, result validation
server/prompt.mjs      assembles the sectioned prompt from a node and its inputs
server/registry.mjs    filesystem type/method registry
server/workspace.mjs   workspace.yml serialization, atomic write, path safety
server/narration.mjs   verifies a reported narration against its WAV and timeline
voice/                 the offline voice: lexicon, formant synth, WAV I/O, measure, CLI
public/index.html      single-file canvas UI (drag, link, pan, zoom, preview)
prompts/               fixed prompt blocks: shared, output-*, type-*, quality-*
types/                 text, image, audio, video definitions + methods
test/                  node:test suites and fake Codex binaries
vendor/                pinned submodules: hyperframes, remotion skills
docs/                  design.md, impl.md, project-status.md
```

How the pieces talk: the browser sends JSON commands over HTTP, the server mutates the in-memory graph and rewrites `workspace.yml` atomically, and generation results come back as SSE events (`started`, `complete`, `error`) that make the canvas reload. Generation spawns the Codex CLI from the repository root — so `.agents` skills load — with the run's own directory in `HYPERMAKER_NODE_DIR` (and the card's in `HYPERMAKER_CARD_DIR`); the process writes `codex.jsonl` and a final JSON file, and the harness reads only that final file, validates the artifact, and records it in the workspace.

Project source of truth: [`docs/design.md`](docs/design.md) for product behavior, [`docs/impl.md`](docs/impl.md) for architecture. Agents read [`AGENTS.md`](AGENTS.md) first.

## How to develop

```bash
npm install          # Node.js 20+, installs Playwright and the Remotion packages
npm test             # unit + canvas-script + browser + lifecycle tests on fake agents
npm run test:e2e     # canvas tests only; needs a Chromium Playwright can launch
node --check server/index.mjs
git diff --check
```

`npm test` uses `test/fake-codex.mjs`, `test/fake-agent.mjs` and their siblings, so it needs no model access and no credentials. In the tests, set `HYPERMAKER_RESET_WORKSPACE=1` to start from an empty graph.

The browser tests launch Chromium through `test/browser.mjs`. If `npx playwright install` is not an option, point the helper at a Chromium you already have:

```bash
HYPERMAKER_CHROME=/path/to/chrome npm test
```

`CHROME_BIN` works as a fallback. Without either variable Playwright uses its bundled browser, and a missing bundle is reported as `Executable doesn't exist`. The browser tests build every fixture from scratch on a fresh workspace, so they need no network and no credentials.

`node test/journey.mjs` is not part of `npm test`: it walks the ordinary-user path once — create, type, overlap, raise, move, link, unlink, generate, reopen, delete — and screenshots each step into `.tmp/journey/` (or `HYPERMAKER_SHOTS`). It prints, as JSON, what it did at each step, so a person can look at the pictures and the facts instead of reading assertions.

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
- Filesystem registry with four output types and seven methods (`llm`, `remotion`, `hyperframe`, `synth`, `narration`, `tts.cpp`, `bark.cpp`); an artifact also records the materials it was made from.
- Concurrent async generation through the Codex CLI, one run per node, with per-node status over SSE, a real Stop, persisted outcomes and validated artifact/script output.
- Canvas: create, drag, link, unlink, pan, zoom, preview, download, delete-with-confirmation, import.
- Deterministic tests plus a Playwright browser suite running against fake Codex binaries.

**Open work — evidence, not new features**

- **Intelligibility, judged by a person.** The offline voice is measured as speech and its audio is bound to its script, but no independent check has established that a listener understands it, and no recogniser exists on this machine to provide one. Word-level pronunciation is still rule-based and wrong on ordinary prose (`science`, `moved`, `8:30`).
- **A natural voice.** The offline `narration` method speaks and was measured (see above), but it is a formant synthesizer: robotic, English-only. `tts.cpp` and `bark.cpp` name binaries that are not on this machine, so a natural voice is a documented method with no run behind it.
- **Output quality.** No take has been judged on wording, pacing or taste. The tests prove the artifact, the provenance and the recovery path; they say nothing about whether a film is good.
- **The `realistic` preset and long renders.** `realistic` asks for more inspection and repair; neither it nor a multi-minute render has been exercised against a real agent.
- **A creator's own file is protected from clean-up, not from the agent.** The harness never touches a file next to the card, but the agent is given `HYPERMAKER_CARD_DIR` and `--sandbox danger-full-access`, so an agent that decides to tidy that directory can delete it. Nothing stops that today; keeping it out of the agent's hands is the fix, and it is not done.

**Deferred / not planned right now**

- More output types and generation methods.
- Richer graph editing (multi-select, undo, dependency-aware relayout), richer media metadata, collaboration.
- Benchmarks, a project video, or a paper.

The registry boundary exists so that a future experiment (a new type, a different agent) does not require rewriting the core. If someone picks the project up, that is the seam to start from.

## License

Hypermaker is free software under the [GNU Affero General Public License v3.0 or later](LICENSE).

<div align="center">
  <br />
  <strong>Connect the work. Keep the source. Ship the artifact.</strong>
</div>
