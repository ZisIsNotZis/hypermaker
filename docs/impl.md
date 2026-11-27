# HyperMaker Implementation Plan

Implementation source of truth. Product behavior belongs in `design.md`.

## Architecture

Small local Node HTTP server, static browser canvas, filesystem workspace, filesystem registry, and Codex CLI adapter. One in-memory active workspace mirrors `workspace.yml`. HTTP handles commands; SSE sends completion/error notifications. Raw Codex output goes to node `codex.jsonl` and `dev.log`; application does not parse trajectory.

## Workspace

`workspace.mjs` owns YAML-compatible serialization, parsing, atomic writes, integer IDs, and node-local path validation. Server loads active workspace and saves after graph mutations and generation start/end. Draft nodes remain memory-only until Generate. No old-manifest compatibility layer.

A node's `status` and `error` are persisted fields, not view state. The last run's outcome is what a person looks for when they reopen the app, so a failure or a Stop has to be on disk: an in-memory-only error made a failed run reappear as a quiet draft after a restart. A run still marked `running` when the workspace is loaded was cut off, and `adopt()` rewrites it as an error before the canvas can show it.

## Registry and prompts

Load type, method, and quality registry at startup. MIME/extensions drive type detection and UI options. Fixed prompt guidance lives in text files under `prompts/`; dynamic sections assemble current node and direct inputs. Preserve section order and user prompt. Do not inject skill names; repository-root cwd lets Codex discover them.

A method may declare `requires: [path]` — the local tool without which it cannot run at all (`tts.cpp` and `bark.cpp` each name one binary under `~/`). `methodsFor(type)` expands the path and reports `available`, and sorts available methods first, so the default for a fresh card is one that works with nothing installed. Missing methods stay in the list rather than being hidden: the guide is still the truth for someone who has the binary, and a canvas that dropped registry entries would misreport what exists. `methodFor(type, id)` is the single lookup used by both the prompt assembly and the pre-run refusal, so the canvas and the server cannot disagree about which method will run. The canvas refills a card's method list whenever `type|method` changes — it used to be filled only when the card was built, which left a card switched to `audio` showing `llm` while the server would have run `bark.cpp`.

## Codex

Spawn one process per node with repository-root cwd, a run directory of its own, model/effort, optional `gh/` prefix, and closed stdin. Pass `--json` for trajectory and `--output-last-message` for final result. Tee stdout/stderr unchanged to node `codex.jsonl` and timestamped `dev.log` plus terminal. Ignore trajectory for application logic; parse only final output file. Require artifact, allow optional script, enforce node-local paths, ensure type and `AGENTS.md`, then save workspace and emit completion. Runs never block HTTP or other nodes.

Each run is spawned `detached`, so it leads its own process group: an agent spawns shells and renderers, and Stop must end all of them. `generate()` returns a promise carrying `cancel()`, which signals the group with SIGTERM and escalates to SIGKILL after 3 s; a test whose agent leaves a continuously-writing grandchild is what catches a child-only kill. The real CLI reports why a turn failed as JSON events, so a non-zero exit quotes its last `error`/`turn.failed` message; a missing binary (ENOENT) becomes an instruction naming `CODEX_BIN` instead of a bare errno.

One run per node is enforced in the server, not the UI. `running` maps node id to the agent promise; a second Generate returns 409 rather than spawning a second process into the same node directory.

## A run's directory, and keeping the card

`server/runs.mjs` owns where a run works and what happens if it damages the card. A run
works in `<workdir>/.runs/<card>/<start>` - outside the card's directory, which used to
hold `<card>/attempts/<start>` - and `HYPERMAKER_CARD_DIR` is no longer set, because the
variable handed the agent every name in the directory. The card's path is still in the
prompt, since a real agent has to read the linked material by path; a path in a prompt
is a request, so the boundary cannot be the layout alone.

Before the agent starts, `guardCard` copies every file the card holds into
`<run>/.guard` and writes `manifest.json` with each file's size and sha256. The copies
are copies, not hardlinks: the first version hardlinked, and an in-place save -
reopening the existing file and writing into it, which keeps the name and often the
size - changes a hardlink's content too, so the check would have compared a file with
itself and called it intact. After the run, `keepCard` hashes each card file again and
puts back any that are gone or different, reporting them by name; it is called on the
success path (before publishing), and on the failure path, so a Stop and a crash repair
the card the same way. A `spent` marker makes the guard single-use, so a server that dies
between the check and the save cannot re-run it against copies that have moved.

The card keeps its own take because publishing is separate: nothing the agent writes
touches `versions/`. A successful run that had to repair the card is reported as an
error, since it made its output from material it modified; a stopped run stays
`cancelled` with the repair noted in the same sentence. `recoverRun` is the same check at
the next startup for a server that died mid-run, and it writes `KEPT-AFTER-CRASH.txt`
beside the card because nobody was watching. A file up to 64 MiB is copied, so a deletion
and an in-place rewrite are both repaired; a larger file - a 65 MiB clip is ordinary
material, and a supervisor found that the first version said nothing about one - is
hardlinked, which repairs a deletion but cannot see a rewrite in place. `guardNotice`
produces that sentence before the agent starts, the `/api/generate` reply carries it, and
it is stored as `notice` on the card (and in `workspace.yml`), so closing the page does
not lose it. The canvas renders that stored notice in `shell()` and keeps it current in
`sync()`, because a supervisor reloaded mid-render and the notice vanished from the card
while the server still held it; `test/canvas-protection.test.mjs` presses Generate with a
65 MiB clip, reloads, and asserts the same sentence and a working Stop (it skips where no
Chromium is installed). It is `null` when every file is small enough to copy. A file the filesystem
refused outright is reported as unprotected with the reason, and a guard whose manifest
cannot be read reports that it could not protect the card rather than reporting it clean. A successful run replaces `artifact`/`script`; a failed or stopped run leaves the previous artifact in place and records `status` + `error`.

A card's run slot is claimed **synchronously in the request handler**, before the first
await past reading the body, and that claim is what `/api/cancel` signals. It used to be
recorded only when the agent was spawned, so everything in between - adopting the old
take, copying sources, guarding the card, seconds of work for a card holding an 8 MiB
picture - ran unmarked: two canvases pressing Generate together both got 202, ran two
agents, and published v3 over one another, and a Stop pressed in that window was told
`not generating` while the run went ahead. The claim is `{agent, stopping, cancel()}`, so
Stop before a process exists records the press and the run is stopped the moment it
starts; a release only clears the slot when it still owns it (`releaseClaim`), so a
settled run cannot free a card that has already started again. Every reply that starts
nothing (a refusal, a thrown preparation) gives the slot back. `test/prepare-window.test.mjs`
presses twice over two connections with the snapshot step held open
(`HYPERMAKER_HOLD_BEFORE_GUARD_MS`, tests only), and fails with two 202s when the claim is
taken at the spawn instead. SIGINT/SIGTERM cancel live agents so no renderer outlives the server.

## One workspace at a time, and runs that outlive a switch

`running` and `attemptDirs` are keyed by workspace *and* card (`slot(dir, id)`), because node
ids are per workspace and a run outlives the request that opened another one. Keying by the
id alone made B's card 1 look busy while A's run was going, refuse its Generate, and point
its attempt directory into A. A run captures its workspace at the press and takes it
explicitly on every later line; `finishIn` puts the outcome into the open graph only when the
graph is the run's own, and otherwise into that workspace's own `workspace.yml`.

Every write to a `workspace.yml` is queued per directory (`serial(dir, work)`), and opening a
workspace is one of those writes. Two writers used to read the same file, apply their own
change and each write back, so the later one undid the earlier: a run that finished while its
workspace was being opened was overwritten by the opener's save of a graph read before the
result existed. The opener also sets `workdir`/`nodes` only after the new file has been
written, so a failed open leaves the previous canvas and state untouched - and the queue never
stores a rejection, or one bad path would fail every later open until a restart. An open waits
for the writes already queued for its workspace before replying, so its own reply is the
finished state.

The key is declared above `adopt`, which runs at module load: below it, starting against a
workspace that already had cards threw `Cannot access 'slot' before initialization` and the
server exited, while an empty workspace never entered the loop. `test/workspace-switch.test.mjs`
covers the start-against-existing-cards case as a separate process for that reason.

## HTTP and UI

Provide workspace open/read/save, node create, import, link/unlink, clone/delete, layout, file serving, asynchronous generation, and cancel. The card shows *Generating…* with a Stop button while a run is live; Stop is hidden otherwise. The stored error renders on the card both when it happens and on a fresh page load — a card built by `shell()` used to skip it, so a failure was visible only until the page was reopened. UI is compact canvas: pointer drag/link/pan, drag-end workspace persistence, 4:3 artifact preview, visible SVG marker arrows with hit paths, control-only wheel suppression, wrapped text, native media viewers, download/image popup, and preview errors. Card raising must not move a card during pointerdown on an interactive control. Delete control executes on click after confirmation.

Canvas implementation invariants (each has a regression test; two were once live bugs):

- Cards are stable DOM nodes keyed by `data-id` and updated in place by `sync()`; `render()` never rebuilds a card, so raising, focus and half-typed text survive API and SSE refreshes.
- Raise order is one `order` map plus a monotonic counter, applied as `z-index` by `paintOrder()`. The top card is marked `raised`. Order is client-side and deliberately not persisted.
- One module-level drag record owned by `beginDrag`/`dragTo`/`endDrag`, with a single window `pointermove`/`pointerup`/`pointercancel` listener. Per-card closures plus per-card window listeners let a finished drag keep following the pointer, and moved several cards at once.
- Only the primary button starts a drag or a pan. A right-click must reach the link hit path so it can unlink.
- `setView()` applies `translate(ox,oy) scale(scale)` to `#world`; pan and zoom both call it. It was called but never defined, so pan and zoom threw and the canvas silently never moved.
- A card being dragged carries `.dragging` with `pointer-events:none`, and the drop hit test runs *before* that class is removed. Clearing it first made every drop miss: the dragged card sits under the cursor, so it is always the topmost element and never the card being dropped onto.
- Links are one SVG per canvas, addressed in world coordinates inside `#world`, so pan/zoom/drag keep them on the card edges. `.edge` ignores pointer events; the 20 px `.edge-hit` stroke receives the context menu.
- `.cards` is `pointer-events:none` and each card opts back in, so empty canvas and link hit paths receive events.
- `safe()` takes a function; callers pass `safe(() => promise)`, never a promise. `changeField` resolves the method list first, then patches.
- Prompt saves are debounced, on blur, and flushed before Generate; `sync()` skips the textarea while it is focused.

## Media

`types/audio/methods/synth.mjs` exists because the two speech methods name binaries under `~/tts.cpp` and `~/bark.cpp`; when those are absent an audio card had no usable method at all. `synth` asks the agent to synthesize PCM in Node and write the RIFF header itself, so it needs nothing installed, and its guide says plainly that it makes tones and rhythm, not words. It is not a replacement for `tts.cpp`/`bark.cpp`, and the docs never present it as speech.

## Narration

`narration` is the method that actually reads a card out loud, and the reason it exists is a
user asking for exactly that: text on one card, a voice on the next, a film that carries the
voice. Nothing on this machine could speak - no `espeak`/`flite`/`piper`, no shared TTS
library, no GGUF or ONNX model, and the bundled Chromium reports zero `speechSynthesis`
voices - so the voice is written here, in `voice/`, with no dependency beyond Node: a
lexicon that spells words into phonemes, a formant synthesizer (a pulse train through three
resonators per vowel, plus noise for fricatives), WAV I/O, and a `measure()` that reads a
file back.

The method is only as good as its check, so the check is the part worth reading.
`voice/render.mjs --check file.wav --words "…"` exports `judge()`, which owns every threshold;
the server imports that same function, so an agent reporting the tool's numbers and the
server checking the same bytes cannot disagree. A narration is verified twice before it is
published, and each half can fail alone:

1. **The timeline describes this file.** `timeline.json` lists each phrase with `text`,
   `start` and `duration`. The phrases must be contiguous (a gap over 0.2 s is a failure),
   positive, within tolerance of the WAV's real length, and every word must be one the
   shipped lexicon can pronounce. A missing timeline is a failure, not a shrug: it is the
   record that makes the claim checkable at all.
2. **The file measures as speech.** `judge()` requires a peak well above silence, at least
   0.3 s, at least a quarter of the loud frames periodic, a floor of syllable onsets for the
   words claimed, and more than one vowel region.

Three real defects were found while building it, and each is why a check exists:

- A Chinese script produced a **0-second WAV and exit 0**. `tokenize()` dropped every token
  with no Latin letters left, so a card of Chinese silently rendered nothing. A token that
  *was* letters and now has none is pushed to `unreadable`, and the render exits 2.
- The synthesizer was a **square wave**. Three chained resonators have large gain, and a
  per-sample `clamp()` clipped 75% of samples flat. The result was periodic and
  formant-shaped - it passed a naive "looks like speech" test - and sounded like a rasp. The
  clamp is gone; the finished buffer is normalized once to 0.9 of full scale, which keeps the
  syllable envelope. `test/voice.test.mjs` asserts under 1% of samples at full scale and a
  90th/10th frame-energy ratio above 3.
- Onset detection **died on one digital-zero frame**. AAC encoder padding puts zeros at
  t=0; the noise floor stuck at 0 and no frame ever exceeded it, so a film's extracted track
  measured 0 onsets while its source WAV measured 14. Frames below 3/32768 are now excluded
  from the floor. An earlier attempt clamping the floor to `peak*0.02` over-corrected to 31
  onsets and was reverted.

The onset check is a **floor**, not an equality, and that is deliberate: this synthesizer
produces roughly two envelope rises per syllable (38 onsets for 18 syllables), so pinning
one per syllable would be tuning the threshold to its own answer. What separates speech from
a plausible impostor is the vowel-region count: a 220 Hz tone amplitude-modulated at 4 Hz
gets 15 onsets and `voicedShare 1.00`, as convincing as a sentence by those measures, and
visits one formant pair. `test/voice.test.mjs` pins tone, noise, sweep and silence as
failures for that reason.

A kept narration is evidence on the card, not just an artifact: the server stores
`{verdict, seconds, words, onsets, vowelKinds, voicedShare, peak, phrases, take, source}` on
the node, and `workspace.yml` round trips it per version, so a reopened workspace still shows
which phrases were spoken and when. The canvas prints the numbers with the script in a
tooltip.

**The words and the sound have to be the same take.** A reviewer reproduced this on the
first build of the slice: two sentences of the same syllable count render to files of exactly
the same length (3.291 s to the sample), so a check that compared the timeline with the
file's *duration* accepted either timeline beside either audio. The card then wrote one
sentence over a player that spoke another - a record worse than none, because it invites
trust.

The fix uses determinism rather than resemblance. Rendering is a pure function of the words
(the noise source is seeded from the words themselves), so `voice/bind.mjs` re-renders the
timeline's own phrases at the rate and pitch the timeline records (`timeline.voice`) and
compares the result with the published samples.

The same reviewer then broke the first version of that fix, twice, and both times the
mistake was the *unit of comparison*:

- correlating the **whole file** against the whole script averaged a 32-second take's
  difference into agreement. Twelve sentences differing only in their last two clauses
  scored **0.896** on the eight-and-a-half seconds of shared audio that dominated the sum,
  and were accepted.
- correlating **per phrase** is the same mistake one level down: a phrase reworded only at
  its end scored **0.940**, because its identical opening still carried the average.

So the comparison is now **per phrase and per frame**. Each phrase is re-rendered alone and
compared with the slice of the published WAV the timeline places it at, in 25 ms frames with
a 12.5 ms hop, and the answer is the *worst* frame that carries sound (frames the render
leaves near-silent, such as a stop's closure, are not judged). A shared prefix cannot hide a
difference at any length because there is nowhere left for agreement to be averaged into.
Measured on this voice (`node voice/audit-binding.mjs` prints all of it): the same phrase **1.000** on every frame; a
word changed **-0.344**; a phrase reworded at the end **-0.218**; an ending clause swapped
**-0.297**. `SAME_TAKE` is 0.5, which is not close to either side - an honest phrase's worst
frame is 1.000 and an edited one's is negative, because the two signals disagree about the
direction of the waveform at that instant.

That the smaller unit is necessary rather than preferred is measured, not argued, and the
same script prints it. A word substituted for one of the same rendered length is
invisible to any duration check by construction, and whole-phrase correlation rates it 0.62
(`wall` -> `hedge`, identical sample count) and 0.65 (`wall` -> `mill`) - both above the 0.5
bar that measure would have used itself, so both would have been published. Their worst
frames are **-0.567** and **-0.383**. Seven substitutions of this shape were found in one
sentence, all accepted by whole-phrase correlation and all refused frame by frame.
`test/bind.test.mjs` pins two of them and asserts the failed premise (equal length, and a
whole-phrase score that would have passed) rather than assuming it.

A phrase's length is checked before its sound, and the lengths are reported rather than a
score, because `"2.00s vs 2.63s"` says what to fix. A refusal names the phrase number, its
text, and the second of the take that is not those words, and only the phrases that actually
differ are reported - so eleven honest sentences are never blamed for one edited ending.

**A record must be able to reproduce its own audio.** The reviewer's third report was against this
very check: `voice/render.mjs --rate 1.23456 --pitch 113.45678` wrote a `timeline.json` that
recorded `1.235` / `113.457`, because the CLI rounded before writing. The server then
re-rendered at the rounded speed, the signal drifted, and an honest take failed at 0.300 on
its third phrase. Three things changed:

- **The tool records what the bytes were made with**, at full precision and after any clamping
  (`renderParagraph` now returns the effective `voice`; `synth.effectiveVoice` owns it).
- **A take the tool just wrote is verified before it is returned.** `render.mjs` runs
  `bindTake` against its own output and exits 4 with "this is a bug in the tool" rather than
  handing back a take the server would refuse. Observed to fire: with the record deliberately
  made to misquote a word, the CLI refused its own take and named the phrase.
- **A record written to a few decimals is recovered, not refused.** This is the part that could
  be abused, so it is bounded: the recorded rate is treated as a value known only to the
  precision it was written at, the search is confined to that interval, and a recovered take
  must reach **0.95** - where a true rate measures ~0.99 and a neighbouring one 0.76-0.88. A
  search grid was tried first and rejected: it settled for a 0.76 match, which is "nearly the
  recording" rather than "the recording". Recovery is also attempted when the recorded
  settings merely *scraped past* the bar (0.89 against an exact 1.000), because settling for
  the weaker explanation is how a rounding turns into a card that says "nearly these words".
- **The refusal says which kind of problem it is.** A person told "the words differ" about an
  honest take goes looking for the wrong bug. When the audio is the claimed words at a nearby
  rate, the message says the record's rate or pitch is wrong and the script is not; when it is
  not, it says the words written for that moment were not the words spoken.

The third check is about the material: every spoken word must appear, in order, in the text
the card was given (`materialText` in `server/prompt.mjs` reads the *frozen* copies, so an
upstream edit during a render cannot retroactively legitimise a script). A selection is
allowed - cutting a paragraph to one line is a normal take - but a word the material does
not contain is refused, and the refusal names it. This is what stops an agent that
"improved" the copy from publishing a fluent narration of something nobody asked for.

Evidence now carries `take.correlation` and `source: {id, artifact}`, so the card can say
`read from #2 lines.txt · matched 1.000` and a reader can tell which card's words were
spoken. `take.correlation` is the minimum across phrases, not an average, so the one number
on the card is the take's weakest sentence. `test/bind.test.mjs` pins the swap, the reorder,
the one-word edit, the one-word edit at the end of a long phrase (the case the phrase-level
version accepted), a 30-second take with a swapped ending (which asserts the failed premise:
that a whole-file correlation would have accepted it), the length mismatch, the misstated
rate, the invented word and the legacy timeline written before `voice` was recorded (which
must still verify at the defaults). `test/bind.test.mjs` also pins the reviewer's rounding
case in both directions: the tool's own take verifies at full precision *and* through a record
rounded to three decimals, while different words hidden behind a rounded record are still
refused. Each guard was observed to fail its own test with the guard disabled.

### Stress comes from the dictionary, and is read back

The dictionary marks the primary stress of every word and the engine threw those marks away at
build time, stressing syllable one of every word. `build-dict.mjs` now writes a second table
beside the pronunciations, `vendor/cmudict/stress.txt.gz`: one digit per vowel in the same
order the engine derives syllables from the same phonemes, and only for the 34,858 words whose
emphasis is *not* on the first syllable. Absence is meaningful - it means "first syllable",
which is what the engine already did - so a word the table omits is read exactly as before and
nothing is refused for being missing. Every reading of a listed word is written, not only the
off-first ones, so pattern index i stays aligned with reading index i; `test/voice.test.mjs`
walks the whole table and checks that alignment against the dictionary rather than trusting it.

The table is a **new reading set**, `cmudict-2`, and the default. Editing `cmudict-1` would
have made every take it made unreproducible, which is the defect the previous slice fixed, so
the frozen sets are pinned by hash instead: three texts at two rates must render byte for byte
what they always did. `tokenize()` attaches `stress` to a token only for `cmudict-2`, and
`synthesize()` uses it when it names a syllable the word actually has - an index past the end
is treated as "no note", because following it would move the emphasis onto the next word.

Numerals are the same problem a third time, and were solved the same way. The voice read a
number digit by digit and refused any token that was not letters or digits, so `8:30`, `1,200`
and `21st` could not be rendered at all and `1990` was said "one nine nine zero".
`voice/numbers.mjs` turns a written numeral into the words a person says, and `cmudict-3` is
`cmudict-2` plus that reading. It is a new set rather than an edit because the digit-by-digit
reading is what older takes sound like: `test/numbers.test.mjs` pins `cmudict-2`'s reading of
`1990`, pins that a numeral-free sentence renders byte-identically under `cmudict-3`, and
verifies a `cmudict-2` take of a sentence with a year through `voice/verify-take.mjs`. The
expansion happens in `tokenize()`, not in `pronounce()`: `1,200` has to become four *tokens* so
each word carries its own stress from its own dictionary entry, and one token would have been
stressed on its first syllable only. Closing punctuation is lifted off the token before the
numeral is read and put back on the last word - leaving it on made a sentence-final `1990.`
unreadable while the same number mid-sentence worked. The reader returns `null` for shapes it
does not handle (`km`, `ft`, `3/4/2024`, `1990-1995`, a mismatched ordinal suffix), and those
tokens are refused by name as before.

Whether the emphasis landed where the dictionary says is then read back out of the file by
`voice/check-stress.mjs`, which enumerates every stress assignment for the script, renders
each through the real `renderParagraph`, and reports the one that reproduces the samples
exactly. The search space is the product of the syllable counts of the multi-syllable words in
a line, so it is capped and refused rather than run for minutes on a long script. This is an
identity check, not a similarity score: there is no threshold to fit. That matters because the
first implementation *was* a score - it cut the energy envelope at its deepest minima and
called the loudest piece stressed - and measured against the dictionary it was wrong in both
directions (one piece instead of two in `toward` and `about`; a loud `sh` outweighing
`machine`'s vowel). Reproduction replaced the heuristic rather than tuning it.

The tests pin the negative control as well: `cmudict-1`'s `machine` still reads back as syllable
one, and audio this voice did not make is refused rather than matched to the closest stress.
What none of this establishes is that a *person* hears the stress; that is still the listening
test's job.

One related bug: `POST /api/node` with no explicit method gave **every** card
`method: "llm"`, so an audio card carried a text method. It now defaults to the first method
of the card's type that is actually available - `narration` for audio.

The file endpoint had two defects with one cause. It sent no `content-length` and ignored `Range`, so a media element could not learn a length or seek: Chromium reported `duration: null` for a real WAV, while an MP4 survived on its own `moov` box and looked healthy. The failure was also size-dependent — a 176 KB clip still reported a duration, a 352 KB one did not — so a short test fixture proves nothing. `sendFile` now sends a length, advertises `accept-ranges: bytes`, and answers a range request with `206`, a `content-range`, and exactly that slice (or `416` when unsatisfiable). `test/audio.test.mjs` uses a six-second clip for that reason, and fails with `Infinity` as the duration when the endpoint regresses.

## A film from canvas material

Video has its own method guide rather than re-exporting the image one, because a video card
is the only card that can be handed audio. A real run showed the cost of staying quiet about
it: the agent rendered an MP4 whose container carried a valid AAC track of pure digital
silence (`peak 0` on every sample). Every cheap check passed - MP4 container, audio stream
present, canvas plays it - and the result was a silent film. The guide now states how to mix
an input file (`publicDir` in `bundle()`, `<Audio src={staticFile(...)}/>`), requires the
picture to last as long as the sound, and requires the agent to extract the rendered track
and confirm its samples are not all zero before reporting success.

A later real run of the same shape produced **4.05 s of audible audio at peak 11506** inside a
720x404 h264 MP4, so the contract is reachable, not merely stated. The first published peak for this film was 30496 and it was wrong: the measuring
script assumed the WAV `data` chunk starts at byte 44, but ffmpeg writes a `LIST` chunk
first, so 62 header bytes were counted as samples. Walking the chunk table gives **peak
11506** over 178752 samples, and its correlation with the source 4-second WAV is ~0.9997 -
that is the number to trust, and `test/wav.mjs` now parses chunks so the mistake cannot
quietly return.

`prompt.txt` is written **before** the child is spawned. A child can be running before the
next line of the parent executes, and a run's own type and id are therefore also passed in
the environment (`HYPERMAKER_NODE_TYPE`, `HYPERMAKER_NODE_ID`) rather than re-derived by
reading that file; reading it early made a test pick the wrong fixture intermittently.

## Provenance of an artifact

A node's `sources` records what a finished artifact was built from: `{id, type, artifact}`
per input, persisted in `workspace.yml` and shown on the card as `made from #1 image
poster.png - #3 audio tone.wav`. The rules, each with a regression test that was checked by
breaking the behaviour:

- **Frozen at start.** The set is captured when the run is launched, not read again when it
  finishes. A film takes minutes; a person may rewire the canvas while watching it, and
  reading the links at completion labelled the film with materials it never saw.
- **Links are the person's.** A link added during a run is not undone when that run
  finishes: it is preparation for the next run. Only `sources` describes the finished file.
- **A failed or stopped re-run changes nothing about provenance.** The previous artifact is
  still the one on the card, so it keeps the sources it was made with.
- **Identification comes from the map key.** A node loaded from `workspace.yml` carries no
  `id` field of its own, so reading `s.id` wrote `null` for every source of a workspace read
  back from disk - which is the ordinary case after a restart. The label read `made from
  #null image`.

## Verification

TDD seams: workspace round trip/atomic write/path safety; registry; prompt order/direct input metadata; node/import/link persistence; async result validation/concurrency/failure; UI creation, scrolling, drag-link, unlink, persistence, controls, preview/download. Run `npm test`, `npm run test:e2e`, `node --check`, and `git diff --check`. `npm test` is 146 declared cases (`test/keep-card.test.mjs` adds six for the run directory and the card guard, five of which fail when the guard is disabled; `test/prepare-window.test.mjs` adds three for the run claim, the overlapping press failing with two 202s when the claim is deferred to the spawn); registry/prompt/workspace checks, three canvas-script checks, eight canvas browser cases, two media renders, one audio render, one film built from canvas material, three provenance cases, two WAV measurement cases, seven lifecycle cases, and two Stop/failure UI cases. Browser tests launch Chromium through `test/browser.mjs`, honoring `HYPERMAKER_CHROME` or `CHROME_BIN` when Playwright's own browser is not installed. Every browser test asserts that the page raised no error, and the assertions are collected rather than thrown from the event listener, because a throw there surfaces after the test has ended.

If `/tmp` is small or full, point the fixtures somewhere roomy (`TMPDIR=/var/tmp/x npm test`). Remotion writes real video next to its workspace, and a full scratch disk fails the media cases with `ENOSPC` — which looks like a code failure but is not. A directory on a Windows drive is not a substitute: Chromium cannot create its profile there.

`test/media.test.mjs` is the suite whose fixture renders rather than pretends: `test/fake-remotion-codex.mjs` bundles the composition with `@remotion/bundler`, selects it, and calls `renderStill` or `renderMedia`, then the test asserts the artifact's own bytes and the preview the canvas draws. For the image case that is the PNG signature plus a loaded `<img>` at 320x180; for the video case it is an ISO base media `ftyp` box with an h264 (`avc1`) track and a `moov` box, plus a `<video>` the browser actually decodes (`readyState >= 1`, `videoWidth` 320, non-zero duration). The two cases run against separate servers on separate ports, so the still and video fixtures cannot borrow each other's environment. Both skip (with a printed reason) when no browser exists, rather than passing green with nothing rendered. The negative controls are fixtures that only write text into a `.png` or `.mp4` file: they make the tests fail with `artifact has the PNG signature` and `a text file must not pass as an ISO base media container`, so a green result is load-bearing. The fixture takes its browser from `HYPERMAKER_CHROME`/`CHROME_BIN`; it previously hard-coded `chromium.executablePath()`, a path absent on machines that never ran `npx playwright install`, so it could not run at all.

`test/lifecycle.test.mjs` covers the run lifecycle with `test/fake-agent.mjs`, whose modes are slow, failing, and process-tree. Each assertion was checked by breaking the behaviour it protects: removing the 409, dropping `status`/`error` from the serializer, removing `adopt()`, and replacing the group kill with a child kill all make the suite red. The Stop and overlap cases wait for the agent to record its argv or start its grandchild first; without that wait an immediate Stop killed nothing and the orphan check passed vacuously.

Real Codex CLI runs were taken on 2026-11-27 (`codex-cli 0.172.0`, ChatGPT auth). The first produced a plain-text artifact; Stop and a deliberate model rejection were exercised the same way, and the rejected card carried the CLI's own message. A later **content chain** produced three artifacts in one workspace through the HTTP entry point: a 1200x675 PNG poster, a 720x405 h264 MP4 (3 s, 30 fps) rendered from that poster taken as a direct input, and a 4-second 44.1 kHz mono WAV rendered from the same input, all previewed by the canvas. `node test/chain.mjs` reproduces exactly that chain, spends real model calls, and writes screenshots plus a JSON record of every checked fact.

Two things that chain taught, which the tests alone had not:

- The agent rendered a correct PNG on the first run without using Remotion at all — it screenshotted with Playwright, because the method guide never said where a browser was. The image was fine; the *method contract* was underspecified. The guide now names `HYPERMAKER_CHROME`/`CHROME_BIN`.
- The audio card looked green while being unusable: the file existed and played, but the player could not report a length. That is why the audio test reads `audio.duration` and `audio.seekable` from the browser rather than trusting the node's `status`.

What the chain does not show is quality. One render per medium says the path works; it says nothing about whether the words, pacing or composition are good, and the fixture compositions remain two frames and a test tone.

What remains unproven locally: audio (`tts.cpp`, `bark.cpp`), `hyperframe`, and the quality presets against a real model. The fake agent reproduces the artifact contract, not agent judgment. The video path is proven at the harness level only: the render is real, but the two-frame fixture composition is not evidence that a real agent will choose sensible dimensions, codec or duration.
