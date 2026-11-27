# Changelog

## Unreleased — the emphasis lands where the dictionary puts it, 2026-11-27

With the words right, the voice was still putting the primary stress on the first syllable of
every word, because `build-dict.mjs` threw the dictionary's stress marks away at build time.
Measured on the sample prose, **7 of its 44 multi-syllable words** were stressed on the wrong
syllable: `toward`, `without`, `before`, `about`, `machine`, `against`, `around` - `MA-chine`
and `a-ROUND` said as `MA-chine` and `A-round`. That is the other half of why a correct
sentence still sounded like a machine reading a list.

- **The stress marks are vendored, not invented.** `vendor/cmudict/stress.txt.gz` (35 KB) is
  built beside the pronunciations from the same public source by the same command, and holds
  the primary-stress pattern of 34,858 words - only those whose emphasis is *not* on the first
  syllable, because that is the only case where it changes the audio. Absence means exactly
  "first syllable", which is what the engine already did, so a word missing from the table is
  read as before rather than refused. A pattern is one digit per vowel, in the same order the
  engine derives syllables from the same phonemes, and a test checks that alignment against
  the dictionary word by word.
- **It is a new reading table, `cmudict-2`, and it is now the default.** Editing `cmudict-1`
  would retroactively make every take it made unreproducible - the exact defect fixed in the
  entry below, from the other direction. `rules-1` and `cmudict-1` still render **byte for
  byte** what they always did, pinned by hash over three texts at two rates.
- **`bindTake` tries every table for both an exact match and a rate-recovered one.** The
  recovery path used to search rates under the first table only; with a new default table that
  would have refused exactly the older takes it exists to save, so the loop is now one table at
  a time with both checks inside it. An honest `cmudict-1` take whose rate was rounded still
  verifies, and a mismatched recording still does not.
- **`node voice/check-stress.mjs --wav take.wav --timeline take.json`** reads the emphasis back
  out of a published file. It re-renders every possible stress position and reports the one
  that reproduces the samples **exactly**, then compares it with the dictionary's mark - an
  identity, not a threshold. Exit status zero when every word agrees, four when the file was
  read but a word is stressed elsewhere, two when it could not be read. The first version was a
  heuristic that split the energy envelope and called the loudest piece stressed; measured
  against the dictionary it was simply wrong (one piece instead of two in `toward` and `about`;
  a loud `sh` outweighing `machine`'s vowel), so it was replaced, not tuned.
- **The card says when a take is older than the voice.** `evidence.currentReadings` is published
  beside `take.voice.matched`, so a reopened card reads "made with the cmudict-1 voice; this
  build reads with cmudict-2" for a take that verified under an older table, and says nothing
  for a current one. It is stated as a fact, never as a failure: the take passed every check.
- **Docs stop attributing the remaining gap to stress.** Pronunciation and primary stress are
  both the dictionary's now, so what a listener still has to overcome is the robotic timbre.
  Whether that emphasis is *audible to a person* is not claimed: it is the listener's judgement
  the listening test exists to record, and nobody has recorded it yet.
- **A published take keeps its own timeline, so `verify-take` finally works on a real card.**
  This was found by *running* the command this project documents against a real workspace: it
  answered "no WAV at …" for a card the canvas was playing, because the take lives under
  `versions/v1-narration.wav` and the timeline lived only in the attempt directory, which is
  dropped when the run succeeds. The fix copies it beside the take as
  `v2-narration.timeline.json`, and `voice/verify-take.mjs <node-dir>` now finds a published card
  as well as an attempt directory. The first attempt at the fix still failed - the sweep that
  clears unreferenced files in `versions/` deleted the copy moments later - so the sweep's own
  live-set rule keeps it, the same way `v2-prompt.txt` is kept. Re-running the walk prints
  `verifies … reading table: cmudict-2` on the published card, and `check-stress` on the same
  file reports 6 multi-syllable words with **0** stressed in the wrong place (`machine` and
  `about` on syllable two).
- **A supervisor ran it on a two-version card and found two more defects in `verify-take`.**
  With two takes published and the *first* restored, `node voice/verify-take.mjs <node-dir>`
  verified **v2** while the canvas was showing **v1**, because it sorted filenames and took the
  newest; and passing the selected `versions/v1-narration.wav` outright answered "no timeline"
  while `v1-narration.timeline.json` sat beside it. Both are worse than having no command: one
  answers confidently about a recording the person is not looking at, the other says an honest
  take records nothing. Now the directory case reads which take the card is *showing* from its
  own workspace record and says so ("this is the take the card is showing"), a named WAV is
  matched with its own record, and when the record cannot be read the fallback announces that
  it guessed ("NOT the take the card is showing: … the newest published take was checked
  instead").
- **An old recording is described only as far as the evidence goes.** A timeline written before
  `voice.readings` existed names no table; the report now says the table was *recovered* from
  the bytes ("predates the field … rules-1 is the one that reproduces these bytes exactly")
  rather than claiming the record said it, and adds "It is an older recording: this build reads
  with cmudict-2, so regenerating it would not sound the same. Either is a fair choice." That is
  the honest half of the question a creator actually has after a voice change.
- **Tests: 103/103** with a usable Chromium (was 95/95). Eight new: the stress table is aligned
  with the dictionary and only lists words that need it; the audio puts the emphasis on the
  syllable the dictionary names (with `cmudict-1` as the negative control, and audio this voice
  did not make refused rather than matched to the closest stress); and an older take verifies
  while its card can still say it was made by an older voice, with a mislabelled record
  reported as the claim it is. Reverting the synthesizer's one-line change fails the first and
  third of those.

## Unreleased — a pronunciation fix must not call yesterday's honest take a lie, 2026-11-27

A reviewer checked the candidate that shipped the pronunciation dictionary and found the
one thing that build had not been asked: what happens to the takes people already have.
They recorded "Science can change the way a machine works." through the ordinary entry point
on the previous revision, then checked the same WAV and timeline on the new one, where it was
**refused** - "phrase 1 (...) is 3.71s of speech, but the timeline says it takes 3.52s".

The audio was honest. It was the rule engine's reading of those words, and the checker
re-rendered it with the dictionary and got a longer file. So an *improvement* in how the
voice pronounces turned every older recording into a false accusation about its own script -
and the better the pronunciation got, the more of a person's existing work would be declared
invalid. Reproduced here from the reviewer's own files: rendered through the pre-dictionary
engine the take reproduces at whole-file correlation 1.0000 and worst frame 1.000, to the
same 77,635 samples that were published.

- **The reading table is a versioned render setting, like rate and pitch.** `rules-1` is the
  pre-dictionary engine exactly as it shipped; `cmudict-1` is the dictionary's. A take records
  `voice.readings`, and `voice/lexicon.mjs` refuses an unknown table rather than defaulting to
  it - a field that explains the bytes must not be a field nothing enforces. Changing how a
  word is read from now on means adding a set, never editing one.
- **An older take verifies against every table the build has, and only on an exact
  reproduction.** A record that predates the field, or that names a table this build does not
  have, is re-rendered under each known table; it is accepted only when the worst frame agrees
  at the same threshold as before (0.5 recorded, 0.95 recovered). The words, their order, their
  start times and the file are all still required to be the same arrangement, so this does not
  reopen the reviewer's original defect: take A's audio under take B's timeline is still
  refused, and that case is pinned with the escape hatch open.
- **The evidence says both what the record claimed and what the audio is.** `voice.matched` -
  `{rate, pitch, readings}` - sits beside `voice.recorded`, and every accepted take reports it,
  so a card is never told its record was exact when the sound says otherwise. The canvas line
  adds "audio made with the rules-1 reading table, not cmudict-1" when the two differ, since a
  card made before a pronunciation fix would otherwise look identical to one made after it.
- **`node voice/verify-take.mjs <node-dir>`** answers "is this older card still honest?" -
  reopening a workspace deliberately does not re-check a take (one you approved should play
  tomorrow), so this is how a person asks instead of trusting. It runs the same `bindTake` the
  server refuses a bad take with, prints `verifies` plus the worst-frame agreement and the
  table that made the audio, or `DOES NOT VERIFY` plus the phrase and moment that disagree.
- **The frozen table is pinned to the shipped sample, not described.** 77,635 samples for that
  sentence, and the phonemes of `science`, `change`, `machine`, `colour` and `every` under both
  tables, so a later edit cannot quietly turn history into a lookalike that almost reproduces
  old audio and then fails the frame check.
- **Tests: 95/95** with a usable Chromium (was 91/91). Four new: an older take verifies while a
  foreign recording is still refused; an unknown table is refused where it is used; the frozen
  table is the engine that shipped; and the re-verify command on a directory, a mislabelled
  take, a stolen recording and a missing timeline.

## Unreleased — a take's words and a take's sound have to be the same take, 2026-11-27

A reviewer took two narrations of different sentences, both 3.291 s long to the sample, and
put one take's `timeline.json` beside the other take's WAV. The server accepted it and the
card reported the second sentence over the first one's audio. Nothing in the old check was
wired wrong: it compared the timeline with the file's *duration*, and duration cannot tell
two sentences of equal syllable count apart.

- **The published bytes are re-rendered from their own script, phrase by phrase, frame by
  frame.** Rendering is deterministic - the noise source is seeded from the words - so the
  server re-renders each of the timeline's phrases alone and compares it with the slice of
  the file the timeline places it at. The comparison is 25 ms frames, and the answer is the
  worst frame that carries sound, so no amount of identical opening can average a difference
  away. Measured: the same phrase **1.000**, a word changed **-0.344**, a phrase reworded at
  its end **-0.218**, an ending clause swapped **-0.297**; a phrase below **0.5** is refused.
  Both of the intermediate designs were caught by the same reviewer and are described below
  rather than quietly replaced. `timeline.json` records the rate and pitch it was rendered
  at, and an older timeline without them is still verified at the defaults rather than
  breaking workspaces written by the previous build.
- **Two takes with a shared beginning cannot be confused, at any length.** The reviewer's
  second report: two 32-second takes of the same twelve sentences, differing only in their
  last two clauses. The first version of this check compared the whole file, so the mixed
  take scored 0.896 on the strength of the eleven and a half seconds that were identical and
  was accepted. Per-phrase correlation was the same mistake one level down - a phrase
  reworded only at its end scored 0.940 - which is why the unit is now the frame. On the
  reviewer's own files the two honest takes score 1.000 on every phrase and the mixed take
  fails on exactly phrases 11 and 12, at seconds 30.15 and 30.83, with no honest sentence
  reported as wrong.
- **The frame unit is measured to be necessary, not chosen.** A word substituted for one of
  the same rendered length cannot be caught by any duration check, and whole-phrase
  correlation would have published it: `wall` -> `hedge` renders to exactly the same number
  of samples and scores 0.62 whole-phrase against a 0.5 bar, while its worst frame is -0.567.
  Seven such substitutions were found in one sentence, every one accepted by the phrase-level
  measure and refused by the frame-level one. The test asserts both halves of that contrast,
  and the whole-phrase implementation was run against it and watched going red.
- **The tool's own take always verifies.** The reviewer's third report: `voice/render.mjs
  --rate 1.23456 --pitch 113.45678` wrote a timeline recording `1.235` / `113.457`, so the
  server re-rendered at the rounded speed and refused an honest take at 0.300 on its third
  phrase. The CLI now records the effective settings the samples were made with, at full
  precision, and verifies its own output through the same `bindTake` the server uses before
  returning it (exit 4, "a bug in the tool", if it ever fails). A record written by an older
  build to three decimals is *recovered* instead of refused: the recorded rate is treated as
  known only to its written precision, the search is confined to that interval, and a
  recovered take must reach 0.95 - a true rate measures ~0.99, a neighbouring one 0.76-0.88.
  Recovery also runs when a rounded record merely scraped past the bar at 0.89 against an
  exact 1.000, so a rounding cannot turn into a card that says "nearly these words".
- **A refusal says which kind of problem it is.** "The words differ" about an honest take
  sends a person after the wrong bug. When the audio is the claimed words at a nearby rate,
  the message now says the record's rate or pitch is wrong and the script is not.
- **A phrase's declared duration is checked too.** An interior phrase's slice is always the
  right number of samples whenever the file continues past it, so only the last phrase could
  ever run out of audio. The timeline's own `duration` is now compared with what its words
  render to, which is what catches a misdescribed middle of a take.
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

Tests: 75 → 86. `test/bind.test.mjs` is new and pins the swap, the reorder, the one-word
edit, the one-word edit at the end of a long phrase, a 30-second take with a swapped ending,
the length mismatch, a timeline that misstates its own speed, an invented word, the legacy
timeline, and the reviewer's rounding case in both directions (the tool's own take verifies
at full precision and through a record rounded to three decimals, while different words
hidden behind a rounded record are still refused). `voice/render.mjs` verifies its own output
before returning it, and that self-check was observed firing against a deliberately broken
record. `test/narration.test.mjs` gained the reviewer's case end to end through the
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

## Unreleased — the words are the dictionary's, and there is a way to hear the answer, 2026-11-27

The previous slice made the audio and the script provably the same take. A reviewer then asked
the product question that no amount of signal measurement answers: *open the real film - can I
understand the lines it needs me to understand?* Checking that honestly turned up a defect
bigger than the voice's timbre, and produced the first way for a person to answer the question
with a number instead of an opinion.

- **Pronunciation comes from a vendored pronunciation dictionary, not from spelling rules.**
  Measured over a paragraph of ordinary English, the rule engine read **30 of the 110 distinct
  words** differently from the dictionary: `science` as "S-S-IY-N-S", `machine` as "match-ain",
  `change` with no `j`, `music` as "M-AH-S-IH-K", `wanted` as "W-AE-N-T-EH-D", `building` as
  "B-UW-L-D-IH-NG". Each of those is a word a listener hears as a *different* word, and that is
  what makes a narration hard to follow - not the prosody. The readings now come from CMUdict
  (`vendor/cmudict/`, BSD, notice shipped, 124,087 words, `node voice/build-dict.mjs`
  regenerates it from a public `cmudict.dict`), loaded lazily so importing the module costs
  nothing. The rule engine stays as the fallback for names and coinages the dictionary lacks,
  because refusing every unknown name would make the voice useless for a creator's own script.
- **Every fixed word was shown to change the audio, not only the table.** A reading that changes
  in a table and not in the samples would be a cosmetic fix. Each of the 13 changed words was
  synthesised under both readings and the samples compared: all 13 differ, 0 identical. A word
  the dictionary lists with no vowel at all (`hmm` is `HH M`) is still refused rather than
  rendered as a click, and a word neither knows is refused by name.
- **Homographs are read the way narration uses them.** CMUdict lists `read` as "red" first and
  `live` as the adjective; a script means "reed" and the verb. A four-word table (`read`, `live`,
  `wind`, `close`) names the reading, and it is only allowed to name a reading the dictionary
  actually lists - a typo in it falls back instead of inventing a pronunciation. Homograph
  alternatives survive the compaction, so the choice is real rather than a lossy one-way import.
- **`node voice/check-pronunciation.mjs` is the measurement, not an example list.** Hand-picked
  examples show a defect exists; they cannot say whether a listener stumbles once or thirty
  times. The script compares the shipped readings with an independent dictionary (`--dict
  /path/to/cmudict.dict`) over prose and reports agreements, disagreements naming both readings,
  and words the voice cannot say at all - counted apart, because a limitation is not a wrong
  answer. Comparing the vendored table with itself would measure nothing, so the tool takes the
  outside dictionary as an argument and the test does exactly that with a dictionary written in
  the test.
- **`node voice/listening-test.mjs` is how a person answers the question.** It renders the real
  voice and a real h264 film carrying that audio, and writes a **blank** transcript sheet: one
  numbered line per sentence and no words. The script goes to `key.txt`, kept apart, and the
  film deliberately shows no caption from the script - the first version put the lines on
  screen, which hands the listener the answer the sheet exists to withhold. `--score` reports
  word accuracy against the filled sheet and names the misheard words. It scores by **sound**
  (`pronounce()` on both sides, so `color` for `colour` is a hit - spelling is not hearing) and
  it counts a blank line as missed rather than dropping it, because "I could not make that out"
  is the commonest real answer and must cost something. The tool has **not been answered by a
  person yet**; `docs/project-status.md` says so, and the number does not exist until one does.
- **Two defects in the tool found by running it, not by reasoning about it.** The film was
  declared silent because the peak of a float sample array was compared against the int16 scale
  (0.64 read as "silence"). The sheet parser swallowed an empty line's text into the next line,
  so one blank line invented a transcript and shifted every answer after it; the parser is now
  indexed by the line number written on the sheet. Both are pinned by tests that fill a sheet in.
- **Tests: 91/91** with a usable Chromium (was 86/86). New: dictionary completeness and
  renderable-symbol coverage, the regenerable table's kept/dropped counts, the measurement
  script's agreement and separation of unreadable words, the listening sheet containing no word
  of the script, and the scorer's sound-based comparison and blank-line accounting.
