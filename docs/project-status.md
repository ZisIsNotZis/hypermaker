# Project status

## Classification

`useful`, active: a runnable, inspectable local application for composing generated
artifacts. The canvas, the generation path and the retry/version path are covered by
tests and by a handful of real Codex CLI runs.

## Status

Canvas and generation lifecycle re-verified 2026-11-27 on `fix/canvas-usable`.
The last upstream commit planned work; this milestone closed the gap between the
canvas being reachable and the canvas being usable, and then checked the one path
a local fixture cannot stand in for: a real Codex CLI run.

Development continues, but the open work is **evidence, not features**: output
quality has not been judged, a *natural* voice has never run, `realistic` and long
renders are unexercised, and a creator's file next to a card is protected from the
harness's clean-up but not from the agent itself. The offline voice does run and is
measured — see the narration rows below — but "intelligible" is not one of the measured
facts: it is a judgement only a listener can make, and nothing here has made it. What did
change is that the words themselves are now the dictionary's rather than a rule engine's
guess, and that the primary stress comes from the dictionary's marks instead of always
falling on the first syllable - both read back out of the file rather than asserted. So what
a listener has to overcome is the robotic timbre, not a word said wrong and not a flat metre
on every long word; whether that emphasis is *audible* is still only a listener's call. `voice/listening-test.mjs` exists so that judgement can be recorded as a number
instead of an opinion; it has not been run against a person yet. The sections below say what
each claim rests on.

## What is real and what is simulated

The distinction matters because a first-time reader reasonably assumes "tests
pass" means "generation works". Both are true, but for different reasons.

| Path | Exercised by | Simulated part | Real part |
| --- | --- | --- | --- |
| Text artifact | `test/e2e.test.mjs`, one real run | the agent's words | CLI spawn, prompt assembly, node directory, artifact validation, canvas preview |
| Image (PNG) | `test/media.test.mjs` | the agent's creative choice | Remotion bundling and `renderStill`, a real PNG, the decoded `<img>` |
| Video (MP4) | `test/media.test.mjs` | two-frame composition, codec choice | Remotion `renderMedia` with h264, a real `ftyp`/`avc1`/`moov` file, the decoded `<video>` |
| Run lifecycle (Stop, failure, restart) | `test/lifecycle.test.mjs`, `test/stop-ui.test.mjs`, real-CLI checks | the agent's slowness and exit codes | process-group Stop, persisted outcome, the card's visible reason |
| Test isolation | `test/server.mjs` | — | OS-assigned ports and process-group teardown, so a crashed fixture cannot answer a later test |
| Text via **real Codex CLI** | 2026-11-27, this machine | nothing | one `codex exec` run: wrote and ran `generate.mjs`, produced a `.txt` artifact, 37 s, 48k input tokens |
| Film from canvas material | `test/film.test.mjs`, one real run | the agent's direction | a real h264 MP4 whose embedded AAC track was measured audible (4.05 s, peak 11506 over 178752 samples, ~0.9997 correlated with the source WAV) |
| Artifact provenance | `test/sources.test.mjs` | — | frozen-at-start sources, kept mid-run links, failure-safe, key-based ids |
| Audio artifact (`synth`) | `test/audio.test.mjs`, one real run | the agent's taste in sound | PCM synthesis, RIFF header, file endpoint, the decoded `<audio>` with a real duration |
| Audio narration (`narration`, offline) | `test/voice.test.mjs`, `test/bind.test.mjs`, `test/narration.test.mjs` | which words to read | a formant synthesizer in `voice/`, a real WAV, the server re-rendering each timeline phrase separately and requiring every audible frame of the published bytes to match it (same phrase 1.000, worst frame refused below 0.5), so a long take's shared beginning cannot hide a changed ending, every spoken word checked against the frozen material, the film's own extracted track measured, the phrase record and source card read back after a restart |
| Hearing one sentence of a take | `test/narration.test.mjs` (real browser, real WAV) | the words chosen | the card lists the phrases the server measured from the published bytes, and each is a button that seeks the card's own player to that phrase's start and pauses within a frame of its end. Tested by the player's clock, not by the button existing: a control that renders the buttons but does not wire the click fails at the "is it playing" wait. The same test then edits one line upstream, generates a second take, keeps both, goes back to the first, and checks the buttons describe *that* take's own words and that `voice/verify-take.mjs` still verifies the one on the card. Nothing is re-rendered or re-run to listen, and no interface was added beyond the per-phrase buttons. The lit sentence is derived from the player's `currentTime` and `paused` on every frame and on its own events, never remembered from the press: a supervisor played sentence 2, paused in the player, and an earlier build left the chip lit with the clock frozen. Ignoring `paused` fails that assertion exactly, which is the negative control for it. The two ways of listening now join up: pressing a sentence and then taking the player over (playing, pausing, dragging the clock) makes the player's clock the one that counts. A supervisor heard sentence 1, dragged into sentence 2 and the sound stopped 5 ms after the drag, because sentence 1's armed end had already passed and its frame watch paused the player - measured at 2.93 s, the exact place the drag had landed. The watch now compares the clock's movement with the wall time since the frame before, so a sentence ending (~16 ms) pauses and a drag (seconds) hands over; the test drags into sentence 2, asserts a second of sound still comes from there, then presses sentence 1 again and asserts it still stops at its own measured end. Removing that one comparison fails the drag assertion at 2.93 s and nothing else |
| A listening run that can be repeated | `test/voice.test.mjs` | the film (real Remotion render, not run in `npm test`) | running `voice/listening-test.mjs` twice used to leave 20 MB of webpack output per run in the system temp directory and overwrite a filled-in sheet without a word. The bundle and the `public/` copy of the track are now made in a scratch directory of the run's own making, outside the output directory, and removed whole (an earlier attempt built inside `--out` and deleted the user's own `build/` and `public/`, which a supervisor had real files in; the test now puts files there and requires them back unchanged), and a directory whose `transcript.md` already has answers is refused (exit 3, naming `--score` and `--fresh`) because that sheet is the one artifact here that only listening can make. Measured: 19 stale bundles, 395 MB, from earlier runs; a repeat run now leaves `listen.wav`, `listen.mp4`, `film-track.wav`, `transcript.md`, `key.txt` and the entry file, and nothing else |
| An old take after a voice upgrade | `test/bind.test.mjs`, `node voice/verify-take.mjs` | — | the reading table is a versioned render setting (`rules-1` frozen, `cmudict-1` the dictionary); a take is checked against every table this build has and accepted only on an exact reproduction with all other readings held fixed, so an upgrade in pronunciation passes while one take's audio under another take's script is still refused; `rules-1` is pinned to the shipped sample count, and a stored take can be re-verified from the command line: a card directory verifies the take its own record says is on the canvas, a named WAV verifies against its own record, and when no record exists it falls back to the newest *publish* by ordinal (not by filename, where `v9-` sorts after `v10-`) and names the file it picked |
| A record written to the precision a card shows | `test/bind.test.mjs`, `node voice/verify-take.mjs` | — | phrases are joined with no gap, so a start is exactly the sum of the renders before it and the only thing in doubt is how many places the record was written to; `writtenSlack` derives the permitted half-place from the number itself (`4.38` permits 110 samples at 22.05 kHz, a whole-second record is capped at 0.05 s), and the alignment is searched inside that window coarse-then-fine, accepted only on an exact frame reproduction. A supervisor's four-sentence old-rules take: exact and two-decimal timelines both verify at 1.000, one changed word is refused, and a start deliberately moved 40 ms is refused *and reported as a wrong start time* rather than as wrong words, because the phrase is found elsewhere in the file at an exact match. Before this, a rounded record was refused with the script blamed |
| Numbers in a script | `test/numbers.test.mjs`, `voice/numbers.mjs` | which shape an unknown abbreviation or date is | a written numeral is read as a person says it: `8:30` is eight thirty, `1990` is nineteen ninety, `1,200` is one thousand two hundred, `$5` is five dollars, `40%` is forty percent, `21st` is twenty first. Measured on the previous build, those six lines were either **refused** (`8:30`, `1,200`, `21st` could not be rendered at all) or said a different sentence (`1990` as "one nine nine zero", `$5` as "five", `40%` as "four zero"). The reading is a new frozen set, `cmudict-3`, so `rules-1`/`cmudict-1`/`cmudict-2` keep producing the byte-identical audio their takes sound like - a take made by `cmudict-2` of a sentence with a year in it still verifies and is named as `cmudict-2`. Shapes the reader does not handle (`km`, `ft`, a slash-written date, `1990-1995`, `2st`) are refused by name rather than guessed, and the negative control is a rerun with the numeral table disabled: exactly the three numeral tests fail, the rest of the voice suite passes |
| A number that means what it says | `test/numbers-fidelity.test.mjs`, `test/numbers-pasted.test.mjs` | — | two rounds of checking the reader's output found the *reading* changing the meaning. Neither was a listening session: the lines were synthesized with the real reader and the chosen words and published bytes compared with the sentence, which is enough to see a wrong amount without hearing it. A reviewer wrote the lines, reported the mismatched readings, and confirmed each correction the same way. `$1250` was said as "twelve fifty dollars" (a price read as a year), `£0.50` as "fifty cents" (another currency's subunit), `1,000,000,000,000` as "one" (the scale table ended at a billion and the rest vanished), `-3.5` without its minus; on a script pasted from a page, `−3.5` read as **positive**, `¥500`/`₹500` as "five hundred" (currency dropped), `½` gone entirely. Now: money is read as money with its own currency's subunit, magnitudes up to a trillion are named and past that **refused**, a leading `+`/`-` and the pasted minus `−` are said, and a symbol the voice cannot name is refused **with the reason** (`¥ is a currency this voice does not name`), since a named symbol is fixable and a silently different sentence is not. Shipped as a new frozen set `cmudict-4`; `cmudict-3` keeps every one of its readings to the sample, proven by comparing against a checkout of the previous commit over 83 tokens and 13 sentences, and by rendering a `cmudict-3` take of all four corrected shapes and re-verifying it through `voice/verify-take.mjs`. A sentence with no numeral in it still renders byte-identically. Negative controls: reverting the whole reader fails both files; reverting only the sign reading fails exactly the three sign-related tests |
| Word pronunciation | `test/voice.test.mjs`, `node voice/check-pronunciation.mjs` | — | the readings the voice ships are the vendored CMU dictionary's, compared against an independent dictionary on demand; before this, rules read 30 of 110 distinct words of ordinary prose as different words (`science`, `machine`, `change`), and each fixed reading was shown to change the rendered samples, not only the table |
| A refused line on a card | `test/refusal-message.test.mjs` | — | a script the voice cannot say publishes **no** take, and the card says which symbol and why. Found by walking the real entry with `The price is ¥500.`: no take was published (right) and the card said `the run's directory was modified during the run` (wrong and misleading) - a narration agent that hits a refusal exits before writing its final JSON, and the server's "no final message" branch only knew about a tidied directory. The renderer's own sentence is on the agent's stderr and is now carried through, preferring `¥ is a currency this voice does not name`; the old message fails the test |
| A listening sheet a listener can trust | `test/voice.test.mjs` | — | three defects in a row, all found by a supervisor filling the sheet in rather than by reading the code. A note-only sheet ("I could hear a machine and not one word of it", every line blank) looked unanswered and a re-run deleted it - the sheet is now read in two sections and either half is enough to refuse (exit 3). Then a comment under Notes that quoted the line it was about, in the sheet's own `**Line 2.** ...` shape, was scored as an answer to that line: a 50% sheet scored 100%. Only `## Transcript` is scored now; Notes is kept verbatim in `score.json` and in the printed report. Third, the receipt contradicted its own number - a half-filled sheet was told "every line was left blank", and "50% covers only the lines you wrote down" was false, since the blank line's words stay in the denominator and count as missed; a blank template with no note was also told the note was the whole result. Every sentence now names its numerator and denominator, and the three states (blank template, half-filled, half-filled with a note) are tested in both LF and CRLF. Negative controls: reading the whole file as the sheet fails the blank-line assertion; dropping the all-blank test prints the wrong sentence; restoring "covers only the words you wrote down" fails the denominator assertion |
| A listener understanding the voice | `node voice/listening-test.mjs` - **no result** | — | nothing: the checks above measure a signal, and they cannot say a person understood a sentence. A paired-signal check made with the same synthesizer would only prove that the sounds differ from each other, which is a rendering question, not a listening one - so no such surrogate is recorded as intelligibility. The `--score` number stays empty until someone who did not write the script listens to the film and fills the sheet in; a blank transcript with a note is a complete answer for a line nobody can make out. A takeaway sample exists for exactly that (`node voice/listening-test.mjs --out <dir>`: real WAV, real h264 film, blank sheet, `key.txt` kept apart); no recogniser is available here (`whisper`, `vosk`, `ffmpeg` absent), and one would in any case be reference evidence to quote beside the human reading, not a substitute for it |
| Audio natural voice (`tts.cpp`, `bark.cpp`) | — | everything | nothing: the binaries are not on this machine |
| `hyperframe` image/video | — | everything | nothing beyond the method guidance being passed to the agent |
| Quality presets | — | — | passed as guidance only; never measured against a real model |

Real runs were taken through the working tree and through a clean `git archive`
export of an earlier candidate (a different prompt; the agent wrote
`generate_artifact.mjs` and a two-line `.txt`). Later, a **content chain** ran
three cards in one workspace: a 1200x675 PNG poster, a 720x405 h264 MP4 rendered
from that poster taken as a direct input card, and a 4-second 44.1 kHz mono WAV
from the same input. `node test/chain.mjs` reproduces it and saves screenshots
plus a JSON record; it is not part of `npm test` because it spends real model
calls.

The real run used `codex-cli 0.172.0` with ChatGPT authentication and the
adapter's own flags (`exec --json --output-last-message … --sandbox
danger-full-access --skip-git-repo-check --ephemeral`). It is evidence that the
adapter, the prompt and the artifact contract work against the real binary. It
is **not** evidence about output quality, and one run is one run.

## What a first run is like

1. `npm install && npm run dev`, open <http://127.0.0.1:8787>, double-click the
   canvas, write a prompt, press **Generate**.
2. The card shows `running` while the agent works; **Generate** becomes
   *Generating…* and **Stop** appears. Stop kills the agent's whole process
   group, and the card reports `cancelled` while keeping the previous artifact.
3. On success the card shows the artifact and its filename; the node directory
   holds the prompt, the script, the artifact, `codex.jsonl` and `AGENTS.md`.
4. On failure the card shows the reason, including the CLI's own last error, or
   a plain instruction when the CLI is not installed at all. The reason is
   stored in `workspace.yml`, so reopening the page — or restarting the server —
   does not turn a failure into a quiet draft.
5. Closing the server mid-run marks that run as interrupted rather than letting
   it reappear as something that never started.

Two honest gaps a first-time user will meet:

- `vendor/` is a submodule pair. Without `--recurse-submodules` the
  `.agents/skills` symlinks dangle, so the agent loses the Remotion and
  HyperFrames skill knowledge. The canvas still works; media quality suffers.
- The default model id in the header (`gpt-5.6-luna`) is what this machine's
  account accepts. A different account may need a different id, and the app
  will say so on the card rather than fail silently.

## Evidence

- Product source of truth: [`design.md`](design.md).
- Implementation source of truth: [`impl.md`](impl.md).
- `npm test`: **75 cases** across 18 files — 4 registry/prompt (`core`), 4 method
  availability/refusal, 6 workspace round trips, 4 canvas-script checks (a fourth now
  pins that a helper used only inside a nested template interpolation is still seen),
  8 browser canvas cases (`e2e`), 2 media renders, 1 audio render, 1 film, 3 provenance,
  2 wav measurement, 8 run-lifecycle, 2 Stop/failure UI, 4 attempt/retry, 11 version,
  1 draft-link, **7 voice** (`voice`: the synthesizer's own measurements, with tone,
  noise, sweep and silence pinned as failures), **2 narration** (a real WAV, a real
  Remotion film, and a restart), and 5 documentation checks. Without a browser the
  canvas cases skip and say which browser they looked for.
- `test/docs.test.mjs` pins the facts in these documents that a reader is misled by
  when they rot: the stated test count, the claim that audio has no real-generation
  evidence, speech being presented as working, the project being described as closed,
  and the method list matching the registry. It was added after all five had drifted.
- `node test/chain.mjs`: the content chain above, with `01-poster` …
  `04-chain-reopened` screenshots and `chain.json` beside them.
- `node test/journey.mjs`: walks the ordinary path once — create, overlap, raise,
  move, link, unlink, generate, Stop, regenerate, reopen, delete — and
  screenshots each step into `.tmp/journey/`, printing the facts as JSON.
- Real-CLI checks live under `.tmp/` (gitignored) because they need a logged-in
  account and a network.
- Fixture servers use `test/server.mjs`: an OS-assigned port and process-group
  teardown. This was not cosmetic — a server left on a fixed port by an interrupted
  run answered a later "negative control", which then looked green while testing
  nothing. For a related reason the first version of the Stop check also passed
  vacuously: it cancelled before the agent had started, so no orphan could exist.
  It now waits for the agent to actually be running.

## Boundaries

Local-first. One workspace at a time. It depends on an authenticated Codex CLI
for real generation and makes no claim about hosted collaboration, multi-user
access, or production reliability. `workspace.yml` is the only graph
persistence; z-order, undo and multi-select are canvas state, not stored.

## Deferred

No benchmark results, project video, or paper were produced; these remain out of
scope. Generated video *output* is a product feature and is covered by a
real-render test — see [impl.md](impl.md).

Audio *artifacts* and the offline voice are verified (table above); a **natural voice**
is not, and neither are `hyperframe` or the quality presets. Those, and a judgement of whether a finished
film is any good, are the natural next evidence to collect rather than new features
to add. One limit is a real gap rather than missing evidence: the harness keeps a
run out of the card's directory, but the agent is given that directory and
`--sandbox danger-full-access`, so an agent that decides to tidy it can delete a
file its owner put there. Probed on 2026-11-27 (`.tmp/probe-card-reach.mjs`).

## Versioning

The current version is `0.1.0` in [`VERSION`](../VERSION). Update it with the
changelog when a release changes the user-visible contract.
