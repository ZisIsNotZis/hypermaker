# Changelog

## Unreleased — a take's words and a take's sound have to be the same take, 2026-11-27

A reviewer took two narrations of different sentences, both 3.291 s long to the sample, and
put one take's `timeline.json` beside the other take's WAV. The server accepted it and the
card reported the second sentence over the first one's audio. Nothing in the old check was
wired wrong: it compared the timeline with the file's *duration*, and duration cannot tell
two sentences of equal syllable count apart.

- **The published bytes are re-rendered from their own script.** Rendering is deterministic
  - the noise source is seeded from the words - so the server renders the timeline's phrases
  again and correlates the result with the file. Measured on this voice: same words 1.000,
  one word changed 0.515, two clauses swapped 0.166, same words reordered 0.026. A take below
  **0.85** is refused, with a message that gives the correlation. `voice/bind.mjs` owns the
  comparison; `timeline.json` now records the rate and pitch it was rendered at, and an older
  timeline without them is still verified at the defaults rather than breaking workspaces
  written by the previous build.
- **A narration may select from its material, but not invent.** Every spoken word must appear,
  in order, in the frozen text the card was given; words that are absent are named in the
  refusal. This is the check that stops an agent which "improved" the copy from publishing a
  fluent narration of something the card never said.
- **The card says which card it read.** Evidence carries `take.correlation` and
  `source: {id, artifact}`, so a reopened card reads `read from #2 lines.txt · matched 1.000`
  next to the numbers it already showed. That is the creator's requirement: the sentence over
  the player must be the sentence in the file, from the take it came from.
- **The docs stopped letting a measurement stand in for listening.** "Robotic but
  intelligible" was backed by formant counts and onset floors - real measurements of a
  signal, and not evidence that anyone understood a sentence. There is no recogniser or
  speech model on this machine, so the docs now say that plainly, give the command that
  produces a file to listen to, and record the defects a listener hears and a measurement
  does not (`science` → "S-S-IY-N-S", `moved` → "M-AA-V-EH-D"). `test/docs.test.mjs` pins
  both the removed phrase and the honest replacement, in both languages.

Tests: 75 → 81. `test/bind.test.mjs` is new and pins the swap, the reorder, the one-word
edit, the length mismatch, a timeline that misstates its own speed, an invented word, and the
legacy timeline. `test/narration.test.mjs` gained the reviewer's case end to end through the
server, and its reopened-card assertions now check the source card and the correlation. Each
new guard was observed to fail its own test when disabled.

## Unreleased — a card's text can be heard, and the voice is measured rather than claimed, 2026-11-27

A creator put a line of text on one card and wanted to hear it on the next, then wanted the
voice inside a film. Nothing could speak: no `espeak`/`flite`/`piper`/`festival`, no shared TTS
library, no GGUF or ONNX model, npm couldn't reach anything, and the bundled Chromium reports
**zero** `speechSynthesis` voices. So the voice is written here.

- **`narration`, a new audio method, speaks with nothing installed.** `voice/` is a formant
  synthesizer in plain Node: a lexicon that spells words to phonemes, a pulse train through
  three resonators per vowel plus noise for fricatives, WAV I/O, and a measurement pass. It is
  robotic and it is intelligible; it says English words and digits and refuses (exit 2)
  anything it cannot spell rather than inventing a sound. It has no `requires`, so it is the
  default method for a new audio card - the card that previously defaulted to a binary that is
  not on this machine.
- **The card is checked against its own bytes before it is published, twice.** The
  `timeline.json` beside the WAV must describe *that* file - phrases contiguous, adding up to
  its real length, every word pronounceable by the shipped voice - and the file must measure
  as speech: periodic rather than noisy, a floor of syllable onsets for the words claimed, and
  more than one vowel region. `judge()` in `voice/render.mjs` owns the thresholds, and the
  server imports it, so the agent's `--check` and the server cannot disagree. An agent that
  writes a convincing JSON next to a file of noise produces no card.
- **Three real defects, each found by looking at the audio rather than the exit code.**
  A Chinese script rendered a **0-second WAV and exited 0** (tokens with no Latin letters were
  dropped silently); the synthesizer was a **square wave**, because a per-sample clamp
  flattened 75% of samples and a formant-shaped rasp passed a naive check; and onset
  detection **died on one digital-zero frame** of AAC padding, so a film's track measured 0
  onsets while its source WAV measured 14. All three are fixed and pinned by tests.
- **The onset check is a floor, and the docs say so.** This voice makes ~2 energy rises per
  syllable (38 onsets for 18 syllables). Tuning the test until it counted one per syllable
  would be fitting the threshold to its own answer. The real discriminator is the vowel
  count: a 220 Hz tone amplitude-modulated at 4 Hz gets 15 onsets and `voicedShare 1.00` and
  still fails, which is why `test/voice.test.mjs` pins tone, noise, sweep and silence.
- **A kept narration is provenance, not just a file.** The measured numbers and the phrase
  list are stored on the node and per version, round-tripped through `workspace.yml`, and
  printed on the card; after a server restart the card still says what was spoken and when.
- **A vertical slice test joins the two.** `test/narration.test.mjs` links a text card into an
  audio card, has the test agent run the *real* render and the *real* `--check`, renders a
  real Remotion film from that WAV, extracts the film's own audio track and measures it with
  the same judge, then restarts and reads the phrase record back. The only invented part is
  which words to read.
- **The documents follow the measurement, not the other way round.** Both READMEs and
  `project-status.md` said speech was never run and unproven; that stopped being true, so the
  claim was rewritten rather than deleted - `test/docs.test.mjs` now pins *both* halves: the
  offline voice is described as working and robotic, and a **natural** voice (`tts.cpp`,
  `bark.cpp`) stays documented-but-unrun. The method list went from six to seven, and the
  docs test compares that count with the registry instead of a typed number.
- **One test itself was wrong and is fixed.** `test/html-syntax.test.mjs` strips strings and
  template *text* before checking that every helper the canvas calls is declared. It ended a
  template at the first inner backtick, so the nested-template tooltip this change added made
  it report `render(` and `unknown(` as undeclared on a canvas that parses and runs. The
  stripper now recurses into `${...}` interpolations - which makes the check stronger, since
  a name used only inside one is now checked - and a new test pins that case with a
  deliberately broken script.
- Verified: **75/75** with a real Chromium. The voice's positives and negatives were observed
  on real files (`node voice/render.mjs --check` on the rendered WAV, and on a tone, noise,
  a sweep, silence, a 4 Hz AM tone and a 0-second file), the film's track was extracted with
  the bundled ffmpeg and measured, and the whole path was walked at the real entry point.

## Unreleased — the audio card can be used, and the docs stop contradicting themselves, 2026-11-27

A creator following the README to an audio card hit two failures and a set of documents that
disagreed with each other. Both were found by walking the documented path rather than by
running the suite.

- **The method list was filled once, when a card was built.** `fillMethods` ran only in
  `shell`, so switching a new text card to `audio` left `llm` in the dropdown - the offline
  `synth` method the README recommends could not be selected at all - while the server, which
  does know the type changed, would have run `bark.cpp`. The list is now rebuilt whenever the
  type can have changed, guarded on `type|method` so an unchanged card does not re-fetch.
- **A new audio card defaulted to the one method that cannot work.** The method list was
  sorted by name, so `bark.cpp` sorted first and became the default on a machine with no
  `~/bark.cpp`. A method now declares `requires: ["~/…"]`, the registry reports whether that
  path exists, and methods that can run are offered first. Methods whose tool is missing stay
  in the list - hiding them would make the guide unreachable for someone who has the binary -
  but are labelled `(needs a local install)`.
- **Pressing Generate on such a card failed about a binary, as if about the render.** It made
  an attempt directory and a run marker first, then reported the agent's message about a
  missing file. The server now refuses before creating anything, naming the missing path and
  the method that works instead.
- **The public documents contradicted each other and the code.** The front page said both
  "canvas usable, versions kept" and "no further development is planned"; the capability list
  said audio had no real-generation test while a later section reported a real 6-second WAV
  and a measured film; speech was listed as a working capability on a machine without either
  binary; `project-status.md` still said 38 cases and that the project was closed. All three
  are corrected, and **`test/docs.test.mjs` now pins them** — the stated test count against the
  suite's own declarations, the audio claim, speech never being presented as working, the
  project not being described as closed, and the method list matching the registry.
- **One claim narrowed to what is true.** This changelog said "nothing a run does can reach a
  file that sits next to the card". The clean-up cannot reach it, and that is what the four
  `test/attempts.test.mjs` cases show - but the agent is started with
  `HYPERMAKER_CARD_DIR` and `--sandbox danger-full-access`, so an agent that tidies that
  directory deletes the file and the run still reports success. Probed with a stand-in agent
  that removes exactly one file and nothing else: readable (`200`) before the run, gone
  (`404`) after. Recorded in the README, `project-status.md` and the earlier entry rather than
  left as an overstatement.
- Verified: **65/65** with a real Chromium. The two browser defects are negative-controlled
  by restoring each half (`.tmp/neg-methods.sh`: no refill on type change, alphabetical
  default) and watching the probe report disagreement; the five documentation claims by
  restoring each defect (`.tmp/neg-docs.sh`), where the first attempt showed two assertions
  could still pass - a control that wrote "Speech works" and one that dropped `synth` from the
  method list - so both were tightened until all seven go red. Walked at the real entry: a
  fresh canvas, an audio card switched from text, `synth` chosen and a WAV previewed
  (`.tmp/accept-docs.mjs`).

## Unreleased — trying again costs nothing you care about, and a refused run says why, 2026-11-27

A creator's normal path is not "generate once". It is try, fail, stop, retry, drop a
reference file next to the card, retry again. Three things were wrong with that path.

- **A failed retry could replace the take you had approved.** Adoption of a pre-publishing
  artifact copied it into `versions/` but left the card pointing at the old name - and
  that name is exactly where every agent renders. The first failure after upgrading
  showed the half-finished attempt on the card. Now the card is moved onto the copy
  before the agent starts, and the old file is only let go after that save has happened,
  so a server that stops in between still reopens onto something playable.
- **Discarded attempts accumulated forever.** Each failed or stopped run left its frozen
  material copies, its half render and its scratch in the card's folder: four thrown-away
  attempts grew one card from 5 files to 11, and the compaction notes for this repository
  had already recorded an unreferenced `versions/` copy per failure with no test. Each run
  now works in `attempts/<start>/`, which is dropped on success and bounded to the five
  most recent abandoned ones.
- **Clean-up was eating creators' own files.** The obvious fix - delete what appeared
  during a run - cannot tell a poster a person dropped in from an agent's output, and
  moving it to a quarantine bin is not much better: the path they knew stops working, and
  the bin itself gets pruned. That is why the two are now in different directories
  instead: **the harness's clean-up cannot reach a file that sits next to the card.** That
  is the whole claim, and it is the one this change earns - a run writes and is cleaned up
  under `attempts/`, so no rule of the harness has any business in the card's folder. It is
  not a boundary against the agent: the run is still started with `HYPERMAKER_CARD_DIR`
  pointing at that folder and `--sandbox danger-full-access`, so an agent that tidies its
  surroundings can delete the file and the run will report success. Probed, not assumed
  (`.tmp/probe-card-reach.mjs`, 2026-11-27: readable before the run, 404 after it).
- **A linked draft greyed out Generate and said nothing.** Linking an empty card into
  another and pressing Generate answered 400 with `path must be of type string, received
  null` - in the browser console only - and left an attempt directory and a run marker
  behind for a run that never started. The server now refuses with a sentence naming the
  card that has nothing in it (`Generate #2 first, or unlink it: …`), creates nothing,
  leaves the button usable, and shows the sentence both on the card and in a banner at the
  bottom of the window - a card can sit low enough that its own message is off-screen.
  Doing what the message says makes the same press work, and clears it.
- **A run may publish only what it wrote.** With a directory per run, an agent can no
  longer reach an earlier result by relative name; naming a file outside its own attempt
  directory (a kept version, for instance) is now a failure with the reason on the card.
- **What each take was asked survives the take.** The exact assembled prompt is kept next
  to the card and per published take (`versions/v2-prompt.txt`), alongside the script and
  the CLI invocation (`codex-command.json`). The sweep that bounds `versions/` first
  deleted those two files on the very next run, which is what the newest test now pins.
- Verified: **56/56** with a real Chromium, **61/61** with `test/docs.test.mjs` added - that
  file exists because this very entry's overstatement and three stale numbers elsewhere
  were found by a reader instead of by the suite. The three behaviours above each have a
  negative control that restores the old code and turns exactly that test red: adoption
  deleting before the save, the run writing into the card's directory with a deleting
  cleanup, no pruning, no prompt exclusion, no refusal, and a hidden notice. The journey
  was also walked at the real entry in a real browser: an old workspace opened, six
  failures/stops with a creator's own file present throughout, a restart, then the linked
  draft refusal and its successful retry - screenshots in `.tmp/accept-shots/`.

## Unreleased — two takes can be compared, and an unknown instruction stays unknown, 2026-11-27

- **Compare two takes side by side.** A `compare` button on the kept row opens both
versions of the card at once, each pane playing its own file, captioned with which
take it is and what it was asked for. Either side can be pointed at another version.
Closing leaves the card exactly as it was: comparing is looking, not choosing. Before
this the only way to compare was to swap the card and remember what it looked like.
- **A version from before prompts were recorded no longer inherits the newer take's
instruction.** Restoring it moved the bytes, the materials and (when known) the
prompt, but left `promptUsed` untouched - so the card showed the old picture while
claiming the instruction of the take it had just replaced. "No instruction recorded"
is a fact that travels with the version like any other. The draft in the box is still
kept, because a restore is not the moment to throw away what someone is writing.
- **The card says so when the instruction is unknown** - `asked for: unknown (kept
before prompts were recorded)` - instead of saying nothing, which read as agreement.
Each such version's tooltip says the same.
- Verified: **51/51** with a real Chromium. Both new rules are negative-controlled by
restoring the exact behaviour committed in 4939d98, which turns one test red, and by
hiding the unknown line, which turns the other red. The mixed-vintage case was also
walked at the real entry in a real browser with a hand-written old workspace: opening
on the newer take, typing a draft, clicking the old version (picture changes, badge
changes, card says unknown, draft intact), then going forward again (its instruction
returns to the box and the warning goes away). Two real Remotion renders were also
compared side by side and their decoded pixels checked - green on the card, blue in
the kept pane - so each pane really plays the file it names.

## Unreleased — a version keeps the instruction that made it, and takes are numbered, 2026-11-27

- **Going back to an earlier take now brings its words back with its picture.**
The card kept each version's bytes and the materials it was made from, but not
the prompt - so after restoring an earlier film the box still held the newer
prompt, and the next Generate silently redid the take the person thought they
were looking at. Building a card now records `promptUsed` (what the artifact on
screen was asked for), each kept version records its own `prompt`, and restoring
puts that prompt back in the box. A version kept before prompts were recorded has
none and is left unknown rather than filled in with today's words.
- **Editing the box no longer rewrites the history of the film already on screen.**
The record kept for the replaced version used to be read from the prompt box when
the next run *started*, so merely typing a new idea and pressing Generate
relabelled the approved take. The instruction now comes from what the run
actually ran.
- **The card says so when the box and the artifact disagree** - "asked for: …"
under the prompt while you type the next take, and on each kept version's
tooltip.
- **Two takes get different numbers.** Publishing numbered a version by
filename collision, so an agent that renders to a fresh path each run (which the
video method guide tells it to do) produced `v1-shot-a.mp4` and `v1-shot-b.mp4`:
two takes of one card, both labelled v1. The number is now the card's publish
ordinal, counted from `versions/`.
- Two bugs found while verifying this, both fixed: `workspace.yml` could not read
back a camelCase field at all (the parser's name pattern was `[a-z]+`, and it
dropped the line silently rather than failing), and one undefined name in the
canvas script - a helper declared inside another helper - took the whole page
down with no cards on it.
- Verified: **48/48** with a real Chromium, and the real entry walked in a browser
with two real Remotion renders: edit the box and the card still says what the
picture was made from, generate again and the card reads v2 with v1 kept, click
v1 and the picture, the badge, the box and the version row all agree. Four
negative controls: removing the restore step, the kept-version record, the
success record, the parser fix or either browser assertion each turns a test red.
The first version of the numbering test was green with the bug in place, because
it used a stand-in that always writes the same filename; it now uses one that
renders to a fresh path, as a real agent does.

## Unreleased — a stale file is refused at any speed, 2026-11-27

- **A run that hands back an untouched file is refused, even one second after
the previous run.** The check was "the artifact's modification time is not more
than a second older than this run started". That second was meant as slack for
timestamp granularity, but it was also a window in which the rule did not apply:
two runs closer together than the slack let the earlier file be published as a
new version, so changing a prompt and pressing Generate again right away produced
a duplicate version. The existing test waited 1.5s between runs, which put it on
the far side of the window and hid the case a person actually hits.
- The judgement is now "was this file written during this run", answered without
a clock: each file in the node directory is fingerprinted (device, inode, size,
nanosecond mtime/ctime) before the run, and the named artifact must no longer
match its fingerprint. Not being written is then a property of the file at any
speed.
- The opposite mistake is pinned too: a deterministic renderer that writes
identical bytes twice *did* write them, and must still produce a second version.
Content equality is deliberately not the test.
- Verified: 45/45 with a real Chromium. Both directions are negative-controlled -
disabling the rule makes the stale-file test red, and restoring the old clock
rule makes the back-to-back test red. The reproduction that started this (two
runs with no pause, one unchanged file, two "versions") fails after the fix and
published two versions before it.

## 0.1.0 — generation lifecycle and a real Codex run, 2026-11-27

A person can now stop a run, read why a run failed, and trust both after a
restart. One real Codex CLI run was taken through the app.

- **Stop.** A running card offers a Stop button, and `POST /api/cancel` ends the
  agent *and its process group* (agents spawn shells and renderers). Previously
  the only way out of a long run was to wait or restart the server.
- **One run per card.** A second Generate on a running card returns 409 instead
  of spawning a second agent into the same node directory.
- **Outcomes are stored.** `status` and `error` are persisted in `workspace.yml`.
  A failure or Stop now looks the same after a restart; before, the error lived
  only in memory, so a failed card reopened as a clean draft. A run still marked
  `running` when the workspace loads is reported as interrupted.
- **Visible reason.** The card shows the failure, including the agent's own last
  error message, rather than only `exited with code 1`. A missing CLI says to
  install Codex or set `CODEX_BIN` instead of `spawn codex ENOENT`. A card built
  on a fresh page load used to omit the error entirely; it is rendered in both
  paths now.
- Ctrl-C on the server cancels live agents so nothing keeps writing into a node
  directory after the server is gone.

Evidence and tests:

- `test/lifecycle.test.mjs` (6 cases) and `test/stop-ui.test.mjs` (2 browser
  cases) cover the above. Each assertion was checked by breaking the behaviour it
  protects — removing the 409, dropping the stored fields, removing the
  interrupted-run rule, and replacing the group kill with a child kill — and
  watching it go red. The first version of the Stop test passed vacuously
  because it cancelled before the agent had started; it now waits for the agent
  to actually be running, which is what exposed the real leak.
- Real CLI: one `codex exec` run (37 s) wrote and ran a script and returned a
  plain-text artifact the canvas previewed; Stop and a rejected model were also
  exercised against the real binary, and the rejected card showed the CLI's own
  message verbatim.
- `npm test` is 30/30 with a real Chromium (was 20/20 at the start of this round).

## 0.1.0 — canvas follow-up, 2026-11-26

User-visible canvas fixes, each found by walking the ordinary path in a real browser:

- Pan and zoom moved nothing: they called a `setView()` that was never defined.
- A finished drag kept following the pointer, and one drag could move several cards.
- Dropping a card anywhere but another card's title bar either linked anyway or
  failed to keep the new position.
- A covered card could not be raised: every card was appended fresh on each update
  and had no z-order.
- Link lines were drawn in viewport pixels and stayed put through pan and zoom.
- A right-button press on a card title bar dragged the card instead of reaching the
  link underneath, so a link running behind a header could not be unlinked.
- Changing a card's output type or quality threw on every change and failed silently.
- The prompt field lost focus and half-typed text on every server refresh.

Test changes:

- `test/fake-remotion-codex.mjs` could never run: it hard-coded
  `chromium.executablePath()`, a path that does not exist unless Playwright's own
  browser was downloaded, and no test referenced it. It now takes its browser from
  `HYPERMAKER_CHROME`/`CHROME_BIN` and fails loudly when that path is missing.
- New `test/media.test.mjs` renders a still image through Remotion for real and
  asserts the PNG signature plus the 320x180 image the canvas shows. It skips with
  a printed reason when no browser exists, and a fixture that writes text into a
  `.png` file makes it fail, so a green run means something was rendered.
- `test/media.test.mjs` now also renders a video: the same fixture with
  `REMOTION_TEST_VIDEO=1` bundles and calls `renderMedia` with h264 on its own
  server, and the test asserts the `ftyp`/`avc1`/`moov` container plus a
  `<video>` the browser decodes at 320x180 with a non-zero duration. The
  negative control (text written into a `.mp4` file) fails with
  `a text file must not pass as an ISO base media container`.
- `npm test` is 20/20 with a real Chromium (was 19/19). What remains unproven
  is that a realistic composition renders as intended: the render is real, the
  composition is the fixture's.

## 0.1.0 — 2026-08-31

- Experimental local-first artifact canvas release line.
- Supports filesystem-registered text, image, audio, and video generation flows.
- Includes deterministic tests and a Playwright browser test suite.
