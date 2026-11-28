**English** | [简体中文](README.zh-CN.md)

> **Status: an ordinary creative session works, and is now what the tests follow (0.1.0, 2026-11-27).** You can make a film from canvas material, change the material, keep the take you approved, compare two takes, go back to one, and survive a failure, a Stop or a restart without losing the one you liked. `npm test` passes **230/230** with a usable Chromium and a speech engine installed (engine tests that need one skip, saying so, on a machine without it), and a blank canvas can make its first playable film with no model and no account at all (see **The first film needs no account**); [Verification limits](#verification-limits) separates what is real from what a fixture stands in for, says what the offline voice was **measured** to do and that a *natural* voice is still unproven, and that nothing here has been judged on *taste*. A listening sheet is kept as the listener leaves it: an answer on a line, a note that they heard nothing but machine noise, or both. Notes are kept as written and never scored - only the transcript decides what was heard, and the score says which fraction of which words it is.

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

- **The first film needs no account, and that is the default.** Three methods are run by the server itself, and a new card of each type starts on one of them: `plain` writes the sentence you typed, `readaloud` speaks it with the voice in `voice/` at the pace set on the card, and `firstcut` cuts it into an h264 film over the linked poster with its first line as the title. So a blank canvas goes sentence → spoken take → playable film with no Codex, no model and no network, and the film's duration is the narration's own length. The methods that hand a card to a model are still there and still say so: every card prints which kind its method is (`plain: runs here, no model` / `llm: sends this card to a model`), the toolbar's model settings are labelled *for agent cards*, and the press is **Make** on a built-in card and **Generate** on an agent one. Nothing is published on trust either way - a take must measure as speech and say only words the card was given, and a film must last at least as long as its narration and carry *that* narration's voice, checked by extracting the embedded track and correlating every tenth of a second the narration speaks - the number on the card is the worst window out of how many were compared, and a pause written in the script is not counted as speech that has to match (refused with the reason and the time where the sound stops being the narration: silent, a piece of the take missing, truncated, or another take's). Two opposite mistakes are pinned there, because they have opposite verdicts. A complete narration with an ordinary pause between its lines passes - it used to be refused at 0.44 when the check looked only at the take's middle, which is where a first-take script's pause often falls. A film that keeps the first seconds of a narration and goes silent is refused, and the refusal names the second it happens - that one used to be accepted at 0.999. `test/film-alignment.test.mjs` renders one film for real and checks both directions. The film's published record is the composition that rendered it, not a note about it, so the picture can be re-rendered from the same file (`test/first-cut.test.mjs`).
- **A film can have more than one scene, each made and checked without a model.** `titlecard` is a picture method the server runs: one 1280x720 frame drawn from the card's words, colours derived from the words themselves, byte-identical when re-rendered. Link two of those and a narration to a film card and `firstcut` lays them out as scenes in link order, each shown for the speech that belongs to it, with every cut placed on a phrase boundary the voice actually made rather than at an even split - so a change of picture never lands inside a sentence - and each scene captioned with its own words instead of the take's first line. The pictures are then checked the way the sound is: each scene's frame is decoded out of the published film, compared with every picture the film uses, and required to rank as its own scene's picture - so a film showing the first picture for its whole length is refused and named by scene and by card, which the container, the duration and the narration check would all pass. It is a ranking rather than a fixed threshold because walking a real re-cut showed the two pictures of one film agreeing 0.950 and 0.865 with a scene that was not theirs: same layout, different words, only 0.065 apart, which no absolute number separates. One picture is a film of one scene and still works; more than one picture with a narration that has no measured phrase times is refused with the reason rather than cut blindly (`test/scenes.test.mjs`, and `test/scenes-canvas.test.mjs` walks it with the mouse: five cards by double-click, links by dragging title bars, Make). A linked picture whose file has gone is refused at the press, naming the card and the file, and the film already on the canvas keeps its bytes - before that, a supervisor deleted one picture and the next press published a one-scene film over the two-scene take without a word.
- Build a DAG by dragging cards together; only direct inputs enter a downstream prompt.
- Generate plain UTF-8 text with the `llm` method.
- Generate still images and video with the `hyperframe` or `remotion` methods. Both are verified end to end through real Remotion renders (`test/media.test.mjs`, `demo` quality): a 320x180 PNG asserted by signature and by the loaded preview, and a 320x180 h264 MP4 asserted by container and by the `<video>` the browser decodes.
- Generate audio two ways, both with nothing installed. `synth` writes a real WAV of tones, chords, rhythm and sound effects. `narration` reads a card's text out loud — **with a real speech engine if this machine has one, and with the formant synthesizer written in this repository if not.** Install `espeak-ng` (or point `HYPERMAKER_ESPEAK` at its binary, which is also how an unpacked `.deb` prefix works without root), press Generate, and new takes are spoken by it: a recognizer transcribes such a take, taken from a published film's own audio track, at **27 of 30 words (WER 0.100, `understood`)**, against **nothing at all** for the built-in voice. The card says which one read the take — `voice: espeak-ng (en-us) 1.52.0 at 132 words/min`, or `voice: the built-in voice` — because that is the difference between a film a listener can follow and one they cannot, and only one of those is visible on the card. `node voice/render.mjs --engine-check` says what this machine has. **Nothing about a take you already have changes**: the engine is a recorded setting like the reading table, and a take that does not name one is always re-read by the built-in voice, so an approved take still reproduces byte for byte and still verifies. The built-in voice is unchanged and **robotic; it says English words and the common numeral shapes, and a sign, a currency or a magnitude is never dropped** (`8:30` as eight thirty, `1990` as nineteen ninety, `1,200` as one thousand two hundred, `$5` as five dollars, `£0.50` as fifty pence, `$1250` as one thousand two hundred fifty dollars, `40%` as forty percent, `21st` as twenty first, `1,000,000,000,000` as one trillion, `-3.5` as minus three point five, and the pasted minus `−` too; abbreviations, dates, fractions, magnitudes past a trillion and symbols it cannot name — `¥`, `½`, `°` — are refused by name, with the reason, rather than silently read as a different sentence); the card then shows what the audio measured and which phrases it said. Link a text card into an audio card and that text is what gets spoken. **Hearing one sentence of a take costs nothing.** The card lists the phrases the server measured from the published bytes, and each one is a button: it moves the card's own player to that sentence's start and pauses at its end, so checking the line you just changed does not mean scrubbing through the two before it, and it does not re-render or start a run. The lit sentence is read back out of the player rather than remembered from the press, so pausing (or playing, or scrubbing) with the player's own controls leaves the card and the player showing the same state - a supervisor found the opposite on an earlier build, where a paused player left its sentence lit. Once you touch the player it owns the listen: pressing a sentence and then dragging the clock into the next one keeps playing from where you dragged, instead of the earlier sentence's stop firing a few milliseconds later (a supervisor hit exactly that, at 2.93 s on a 5 s take). Edit the text upstream, press Generate again and the earlier take is kept - go back to it and its own sentences are what the buttons describe, because the timings travel with the version they were measured on. The `tts.cpp` and `bark.cpp` methods stay the path to a natural voice, and still need binaries under `~/tts.cpp` and `~/bark.cpp` that this machine does not have — see **Verification limits**.
- **A short film can be made, revised, compared and continued - and the whole flow is one command you can rerun.** `HYPERMAKER_CHROME=/path/to/chrome node test/film-story.mjs` walks the real browser entry with every artifact rendered for real (Remotion pictures and film, this repository's own voice for the narration): a line of text becomes a spoken narration, a poster becomes the title card, and a third card turns both into an h264 film that carries the voice. The person then rewrites the words and the picture, makes a second cut, opens **compare** to see both, goes back to the first cut, restores the narration and poster it used, changes only the instruction, and makes a third cut from that take. Both compare panes play at once and **only one of them sounds**, so two narrated cuts can be told apart by ear rather than by picture alone (see `test/compare-playback.test.mjs`). Every published film is then checked three ways: ffprobe for the container and duration, non-silent samples, and the extracted track correlated against the take's *own frozen narration copy* - which catches a film playing the previous take's voice. A copy of an AAC track starts about 4 ms away from its source, so the check searches a bounded offset and reports both numbers; measured on the three cuts here, 0.999 aligned, 0.017 against a different take. The run leaves `receipt.json`, five screenshots and the workspace behind, so the films can be opened and played afterwards.
- Pick a quality preset — `sketch`, `demo`, `standard`, `artistic`, `realistic` — which changes how much inspection and repair the agent does.
- **A narration's pace is a number you can set, and it is printed on the card.** `node voice/render.mjs … --wpm 150` speaks at 150 words per minute; 110 is deliberate, 150 ordinary, 200 brisk. The tool renders, measures the words per minute from its own output, and re-renders to hit the target - measured across 110-260 wpm on a three-sentence script, it lands within about 1% (`test/pace.test.mjs` asserts 2%). The take records both what was asked for and what it reached, and the card prints `asked 110 words/min, reads at 110.2`. Before this the only pace setting was `--rate`, a *duration multiplier*: a larger number spoke **slower**, the opposite of what its name and its own usage text said, and every pace in its allowed range measured as speech, so a writer following the documentation got the wrong take and nothing said so. `--rate` still means what it always meant, because every published take records the multiplier that made its bytes and has to keep reproducing.
- **A published narration can be read again at another pace from the card, and the earlier take is kept.** A narration card shows a `pace` box (starting at what this take actually reads at) and **Read again**. That is not Generate: it does not start an agent, does not choose a script, and does not change the voice - the server reads the words out of the take's OWN published `timeline.json`, renders them again with `voice/render.mjs` at the requested pace, and publishes only after the same check an agent take passes (`verifyNarration`: the timeline must describe the WAV, the WAV must measure as speech, the words must be the words). The card then says `re-read of narration.wav (147 words/min) · same voice, only the pace changed`, and the take it came from stays as a `kept v1` button one press away. **The stronger claim is measured, not asserted:** the server re-renders the earlier take at the settings its own record names and compares the bytes; when they are identical, "only the pace changed" is a fact about the files, and when an older build's take cannot be reproduced the card says `same words, a new recording` with the reason instead. Asked for 110 from a take reading at 147, the bytes measure 110.9 (`test/repace.test.mjs`). **The first read has a pace box too.** On a `readaloud` card the box is there before the first take, starting at 150 words a minute, and the number typed is the number sent with the press: asked for 110, the first take reads 110.9 and the card says `the words from #2 - read at 110 words a minute`. After a take exists the box describes the bytes instead and **Read again** re-reads them, so the same number means an intention before the first press and a measurement after it. Stopping a re-read keeps the approved take byte for byte - that was broken in the first version of this route and is now pinned in `test/repace.test.mjs` and `test/repace-ui.test.mjs`.
- **The method list follows the card's type, and says which methods can run here.** Switching a card's output type refills its method list; a method whose local tool is missing stays selectable but is labelled `(needs a local install)`, and pressing Generate on it is refused with a sentence naming the missing binary and the method that works instead. Before this, switching a text card to audio left `llm` in the dropdown (so the offline `synth` method could not be picked at all) while the server would have run `bark.cpp`, whose binary does not exist.
- Bring your own file onto the canvas as a constant node (no method, no Generate): **+ File**, or drop one or more files on empty canvas. The bytes are copied into the node's directory and the name is reduced to a safe base name. Dropping a file on a supplied card replaces that card's material as a kept version, so its links and the old file survive; a card a method produced refuses it by name. That gesture is walked through the browser and into the finished film by `test/story-replace-material.mjs`: a film of two chosen pictures is cut, a third picture is dropped on one of them, Make is pressed again with nothing re-wired, and the new film's own second act measures **0.905 against the picture just dropped** where it measured **0.972 against the one it replaced** (that picture falls to -0.056), while act one is unchanged at 0.909, the narration is the same take byte for byte, and the earlier cut and the replaced picture are both still there. The old film's acts measure 0.909 and 0.972 against their own pictures, and 0.507 and 0.547 against the other, so the measurement can tell the pictures apart before it is asked to. The pictures are drawn, not photographed, and no person has looked at the result. Clone and relayout are still HTTP-only, and `POST /api/import` still takes a path on this machine.
- Run several generations concurrently, one per card; each card shows its own `draft` / `running` / `idle` / `cancelled` / `error` state over SSE. While a card is running it offers **Stop**, which ends the agent and everything it started; a second Generate on the same card is refused rather than starting a second agent - and the card counts as running from the press itself, including the moment its material is being copied, so two open canvases pressing together bill one run and Stop always has one target.
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
- **Narration is measured, not asserted.** The offline voice is measured on the bytes, not on a function having been called. `node voice/render.mjs --check file.wav --words "…"` reports what it heard, and a published narration is checked three times before it appears: the `timeline.json` beside the WAV must describe *this* file (phrases contiguous, adding up to its real length, every word pronounceable by the shipped voice), the published bytes must **be that recording** - rendering is deterministic, so the server re-renders each of the timeline's phrases alone and compares it with the slice of the file the timeline places it at, in 25 ms frames, requiring the *worst* frame to agree (1.000 for the same phrase; -0.344 for one word changed; -0.297 for a swapped ending clause; a phrase is refused below 0.5, and a take is as bound as its weakest phrase). The tool checks its own output the same way before returning it, and records the rate and pitch the samples were actually made with rather than a rounded copy - a take the server would refuse is a bug in the tool, and it says so instead of handing it over. A record written by an older build to three decimals is recovered inside that precision and must then match at 0.95, so an imprecise record cannot be used to smuggle in different words - and every spoken word must appear, in order, in the material the card was given, **and** the file itself must measure as speech — periodic rather than noisy, syllable onsets for the words it claims, and more than one vowel region. Sentence "The sea at night is never still. It carries every colour of the sky." measures 14 words, 19 syllables, 5.98 s, peak 29489, 87% voiced frames, 38 onsets for 19 syllables and several vowel regions. The onset count is a *floor*, roughly two rises per syllable — pinning it to one per syllable would be fitting the threshold to its own answer. The check that separates speech from a plausible impostor is the vowel regions: a 220 Hz tone amplitude-modulated at 4 Hz rings up 15 onsets, as many as a sentence, and never leaves one formant pair. `test/voice.test.mjs` pins tone, noise, sweep and silence as failures; `test/narration.test.mjs` drives a real WAV through a real Remotion film and measures the film's own audio track; `test/narration.test.mjs` also reopens the workspace after a restart and reads the phrase record back. **Where the words themselves come from.** A listener stumbles on a mispronounced word long before on prosody, so the word is where the effort went. Pronunciation is read from a **vendored CMU pronouncing dictionary** (`vendor/cmudict/`, BSD, regenerable with `node voice/build-dict.mjs`), not assembled from spelling rules. This was a measured defect, not a taste: run over a paragraph of ordinary English, the earlier rule engine read **30 of the 110 distinct words differently from the dictionary** - `science` as "S-S-IY-N-S", `machine` as "match-ain", `change` with no `j`, `music` as "M-AH-S-IH-K", `wanted` as "W-AE-N-T-EH-D" - and every one of those is a word a listener hears as a different word. `node voice/check-pronunciation.mjs` recounts it and is the command to distrust with: it compares the shipped readings with an independent dictionary you pass in (`--dict /path/to/cmudict.dict`), because comparing the vendored table with itself would measure nothing. Homographs are read the way narration uses them (`read` as "reed", `live` as the verb, `wind` as the moving air, `close` as "klohz") from a four-word table that is only allowed to name readings the dictionary actually lists. A word neither the dictionary nor the rules can say is refused by name; an entry with no vowel at all (`hmm`) is refused rather than rendered as a click. **Stress comes from the same dictionary.** The dictionary marks which syllable of a word carries the primary stress, and the engine used to throw that away and stress syllable one every time - measured on the sample prose, 7 of its 44 multi-syllable words were stressed on the wrong syllable (`toward`, `without`, `before`, `about`, `machine`, `against`, `around`), which is the other half of why a sentence sounded like a machine reading a list. The marks are now vendored beside the pronunciations (`vendor/cmudict/stress.txt.gz`, 35 KB for the 34,858 words that need a note; a word stressed on its first syllable needs no entry at all, and absence means exactly that) and applied by a **new** reading table, `cmudict-2`, which is this build's default. It is a new table rather than an edit to `cmudict-1` for the reason the section below explains at length: a published take has to keep reproducing from the table that made it. `rules-1` and `cmudict-1` therefore still render **byte for byte** what they always did, which a test pins by hash. Whether the emphasis landed where the dictionary says is then *read back out of the file*, not assumed: **`node voice/check-stress.mjs --wav take.wav --timeline take.json`** re-renders every possible stress position and reports the one that reproduces the samples exactly, then compares it with the dictionary's mark. It is an identity, not a score with a threshold under it, and it says which words disagree (exit status zero when every word is where the dictionary puts it, four when the file was read but a word is stressed elsewhere, two when the file could not be read at all). The first version of that check cut the energy envelope at its deepest dips and called the loudest piece stressed; measured against the dictionary it was wrong - one piece instead of two in `toward` and `about`, and a loud `sh` outweighing `machine`'s vowel - so it was replaced rather than tuned. This is the same technique the take check uses, and it is the whole reason the audio is reproducible in the first place.

**A take keeps the reading table that made it, and an older take still verifies.** The pronunciation fix created a defect a reviewer found on the published build, and it is worth stating plainly because the failure was the opposite of the one being fixed: a take made by the pre-dictionary voice, re-checked by the build that added the dictionary, was reported as a lie about its own script - "phrase 1 (…"Science can change the way a machine works.") is 3.71s of speech, but the timeline says it takes 3.52s". The audio was honest. It was the rule engine's reading, and the checker re-rendered today's dictionary and got a longer file, so an improvement in how the voice pronounces turned every older recording into a false accusation. The reading table is now a **versioned render setting** beside rate and pitch: `rules-1` is the engine exactly as it shipped (frozen, and pinned to the sample: it renders that sentence to the same 77,635 samples the old build published), `cmudict-1` is the dictionary's. A take records `voice.readings`; a take that predates the field, or names a table this build does not have, is checked against every table the build has and is accepted only on an **exact** reproduction - never on a near miss. That keeps the two things apart that matter: an upgrade in pronunciation passes and says which table made the audio, while one take's audio under another take's script still fails, because the words, their order, their start times and the file must all still be the same arrangement. **`node voice/verify-take.mjs <node-dir>`** is the command for a card you already have: it re-runs the same check the server refuses a bad take with, and prints either `verifies` with the worst-frame agreement and the table that made the audio, or `DOES NOT VERIFY` with the phrase and moment that disagree (exit status zero when it verifies, three when it does not). It reads a published card as it is on disk - the take under `versions/` with the `timeline.json` the server now keeps beside it, named for the same take (`v2-narration.wav` and `v2-narration.timeline.json`) - so this works on the card you are looking at, not only on a run's scratch directory. Which take it checks is the one **the canvas is showing**, read from the card's own record; a card with two versions therefore verifies the one you selected, and the output says so. Naming a WAV instead checks that file against its own record, whatever the card is showing. If the record cannot be read it says it guessed ("NOT the take the card is showing: … the newest published take (`v10-narration.wav`, of 10 takes on this card) was checked instead") rather than presenting a guess as your take. This was not right the first three times, and each was found by running the command rather than reading it: on a two-version card with the first one restored it verified the *newer* file because it sorted filenames; a named WAV could not find the record sitting next to it; and with the record absent - two takes and their timelines copied into an archive - the fallback sorted filenames *as strings*, where `v9-` comes after `v10-`, so it verified v9 and called it the newest. The publish number is an ordinal and is now compared as one, and the guess names the file it picked, so a reader can check it at a glance. A supervisor then found a fourth case at the same entry point, and this one was not about *which* file was read but about what the check did with an honest one: a take whose timeline had every start and duration kept to **two decimal places** - `4.38` for `4.3835147`, which is what the card displays - was refused as "not the sound these words make", with the phrases blamed for a number that had merely been rounded. The cause was structural, not a loose tolerance: phrases are joined with no gap, so a start is exactly the sum of the renders before it, and the only thing in doubt is how many places the record was written to. `writtenSlack` now derives the permitted half-place from the number itself (two decimals is 110 samples at 22.05 kHz; a value written to the sample is exact; a whole-second record is capped at 0.05 s, because that is a different claim rather than an imprecise one), and the phrase is looked for inside that window - coarse correlation to find the position, then the same frame test to decide whether those words are there. Nothing is loosened: a phrase can only slide inside a rounding, and an edited one still disagrees frame for frame wherever it lands. Two further distinctions came out of the same review. A take accepted on a realigned record **says so** ("2 of 4 phrase(s) were found up to 96 samples from where the record puts them: this timeline rounded its start times"), because a rounded record must not be presented as an exact one. And when the *words* are right but the start time is wrong - the supervisor moved one phrase 40 ms and the take was correctly refused - the message now says that instead of accusing the script: the file is searched for the phrase, and an **exact** match somewhere else is reported as "the right words, but not where the timeline puts them … the start time written for this phrase is wrong", since a person told "the words are wrong" would rewrite a sentence that is already correct. Which of these a refusal is depends on evidence, never on a guess: the same four-sentence old-rules take in a detached directory verifies with its exact timeline and with its two-decimal one (both 1.000), and still fails with one word changed, with an ending changed, and with a start moved 40 ms. Before this slice it did not: the timeline lived only in the attempt directory, which is dropped when the run succeeds, and the sweep that clears unreferenced files deleted the copy as well. Found by running the command against a real workspace, and pinned by a test that re-verifies after a restart. Reopening a workspace never re-checks a take on its own - a take you approved should play tomorrow - so this is how you ask instead of trusting.

**What this does not prove:** the voice is robotic, not natural, and its quality on a longer script has not been judged. It is also worth being precise about the word *intelligible*: everything above is a measurement of the signal, and a measurement can show that the formants move, the syllables are there and the file says what its script says - it cannot show that a person understood a sentence. There *is* a recogniser for that now, and it is what changed this verdict: see the intelligibility entry under **Verification limits**, where an installed engine's take is transcribed from a published film at WER 0.100 and the built-in voice's at 1.0. What a recogniser still cannot say is whether a person followed it - that claim rests on listening, and there is a tool for exactly that: **`node voice/listening-test.mjs --out listen-out`** renders the real voice and a real h264 film carrying it, writes a **blank** transcript sheet (one numbered line per sentence, no words) and keeps the script in `key.txt` so the listener cannot see the answer while writing (a re-run into a directory whose sheet already holds anything a listener wrote is refused, and that includes a note under Notes with every line blank, because "I could only hear a machine" is a finding and was once discarded as scratch; `--fresh` is the explicit way to discard a sheet - and the film is built in a scratch directory of its own outside your output directory and that scratch is deleted afterwards, so repeating the check costs nothing but the render and leaves nothing else behind - files you already keep under `build/` or `public/` there are never touched); `node voice/listening-test.mjs --score listen-out` then reports **word accuracy** and names the words that were misheard. It scores by sound rather than spelling (`color` for `colour` is a hit, because that is the same word heard), and a blank line counts as missed rather than being dropped - the commonest real answer is "I could not make that out", and it has to cost something. Only the transcript decides the score: a note under Notes, including one that quotes a line in the sheet's own `**Line 2.**` shape to comment on it, is kept verbatim in `score.json` and never counted as an answer - it once turned a half-heard sheet into 100%. A quick single sentence is still `node voice/render.mjs --text "…" --out out.wav`, then play it. What has changed is what a listener now has to overcome. Pronunciation is the dictionary's and the emphasis now falls on the syllable the dictionary marks, so what remains is the robotic timbre - not the words, and not a flat metre on every long word. That is a claim about the signal, measured above by re-rendering the file; it is **not** a claim that the stress is *audible to a person*, which is the listener's judgement the listening test exists to record. **In the built-in voice**, numerals are read as a person reads them (`8:30` is eight thirty, `1990` is nineteen ninety, `1,200` is one thousand two hundred, `$5` is five dollars, `£0.50` is fifty pence, `$1250` is one thousand two hundred fifty dollars, `40%` is forty percent, `1,000,000,000,000` is one trillion, `-3.5` is minus three point five) - before this, an ordinary line with a time in it could not be narrated at all, and one with a year in it said "one nine nine zero". **An installed engine does its own reading of these and this project does not correct it**: measured, eSpeak says `$1250` as *dollar one thousand two hundred fifty* and `£0.50` as *pound zero point five zero*. The trade is deliberate - the engine is the voice that can be followed, and its front end is what a listener hears - but a card narrated by the engine does not get the readings listed above.

Two rounds of checking the reader's own output found the reading itself going wrong. Neither round was a listening session: each line was synthesized with the real reader, and the words the engine chose - and the bytes it published - were compared with what the line says. That is enough to catch a wrong amount without hearing anything, because a wrong reading is a different word list and the same words render byte for byte to the same audio; the reviewer wrote the lines and reported the mismatched readings. The first round: `$1250` said as *twelve fifty dollars* (a price read as a year), `£0.50` as *fifty cents* (one currency's subunit said for another's), a trillion as *one* (the scale table dropped the rest without a sound), and `-3.5` without its minus. The second round, on a script pasted from a page: the true minus sign `−` read as **positive**, `¥500` and `₹500` said as *five hundred* (the currency silently dropped), and `½` vanishing entirely. All four arithmetic defects and the pasted minus are now read correctly; every symbol the voice cannot name is refused **with the reason**, because a named symbol is something a writer can replace and a line that quietly plays a different sentence is not. These are new readings under a new frozen table, `cmudict-4`: the previous table's takes still reproduce byte for byte, wrong readings included, which `test/numbers-fidelity.test.mjs` checks by rendering an old take and re-verifying it through `voice/verify-take.mjs`. Shapes still refused by name: abbreviations (`km`, `ft`), slash-written dates, ranges (`1990-1995`), fractions, magnitudes past a trillion, and currencies or symbols the voice cannot say (`¥`, `₹`, `½`, `°`). The built-in voice has no idea which `read` a script meant beyond the table above, and a secondary stress is not modelled - only the primary one. An installed speech engine brings its own front end and reads those shapes itself; measured on eSpeak NG 1.52.0, `$1250` is one thousand two hundred fifty, `1990` is nineteen ninety, `40%` is forty percent and `-3.5` is minus three point five, without this repository's numeral layer being involved. The *refusals* still hold on both paths, because the check that a line is sayable runs before any mouth does: `¥500` is refused by name whether an engine is installed or not, rather than being read as five hundred by one voice and refused by the other. For a natural voice, `tts.cpp` and `bark.cpp` name binaries (`~/tts.cpp/build/bin/tts-cli`, `~/bark.cpp/build/examples/main/main`) that this machine does not have, so no natural-voice run has been taken.
- **A creator's own file next to a card is put back, and the run says it had to be.**
  The limit this section used to state - "protected from the harness, not from the
  agent" - is closed in both directions, and the old probe is still the shape of the
  test. A run no longer works inside the card at all: it gets
  `<workdir>/.runs/<card>/<start>`, and `HYPERMAKER_CARD_DIR` is no longer handed to it
  (the card's path is still in the prompt as text, because a real agent needs to read
  the linked material). Before the agent starts, every file the card holds is **copied**
  into `<run>/.guard` and hashed. Afterwards - success, Stop, failure, or the next
  startup when the server died - each file is hashed again and put back if it is gone or
  different, and the card says which file had to be restored. `test/keep-card.test.mjs`
  drives each of those through the HTTP entry point with a stand-in agent that deletes a
  file, deletes one three levels down, opens an existing file and writes over it, or
  hangs so the run can be stopped or killed mid-damage. The copies are the point: the
  first version of this used hardlinks, and a supervisor named the hole before it
  shipped - the commonest way a tool saves is to reopen the existing file and write into
  it, and a hardlink shares that content, so the saved copy would have changed too and
  the comparison would have called the file untouched. Disabling the guard makes exactly
  the five damage tests fail and leaves the clean-run test green.

  A file above 64 MiB - a short video clip is ordinary material - is kept by a link
  instead of a copy: a deletion is still repaired, and a rewrite of its contents in
  place is the one thing not covered. That used to be invisible; a supervisor put a
  65 MiB clip next to a card and the run said nothing. The press now answers with the
  sentence, it is stored on the card and rebuilt when the page is reopened - a supervisor
  reloaded mid-render and found it gone from the canvas while the server still had it -
  and it is silent when every file is small enough to copy. The card's take is protected by
  publishing rather than by this - a run never writes to `versions/`.
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
  Comparing used to mean swapping the card and remembering what it looked like. Only one
  player sounds at a time: starting one pauses any other, so two narrated takes can be told
  apart by ear. Until it did, both panes of two narrated films played together and the panel
  compared pictures while two voices spoke over each other - found by walking the short-film
  story, not by reading the code.
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

## Write a two-act film from your pictures

Use **+ File** to bring in two PNG or JPEG files. Create a text card, select `two-act`, and link the image cards to it in playback order. Write a short intent and press **Generate**. This sends frozen copies of the two images and your brief to your configured Codex CLI route; the result is one line of English voiceover per act. Choose **Edit script locally** to bring the draft into the text box, edit the two lines, and press **Make**. The draft is kept as a version and this edit does not call a model.

Link the resulting text to a `readaloud` card and press **Make**. Link the voice and both pictures, in the same picture order, to a `firstcut` video card and press **Make** to play the result. To swap a scene later, drop the new picture onto its image card and press **Make** on the film again. This doesn't require re-linking the graph, drafting again or re-reading the narration.

Leave **Codex model** blank and **Effort** at **Configured in Codex** to use the CLI's defaults. Launch Hypermaker from the environment where you normally run Codex (`CODEX_BIN` can point to the installed binary). If you normally pass a model explicitly, enter its exact ID in **Codex model**; use one your configured route supports for images. These settings apply only to agent methods.

On this host the real image request hit route discovery and model-refresh errors and produced no script; the full canvas workflow was verified separately against a simulated CLI. If drafting fails, **Write script locally** switches to `plain` so you can replace your brief with two script lines and press **Make**. You can also start with `plain`. Neither path calls a model. See [evidence and rerun instructions](docs/evidence/two-act-script.md).

## Make a two-act film without a speech engine

1. Press **+ File** and choose two of your own PNG/JPEG pictures, one at a time or both at once. Each becomes a picture card, and choosing again finds free space instead of stacking on the first.
2. In a `plain` text card, write two short lines, one per act, and press **Make**.
3. Link the text and then both pictures to a `firstcut` video card, with the pictures in act order. Do not link an audio card.
4. The video card says **Captions only (no audio)**. Press **Make**, then play or download the MP4. The captions are part of the picture; no separate subtitle file is needed. Each line has at least three seconds on screen; keep each line within 112 characters.
5. Drop a different picture on the second picture card and press **Make** on the video again. The links and the first scene stay put. Use the **kept** version button to bring back the original movie; the newer picture stays in place for your next cut.

This needs local Chromium for rendering, but no model, speech engine, remote upload or account. Imported pictures stay on your machine; their cards show a replace hint instead of generation controls. If you already have a usable speech engine and want narration, make a `readaloud` take and link that audio to the video instead. [Replay the local-picture walkthrough](docs/evidence/local-picture-cut.md), or [make your own title cards on the canvas](docs/evidence/captions-only.md).

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
| `codex.jsonl` | Codex stdout/stderr for general agent methods; `two-act` stores only a stage/outcome, elapsed-time and usage summary, not raw provider output |
| `codex-command.json` | The CLI invocation for general methods; `two-act` records only the route kind, requested model/effort, image count and timestamp (the prompt itself is in `prompt.txt`) |
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

How the pieces talk: the browser sends JSON commands over HTTP, the server mutates the in-memory graph and rewrites `workspace.yml` atomically, and generation results come back as SSE events (`started`, `complete`, `error`) that make the canvas reload. Generation spawns the Codex CLI from the repository root — so `.agents` skills load — with the run's own directory (outside the card, under `.runs/`) in `HYPERMAKER_NODE_DIR`; the process writes `codex.jsonl` and a final JSON file, and the harness reads only that final file, validates the artifact, and records it in the workspace.

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

On WSL the checkout may live on a Windows drive (`/mnt/d/…`), but the suite's scratch space must not: Chromium cannot create its profile there, so if `TMPDIR` points into the checkout every browser case fails to launch with `Target page, context or browser has been closed` — measured as 137 pass / 39 fail / 1 skip — which reads like broken code. Point it at a Linux filesystem instead:

```bash
TMPDIR=$(mktemp -d /var/tmp/hypermaker-XXXX) npm test     # measured: 230/230 with a browser and espeak-ng
```

Two details make that one line copyable. The directory is created by the command, because `TMPDIR` naming a path that does not exist fails before any test starts. And the template is given explicitly, because bare `mktemp -d` honours an existing `TMPDIR` — if yours already points at the Windows mount, the new directory would be created there and every browser case would still fail. To keep one directory across runs instead: `mkdir -p /var/tmp/hypermaker-tmp` once, then `TMPDIR=/var/tmp/hypermaker-tmp npm test`.

The default `/tmp` is fine when it has room. One case also needs a filesystem that enforces permission bits (*a workspace that cannot be written is refused*): on DrvFs `chmod` is accepted and then ignored, so that case reports itself skipped, naming the fixture directory and `TMPDIR` as the remedy, instead of failing. A skipped case prints a reason and is never counted as a pass.

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

- **Narration: better recognition on this sample with eSpeak NG; no human listening result.** A film's narration is now measured by a recognizer **from the published film's own audio track**, and the two voices differ completely. `test/story-engine-voice.mjs` walks the canvas from a blank workspace - two pictures brought in with **+ File**, a four-line two-act story, a narration at 150 words a minute, the film pressed into existence - then decodes the MP4 and transcribes its AAC track: spoken by **espeak-ng (en-us) 1.52.0**, asked 150 words a minute and **reading 149.7**, the recognizer recovered **27 of 30 words (WER 0.100)** and its verdict is `understood`. The same walk with the built-in voice measures **WER 1.0 and hears nothing**. So: **install espeak-ng** (or point `HYPERMAKER_ESPEAK` at it, which is also how an unpacked `.deb` prefix works with no root) and new takes speak with it - the card says `voice: espeak-ng (en-us) 1.52.0`; without one, the built-in voice still speaks and the card says `the built-in voice`, so nobody is left wondering why their film sounds like that. `node voice/render.mjs --engine-check` says what this machine has. **No stored take changed**: `engine` is a recorded field like the reading table, and absent means the built-in voice always, so takes made before the field existed still reproduce byte for byte - measured by running the voice tests with an engine installed (all 34 pass; without one 29 pass and 5 skip, saying why). A take that names an engine is refused by name if that engine, its version or its voice is missing, never silently re-rendered by another. The American voice was chosen by measurement, not taste: on the project's own 69-word corpus `en-us` scores 0.043 where `en` and `en-gb` score 0.116. The engine is not vendored (25 MB of voice data). The three remaining misheard words were measured, not assumed, and the count started at four: one of them (`harbour` heard as "harbor") was **this repository's own rounding**, not the engine - the WAV reader decoded at `/32768` while the writer encoded at `*32767`, one step on 461 of 121800 samples, and fixing that took this walk from 0.133 to 0.100 (pinned by a test that the take's audio payload is byte-identical to eSpeak's). What is left (`gull` as "girl", `drops` as "raps") is the engine's front end and a small recognizer - not the AAC encoder. The phrase silence was measured three times and the answer depends on speed: at engine speed 116 the project's own inter-phrase tail costs the word "By" (0.067 for eSpeak's single call, 0.100 for the product's per-phrase join, 0.067 with the tails trimmed), but at the 132 this build actually speaks, none of the tested tail caps improved WER and the engine's own single call says "A evening" too. So it is not a defect this build can remove at the pace it ships. **Not the pace, though only in the narrow sense** - an earlier version of this entry said "not the pace" and a review disproved it: at 100, 132, 175 and 200 wpm this story scores 0.067, 0.100, 0.200 and 0.167 with different words failing each time, so a faster read is measurably worse and 150 is where this walk sits. What a recognizer cannot settle is whether a *person* follows it, and `voice/listening-test.mjs` is still the sheet for that, still unanswered.

The defect as it stood on a machine with no engine, kept because its numbers are what a future change is judged against: the offline voice is measured as speech and its audio is bound to its script, but no independent check has established that a listener understands it - and two independent measurements show that none of that means it is understood. An automatic recognizer (faster-whisper tiny.en) transcribed this voice's narration as **nothing at all** - zero segments, no words - on a single sentence and on this project's own eight-sentence, 69-word corpus: word error rate 1.0, the worst possible. The same recognizer on eSpeak saying the same 69 words made **3 word errors (WER 0.043)**. That is not "slightly hard to understand": the output is not accepted as speech. `node voice/asr-check.mjs` reproduces the measurement with a recognizer you supply, and `voice/listening-test.mjs` remains the way for a person to judge it: a recognizer finding no speech is strong evidence a listener cannot follow the words, and it is not the same claim as a person having listened. Two attempts at repair were measured and reverted - routing consonant noise around the vowel formants, and raising consonant gain - because the spectrum did not improve (2-4 kHz went from -25 dB to -29 dB relative to eSpeak's 0 dB) and the recognizer's reading did not change. Fixing this properly means replacing the acoustic model, not tuning it. Pronunciation comes from the vendored CMU dictionary (30 of the 110 sampled words were wrong under the old rules) and the primary stress now comes from the dictionary's marks too, so what a listener must still overcome is the robotic timbre - but secondary stress is not modelled, and the voice is plainly a formant synthesizer. Numerals are now read as words rather than digit by digit, which removes one class of wrong sentence without settling whether a person follows it.
- **A natural voice.** With an engine installed the narration is understood but still sounds like a machine - eSpeak is a formant synthesizer too, and a better one rather than a natural one. On a machine without one the voice is this repository's own formant synthesizer: robotic, English-only. `tts.cpp` and `bark.cpp` name binaries that are not on this machine, so a *natural* voice is a documented method with no run behind it.
- **Output quality.** No take has been judged on wording, pacing or taste. The tests prove the artifact, the provenance and the recovery path; they say nothing about whether a film is good.
- **The `realistic` preset and long renders.** `realistic` asks for more inspection and repair; neither it nor a multi-minute render has been exercised against a real agent.
- **A large file is protected against deletion, not against an in-place rewrite.** Files up to 64 MiB are copied before a run and put back if the run deletes or rewrites them; a larger file is hardlinked instead, so a deletion is repaired but a rewrite of its contents is not. This is stated at the press and kept on the card, so it is a boundary a person is told about rather than one they discover.

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
