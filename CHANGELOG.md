# Changelog

## Unreleased — a narration's pace is a number you can set, and the card says what you got, 2026-11-28

A person asked whether they could control the pace of a film's voice. The only setting was
`--rate`, and it meant the opposite of what it said.

**The pace knob was documented backwards.** `rate` multiplies every duration, so 0.8 makes a
take 20% shorter and 1.3 makes it 30% longer - and the code comment, the CLI's usage text, and
every sentence a writer would have read called 1.3 the *brisk* one. Measured on a 9-word line:
2.9 s at 0.8, 3.6 s at 1.0, 4.7 s at 1.3. Nothing caught it, because every pace the multiplier
allows measures as speech (0.5 is 3.85 words/second, 2.5 is 0.78), so the judge has no opinion
about pace at all. A writer following the documentation produced the wrong take and no check
disagreed.

The arithmetic was **not** flipped. Every published take records the multiplier that made its
bytes and has to keep reproducing from it; changing what the number means would make every one
of them re-render to different audio and fail its own verification. What changed is the setting
a person is given and the words around the old one:

- `--wpm N` speaks at N words per minute - 110 deliberate, 150 ordinary, 200 brisk. It is met by
  measurement, not by a constant: the take is rendered at 1.0, its words per minute counted from
  its own segment records, the multiplier corrected by the ratio, and the take re-rendered once.
  Across 110-260 wpm on a three-sentence script it lands within about 1%.
- The timeline records `pace.wpm` and, only when one was asked for, `pace.askedWpm`. The server
  recomputes the pace from the take's phrase records rather than trusting the tool's own number,
  and the card prints `asked 200 words/min, reads at 198.9`. Older takes state their pace and
  name no request, instead of having one invented for them.
- The documents state the multiplier in duration only, and the percentages are pinned by test:
  a reviewer caught `0.8 is 20% faster` in a draft, which is 25% more words per minute, not 20%
  - the reciprocal quoted as the same quantity, which is how the original got backwards.
- The method guide tells an agent which setting to pass, which not to, and that a line of the
  script is a sentence with a short gap after it while a blank line adds nothing.

**What is not established.** Whether a *model* reads "brisk" and passes 200. There is no Codex
CLI on this machine, so no run has been taken where a model chose a pace; `test/guide-pace.test.mjs`
pins the checkable half - the instruction is in the assembled prompt, with the right numbers and
the right warning, and the guide's own "within about 1%" claim is true of the tool. There is also
no pace control on the canvas: an agent can pass `--wpm` and the card shows the result, but a
person cannot set it by hand yet, and the README says so rather than implying a slider exists.

Tests: `test/pace.test.mjs` (three: a requested pace is the pace the bytes have, the multiplier
still means what it meant and the recorded multiplier reproduces the take, and a pace out of
range is refused with the limit and the pace actually reached) and `test/guide-pace.test.mjs`
(two: the instruction reaches the prompt an agent is given, and the guide's promise is measured).
Negative control for the guide test: with the two pacing lines removed from the method source it
fails at `the guide names the setting a writer should pass`. The story now asks for a pace in the
voice card's own instruction and asserts the card reports both numbers.

## Unreleased — a short film can be made, compared, and continued, and only one take sounds at a time, 2026-11-28

The slice this round was given: walk a real short-film creation flow - see what material
changed, compare against an older cut, continue from that older cut on purpose, and end up
with two cuts that genuinely play. That flow is now one rerunnable command,
`test/film-story.mjs`, and walking it found a defect the existing tests could not.

**Comparing two narrated cuts played both of them at once.** The panel draws two players
side by side, and until now nothing stopped them both sounding: pressing play on the older
take while the newer one was running left two voices over each other. The panel could
compare pictures and not sound, on a product whose films carry narration - which is the
one comparison a person opens it to make. The canvas now stops any other `audio`/`video`
when one starts, as a document-level capture listener, so it also covers a card preview
left playing behind the overlay. Pausing the other element fires its own `pause`, and that
is what clears a narration's phrase chip, so the card and the player stay in agreement.
`test/compare-playback.test.mjs` is the gate; on the code before the listener it fails with
`both takes played at once (right at 0.74s)`.

**The flow itself, and what it checks.** One stand-in agent (`test/film-story-agent.mjs`)
dispatches on the card's type and renders for real: Remotion stills and h264 film, and the
repository's own voice via `voice/render.mjs` with the guide's `--check` step. The story
walks the browser entry: words, then a narration linked from them, then a poster, then a
film linked from both; the words and the poster are rewritten and a second cut is made; the
compare panel shows the two with each take's own material version; the first cut is
restored, its narration and poster are restored upstream, and a third cut is made from that
same take with a different instruction. Three checks make "playable" mean something:
ffprobe for the container and duration, non-silent samples from the extracted track, and
the extracted track correlated against the take's **own frozen narration copy** - so a film
playing the previous take's voice is caught. On the three cuts here: 0.999 aligned, 0.017
against a different take.

**The audio check had to survive an encoder, and say so.** The first version compared at
zero lag and measured **-0.05** on an honest film: every AAC stream starts a few hundred
samples after its source, so two identical signals read as unrelated. It now searches a
bounded offset (±150 ms, far wider than an encoder delay and far narrower than a different
take), reports the lag in milliseconds beside the aligned score, and keeps the unaligned
number so nobody has to trust a bar that silently moves. Measured lag here is -941 samples,
-4.3 ms. Both cuts were also played in the browser, in both panes at once, and each clock
was asserted to advance; the card's own preview was played after a reload and asserted to
show the take the card names.

- **Three cuts of one film downloaded as three `film.mp4`.** Reported by an operator who
exported each kept take after the first cut of this slice: the bytes were each right, and
the suggested filenames were identical, so outside the canvas the takes were told apart
only by the order they were saved in. The card's title is deliberately the same across
takes - the version is shown beside it on screen - and the download name was built from
that title alone. A download now carries the take's own version before the extension
(`film-v2.mp4`); an imported constant, which has no version, keeps the name it already
had. The story exports all three takes and asserts the three names differ and each names
its own version.

Tests: `test/compare-playback.test.mjs` (one player sounds at a time, and closing the panel
leaves nothing playing) and `test/download-name.test.mjs` (two takes download under two
names that say which take they are, an imported file keeps its own, and a name with no
extension is not mangled) join the suite. Negative controls, run in an isolated export of
`f4b59a2`: `compare-playback` fails with `both takes played at once (right at 0.74s)`, and
both download cases fail, the first at `the card's take downloads as result.txt`. The story
is deliberately not part of `npm test`: it renders three films and takes a couple of
minutes. Suite: **158/158** with a usable Chromium.

## Unreleased — a revision can be read back, and one canvas cannot fall into another, 2026-11-28

The story this slice was given: make something from a line of text and a picture, change
one of those materials, make a second take, then look at both and be able to say which
material and which instruction actually went into which take - and go back to the first
take's meaning and keep editing it. Walked through the real browser entry, the story did
work; what it could not do was answer the reading-back part.

**A take said what it was asked for, never what it was made of.** The record already held
it - each version keeps a frozen copy of each source, and each source names the artifact it
came from, publish prefix included (`versions/v2-poster.png`). The card printed `poster.png`
for every take, because `shown()` strips that prefix, and the compare panes named no
material at all. Two films made from two different posters therefore read `made from #2
image poster.png`, identically. The card now prints the material's version as a qualifier
(`poster.png (v1)`), and each compare pane prints its own take's materials, so the two
panes disagree exactly when the material changed between them.

**The next press is now stated before it happens.** `made from` describes the artifact on
the card. Once the card upstream had been generated again, those were no longer the bytes
the next run would freeze - a supervisor went back to an older take, edited its prompt and
pressed Generate, and only found out afterwards which material the new take had eaten. When
the live links disagree with the take on the card, the card says `next Generate uses …`
and names the material that would be frozen; unlinking the last input says it would use no
material, rather than falling silent. Silence when they agree, because a line that repeats
the one above it teaches people to stop reading both.

**A run belongs to the workspace it was started in.** Three failures, one cause: a live run
was treated as a property of the server process and of a bare node id, while ids are per
workspace. Opening B while A was generating made B's card 1 look busy and refused its
Generate; the run that finished while B was open wrote its artifact, prompt and sources
into B's card 1; and coming back to A mid-run rewrote A's own live card as interrupted.
`running`, its attempt directories, and every line of a run now carry the workspace, and a
finished run's outcome is written into the run's own `workspace.yml` (queued per
workspace) instead of whichever canvas is on screen. Coming back to a workspace whose run
is still going keeps Stop working.

**Opening a workspace is one switch.** It used to set the path and then await recovery,
which puts back the files of a card whose run died - seconds of copying for a large card.
For that window the server answered with the new workspace's path and the old workspace's
cards. Now the new workspace's file is written first and the path and cards change
together; a failed open (a file where a folder was meant, a read-only directory) leaves the
canvas that was open exactly as it was, and the next open still works - a rejected promise
was once stored as "the open queue" and made every later open fail until a restart. An open
also waits for outcomes already queued for its workspace, so a run that finishes during an
open appears in the open's own reply.

**A key declared after its first use crashed the ordinary start.** The live-run tables are
keyed by workspace and card; that key was declared below the module-load `adopt()` that uses
it, so starting the server against a workspace that already had cards threw
`Cannot access 'slot' before initialization` and exited, while an empty workspace never
entered the loop and started fine. Every test that opened a workspace from scratch was
exactly the case that could not catch it.

Tests: `test/revision.test.mjs` (a take's material version on the card and per compare pane,
restoring the older meaning, surviving a reload, and the `next Generate` line) and
`test/workspace-switch.test.mjs` (eight cases: starting against existing cards, a failed
open leaving the canvas intact and the next open working, a read-only directory refused
without disturbing the canvas, a run finishing during an open, the two workspaces' cards
not borrowing each other's runs in either direction, a half-open workspace never being
visible, and Stop still reaching the run after switching away and back). Negative controls,
run in an isolated export of `f9b79de`: seven of the eight fail there, each at the
assertion that names its own failure; `test/revision.test.mjs` fails at its first assertion
(`got "made from #1 text result.txt"`). One of them was written badly first and passed
against the old server - a single shared release gate let the second test's run stop
blocking, so the two runs never overlapped - which is why each gate is now keyed by the
instruction it releases.
Suite: **155/155** with a usable Chromium.

## Unreleased — one press is one run, from the press itself, 2026-11-28

A supervisor found that two open canvases pressing Generate on the same card at the same
moment each got `202` and the card ended on `v3`: two agents, two guards, two publishes
for one press each. It reproduced with an 8 MiB picture next to the card - and that is the
shape of the bug. A card was marked `running` only when the agent was spawned, while the
seconds before that (adopting the old take into `versions/`, copying the frozen sources,
and above all copying every file the card holds into the run's guard) ran unmarked. The
ordinary "second Generate while running" test passed because it waited for the agent's own
`argv.json` first - it never stood in the gap.

The same gap had a second face, which the supervisor also measured: pressing Stop during
that copy was answered `not generating`, and the run went ahead and billed.

**The claim is taken synchronously in the request handler**, before the first await past
reading the body, and the object it puts in the run slot is `{agent, stopping, cancel()}`.
So the second press sees the first and is refused with `already generating`; the card is
`running` (and offers Stop) from the press; Stop before a process exists records the press
and the run is stopped the instant it starts, or is never started at all when it happens
while the snapshot is still being taken. Every reply that starts nothing - a refusal, a
thrown preparation - gives the slot back, and a release only clears the slot when it still
owns it (`releaseClaim`), so a settled run cannot free a card that has already started
again.

Tests: three in `test/prepare-window.test.mjs`, through the HTTP entry point, with the
snapshot step held open by `HYPERMAKER_HOLD_BEFORE_GUARD_MS` (tests only) so the window is
entered rather than raced. Two presses over two separate connections (a shared `fetch`
agent queues them, which is not the situation) must answer `202`/`409` and publish one
take; Stop during the preparation leaves the approved take, publishes nothing, spawns no
process, and the card can be used again afterwards; and a settled run does not release the
claim of the run that follows it. With the claim deferred back to the spawn, the first of
these fails with two `202`s - the negative control - and the other two stay green, which is
what they are for. Suite: **155/155** with a usable Chromium, 24 skipped here.

## Unreleased — a card can be redone without losing what you put beside it, 2026-11-28

The open gap was stated plainly in the README and in the status doc: the harness
kept a run out of the card's directory, but the agent was launched with
`HYPERMAKER_CARD_DIR` and `--sandbox danger-full-access`, so an agent that decided
to tidy could delete a file its owner put there and the run still reported `idle`.
A probe had measured exactly that (200 before the run, 404 after). This closes it in
layers, because no single one of them is a boundary against a process with an open
sandbox.

**The run no longer works inside the card.** A run's directory is
`<workdir>/.runs/<card>/<start>` instead of `<card>/attempts/<start>`, and
`HYPERMAKER_CARD_DIR` is no longer passed. The card's path stays in the prompt as
text, because a real agent has to read the linked material by path - and that is the
point: text is a request, a variable naming the directory is an invitation.

**The card is copied before the agent starts, and put back afterwards.** Every file
the card holds is copied into `<run>/.guard` with a sha256 in a manifest. After the
run - success, Stop, failure, or the next startup when the server died - each file is
hashed again and restored if it is gone or different, and the card says which one.
A successful run that had to repair the card is reported as an error rather than as a
clean result, because it made its output from material it modified; a stopped run
stays `cancelled` with the repair noted in the same sentence. A crash writes
`KEPT-AFTER-CRASH.txt` beside the card, since nobody was watching when it happened.

**The copies are copies, and that is the crux.** The first version hardlinked and was
wrong: the commonest way a tool saves is to reopen the existing file and write into
it, and a hardlink shares the content, so such a save changes the "saved" copy too
and an inode comparison reports the file untouched. A supervisor named this before it
shipped. The guard now holds independent bytes and compares content, and
`test/keep-card.test.mjs` writes a same-length overwrite through `openSync("r+")` to
prove it.

**A supervisor then found the boundary was invisible.** A 65 MiB clip next to a card - an
ordinary piece of video material - went through a normal run, and neither the press nor
the card said it was outside the copy tier; the old code only mentioned such files after
something had already gone wrong. The guard now has two tiers: a file up to 64 MiB is
copied (so a deletion *and* an in-place rewrite are repaired), a larger one is hardlinked
(so a deletion is still repaired, and an in-place rewrite of it is the one thing not
covered). `guardNotice` returns that sentence before the agent starts, the press that
starts the run carries it, and it is stored as `notice` on the card so closing the page
does not lose it. The first wiring of that had the notice dropped when the running record
was built from a copy taken before it - the same silence one layer down - found by the
test that reads the card mid-run.

Tests: eight in `test/keep-card.test.mjs`, all through the HTTP entry point with a
stand-in agent that deletes a file, deletes one three levels down, overwrites in
place, hangs so the run can be stopped, or hangs so the server can be killed; two more
cover the size boundary (a 65 MiB clip is announced at the press and put back when
deleted, an ordinary card gets no notice). With the guard disabled, exactly the five
damage cases fail and the clean run stays green. The supervisor then reloaded the page
mid-run, which is what a person does during a long render, and the notice was gone from
the canvas while the server still had it: the card was built without it and `sync()`
only ever cleared notices. `shell()` and `sync()` now render the stored notice, a second
supervisor-visible detail is pinned too (Stop is still offered after the reload), and
`test/canvas-protection.test.mjs` drives that in a real browser - skipped here, where no
Chromium is installed, and reported as skipped rather than passed. Suite: **143/143**
with a usable Chromium, 24 skipped here for the missing browser. What this still does not promise: a rewrite in place of a file over 64 MiB,
which the person is told about before the run, and the take on the card, which is
protected by publishing rather than by the guard.

## Unreleased — a listening sheet keeps what the listener wrote, and the score says what it is a score of, 2026-11-28

Everything here came from a supervisor filling the sheet in, not from reading the code. The tool had
already been made repeatable; what repeated use exposed is that it did not yet agree with its own
input.

**A note is a result.** The supervisor listened, could make out no words at all, left every line
blank and wrote the finding under `## Notes`. The guard added in the previous slice read only the
line bodies, so that sheet looked untouched: the re-run reported success and replaced the file.
The sheet is now read in two sections, `## Transcript` and `## Notes`, and *either* half is enough
to refuse a run (exit 3, naming `--fresh`), because "I could hear a machine and not one word of it"
is exactly what this tool exists to find out.

**Only the transcript is scored.** Next the supervisor quoted line 2 under Notes in the sheet's own
`**Line 2.** ...` shape, to say what they had heard of it. That comment was read as an answer to
line 2, and a sheet that had been 50% scored 100%. Comments are commentary: `readSheet` parses the
transcript section only, and the note is kept verbatim in `score.json` and printed with the report,
never counted.

**The receipt now agrees with the denominator.** Two sentences were false. "Unfilled lines: … - a
blank line scores as every word missed, so 50.0% covers only the lines you wrote down" - it does
not: the blank line's words stay in the denominator and count as missed, which is why a half-heard
sheet scores 50% of the whole script and not 100% of the attempt. And a blank template with no note
at all was told "every line was left blank, so the note is the whole result". Three states are now
stated differently and correctly - untouched template, half-filled, half-filled with a note - each
with its numerator and denominator (`word accuracy: 50.0% (7 of 14 words heard; words on a blank
line count as missed)`), and the report carries `hits` and `total` alongside `accuracy`.

- **`test/voice.test.mjs`** gains two tests (131 total). One pins a note-only sheet: refused, kept
  byte for byte, scored with the note as the whole result, `--fresh` still able to clear it. The
  other pins the mixed sheet in **LF and CRLF** (the section split is a regex on a heading, and CRLF
  silently broke the first version of it): accuracy 0.5, `unfilled: [2]`, the note kept exactly,
  the receipt naming line 2 and the 14-word denominator, and a blank template never described as a
  note-only result. **Negative controls, each failing only its own assertion:** reading the whole
  file as the sheet; restoring "covers only the words you wrote down"; printing the note sentence
  whenever every line is blank; and the earlier two from the previous slice still hold.
- **The sheet's own instructions** now say that hearing nothing is a result - write it under Notes
  and leave the lines blank, and the sheet will be kept as left.

Tests: **131/131** with a usable Chromium, twice, 0 skipped. What this still does not settle is
unchanged and is the point of the tool: the listening result is **empty**. Sheet-handling defects
were found by someone reading the tool while filling a sheet in, and that is what these fixes
address; none of it is a reading of whether the voice can be understood. A paired-signal check
built with the same synthesizer would only show that two renders differ, so none is being offered
as a stand-in. The answer needs a person who did not write the script; a takeaway sample (real
WAV, real h264 film, blank sheet, `key.txt` kept apart) is what `node voice/listening-test.mjs
--out <dir>` produces for that, and no recogniser exists here (`whisper`, `vosk`, `ffmpeg` absent).

## Unreleased — the player takes over from a sentence button, and a listening run is repeatable, 2026-11-27

Two ordinary things a person does with the take they just made, both found by doing them rather
than by reading the code.

**Hear a sentence, then drag the player into the next one.** A supervisor pressed sentence 1,
then moved the player's own clock into sentence 2. The sound stopped 5 ms later, at 2.93 s -
exactly where the drag had landed. Sentence 1's end-watch was still armed, its measured end had
already gone by, and the first frame it looked at paused the player. A press is now a wish about
that press and not a mode: any pause drops the armed stop, and so does any move of the clock that
is bigger than the time that has actually elapsed (a sentence ending moves the clock ~16 ms, a
drag moves it seconds). What was asked for is then heard from where the clock is, to the end of
the file, and the lit sentence follows that clock. `paused`/`seeking` alone could not make this
distinction - the player fires `seeking` a task after the frame that noticed the jump.

- **`test/narration.test.mjs` asserts the join-up, in a real browser with the real WAV:** press
  sentence 1, drag into sentence 2, require a full second of sound from where the drag landed and
  the chip lit for sentence 2; pause and require it stays paused with nothing lit; then press
  sentence 1 again and require it still stops at its own measured end (so a takeover does not
  turn the stop off for good). **Negative control:** deleting the elapsed-time comparison fails
  the drag assertion at 2.93 s and nothing else.

**A listening run leaves evidence, not scratch.** `voice/listening-test.mjs` renders a real film,
and `bundle()` was writing its ~20 MB webpack output into the system temp directory and never
removing it: 19 stale bundles, 395 MB, were found from earlier runs, and a 7.7 GB tmpfs was down
to 20 MB. Repeated runs of the same check also overwrote `transcript.md` - the one artifact in
this project that only listening can make.

- **The build happens in a scratch directory of the run's own making, outside the output
  directory, and is deleted whole.** The first version of this fix built inside `--out` and then
  removed `build/` and `public/` there - and a supervisor had real files under both names, which
  a listening run deleted. A tool may clean up after itself; it may not clean up after its user.
  The finished `listen.mp4` and the measured `film-track.wav` are copied out before the scratch
  goes. What remains in the output directory is `listen.wav`, `listen.mp4`, `film-track.wav`
  (the bytes the peak was measured on), `transcript.md`, `key.txt` and the entry file. A run into a directory whose sheet already has answers is **refused** (exit 3, naming
  `--score` and `--fresh`), and `--fresh` is the explicit way to say the old sheet may go.
  `test/voice.test.mjs` pins both: an answered sheet surviving a refused run, `--fresh` replacing
  it, two repeat runs, and a `build/` and `public/` holding the listener's own files, unchanged.
  **Negative controls:** disabling the guard fails the refused-run assertion; putting back the
  deletion of the output `build/` fails the assertion that those files survive.
- **The film stand-ins do the same in their own node directories**, because they were the other
  three callers of `bundle()`:
  `test/fake-film-codex.mjs`, `test/fake-poster-codex.mjs`, `test/fake-remotion-codex.mjs` build
  under the node directory they own and remove the output. No rendering behaviour changed.

Tests: **129/129** with a usable Chromium (was 128); the new one is the listening-run check. What
this does not settle is unchanged: nobody has filled in a listening sheet, so nothing here says a
person understands the voice. Both slices make that question cheaper to ask - hearing one line
without regenerating, and a listening sheet a re-run can no longer destroy - and neither answers
it. `node voice/listening-test.mjs` is still the only entry that can.

## Unreleased — a number keeps its meaning, or it is refused, 2026-11-27

Four ordinary lines came back reading as a different sentence. **No listening session was
involved, here or in the round below**: each line was synthesized with the real reader, the
words it chose and the bytes it published were compared with what the line says, and a
reviewer reading the output reported the mismatch. A wrong amount needs no ear to notice -
it is a different list of words, and the same words render byte for byte to the same audio.
Measured on the build that shipped them, through the real reader:

| line | before | now |
| --- | --- | --- |
| `The ticket costs $1250.` | "twelve fifty dollars" — a price read as a year | one thousand two hundred fifty dollars |
| `It costs £0.50.` | "fifty cents" — the currency replaced | fifty pence |
| `1,000,000,000,000 dollars` | "one dollars" — the magnitude dropped | one trillion dollars |
| `It is -3.5 degrees.` | "three point five" — the sign dropped | minus three point five degrees |

A second round, on a script **pasted from a page** the reviewer copied, found three more,
all of them silent:

| line | before | now |
| --- | --- | --- |
| `−3.5` (U+2212) | "three point five" — read as positive | minus three point five |
| `¥500`, `₹500` | "five hundred" — the currency dropped | refused, naming the symbol |
| `½ cup` | nothing — the symbol vanished | refused, naming the symbol |
| `3.5°`, `1990–1995` | the degree or range mark dropped | refused, naming the symbol |

A number whose reading changes the meaning is worse than a refusal: the take plays, the voice
is clear, and the sentence is about a different amount. So a sign, a currency and a magnitude
are never dropped - and a symbol the voice cannot say is refused **by name, with the reason**,
because `¥ is a currency this voice does not name` is something a writer can act on.

- **`voice/numbers.mjs` takes the reading set**, because four of its readings had to change.
  Money is read as money and never as a year; each currency says its own subunit; magnitudes up
  to a trillion are named and **past that refused** (`cardinal` returns no reading instead of
  truncating); a leading `+`/`-` is said, and so is the pasted minus `−`.
- **`unsupportedSymbols()` names what it cannot say**: other currencies, fraction symbols,
  mathematical operators, the degree sign and the range dash. `tokenize` returns the reasons
  beside the tokens, and both `voice/render.mjs` and the server's narration check pass them on,
  so the message on the card says which character to replace.
- **A numeric shape the reader declines is refused, not read as its leftover letters.** `$5M`
  used to become "five M" and `$M` became "M" - a confident reading of a shape the reader had
  just said it did not know.
- **It is a new frozen reading set, `cmudict-4`** (now `CURRENT_READINGS`). `cmudict-3` keeps
  every reading it published, **the four wrong ones included**, because a take made with it
  sounds like them: compared against a checkout of the previous commit over 83 numeric tokens
  and 13 sentences, the two agree exactly, and a `cmudict-3` take of a line containing all four
  corrected shapes still verifies through `voice/verify-take.mjs` and is named `cmudict-3`.
  A sentence with no numeral in it still renders **byte-identically** under both tables.
- **Negative controls:** reverting the reader fails both new test files; reverting **only** the
  sign reading fails exactly the three sign-related tests and nothing else.
- **The card says which symbol, not that the run directory misbehaved.** Walking the real entry
  found this: a card holding `The price is ¥500.` published no take (right) and reported
  `the run's directory was modified during the run` (wrong and misleading). A narration agent
  that hits a refused script exits before writing its final JSON, and the server's "no final
  message" branch had only ever considered a tidied directory. The renderer's own sentence is on
  the agent's stderr, so it is carried through, preferring `¥ is a currency this voice does not
  name` over Node's stack noise. `test/refusal-message.test.mjs` fails on the old message.
- **The renderer's refusal no longer ends `¥500..`** or puts a `The symbols:` label in front of
  a sentence that already names the character.
- **Tests: 128/128** with a usable Chromium (was 114/114). Eight new in
  `test/numbers-fidelity.test.mjs`, four in `test/numbers-pasted.test.mjs`, one in
  `test/refusal-message.test.mjs`, and one in `test/docs.test.mjs` that pins how the wrong
  readings were *found*: the docs may not credit them to a listening session, because none
  took place and the project does not claim a person understood the voice.
- **The evidence attribution is corrected.** This entry previously credited the four wrong
  readings to a person hearing them, and the README called the two rounds listening sessions.
  Neither was true: both rounds were the real reader's output compared with the sentence by a
  person reading it, and no one has listened to a take, here or earlier. The wording is fixed in both READMEs, the
  status page and the code comments, and the honest version is now the one a test requires.

Still unproven, and unchanged: nobody has filled in a listening sheet, so nothing here says a
person can understand the voice. Both rounds above were a person *writing* the lines and
reading the reader's output, which is enough to catch a wrong amount - the sentence is wrong
before it is ever played. Whether the corrected sentence is *understandable by ear* is a
different question, and is why `node voice/listening-test.mjs` exists.

## Unreleased — a sentence can be heard on its own, and the card agrees with the player, 2026-11-27

A creator checking a take is almost never listening to it end to end: they changed one line,
and they want to know whether *that* line came out right. The narration card already carried
the phrases and their start times - the server measures them from the published bytes - but
they were only in a tooltip, so hearing sentence three meant scrubbing through the two before
it by ear.

- **Each measured phrase is a button, and it does not cost a generation.** It moves the card's
own player to that sentence's start and pauses at its measured end. Nothing is re-rendered (a
phrase's times are facts about the published file, so re-rendering would be a different take)
and no run is started (a listen must not cost a generation). The stop is watched frame by
frame rather than on `timeupdate`, which fires only a few times a second and let the player run
a quarter of a second into the next sentence before pausing.
- **Editing one line and keeping both takes still works, and the buttons follow.** The test
  changes a line upstream, generates a second take, keeps the replaced one, goes back to it,
  and checks the buttons describe *that* take's own words - because the timings travel with the
  version they were measured on - and that `voice/verify-take.mjs` still verifies the take the
  card is showing.
- **The lit sentence is read out of the player, not remembered from the press.** A supervisor
  found the difference: play sentence 2, pause with the player's own control, and the earlier
  build left the chip lit with the clock frozen - the card claiming a sentence was playing when
  nothing was. The mark is now derived from `currentTime` and `paused` every frame and on the
  player's own events, so pausing, playing or scrubbing anywhere clears or moves it. The
  negative control is that assertion: ignoring `paused` fails it exactly.
- **No new interface beyond the buttons.** No panel, no page, no dialog: the buttons sit with
  the sentence times the card already showed, because that is where a person looks when
  deciding whether the take is right.

Tests: 128/128, still 128 - the new checks live inside the real narration test rather than as
assertions of their own, since they exercise one path with one real WAV in one real browser.

What this does not settle: whether a person *understands* the voice. Hearing one sentence
conveniently is not the same as hearing it correctly, and the listening sheet is still empty;
`node voice/listening-test.mjs` remains the way to close that, and the card now makes the
smaller question - "does this line say what I wrote?" - cheap to answer by ear.

## Unreleased — a number in a script is said, not spelled out, 2026-11-27

Ordinary narration lines with numbers in them could not be made, or were made as different
sentences. Measured on the build this slice started from, with the real renderer:

| line | before | now |
| --- | --- | --- |
| `The train leaves at 8:30.` | **refused** — `8:30` is not letters or digits | eight thirty |
| `The house was built in 1990.` | "one nine nine zero" | nineteen ninety |
| `We sold 1,200 copies.` | **refused** | one thousand two hundred |
| `It costs $5.` | "five" — the unit vanished | five dollars |
| `Prices rose 40% last year.` | "four zero" | forty percent |
| `The 21st century began in 2001.` | **refused** | twenty first … two thousand one |

A creator does not meet a robotic take of their sentence in those cases; they meet a card that
cannot be generated, or one whose audio says a different sentence while the card shows theirs.

- **`voice/numbers.mjs` reads a numeral the way a person says it**: clock times, years
  (`1100`–`2999`, without a separator, not a round hundred), ordinals with the suffix checked
  against the number (`2st` is a typo, not a reading), decades, thousands separators, decimals,
  money (with its unit, and `$0.50` as fifty cents) and percentages.
- **It is a new frozen reading set, `cmudict-3`**, not an edit to an existing one. The
  digit-by-digit reading is what takes published before it sound like, so `rules-1`,
  `cmudict-1` and `cmudict-2` keep their reading to the sample: a sentence with no numeral in
  it renders **byte-identically** under `cmudict-3` and `cmudict-2`, and a `cmudict-2` take of a
  sentence containing a year still verifies through `voice/verify-take.mjs` and is named as
  `cmudict-2` rather than mislabelled.
- **The expansion happens in `tokenize()`, not `pronounce()`**, so `1,200` becomes four tokens
  and each word takes its own stress from its own dictionary entry. One token would have been
  stressed on its first syllable and nowhere else. Closing punctuation is lifted off before the
  numeral is read and put back on the last word - without that, a sentence-final `1990.` was
  refused while the same number mid-sentence worked.
- **Unknown shapes are still refused by name.** `km`, `ft`, `3/4/2024`, `1990-1995` and a
  mismatched ordinal suffix return no reading, and the render fails with the same message as
  before. A guessed date would be a sentence confidently about a different day.
- **The method guide and `voice/render.mjs --usage` say both halves**: the shapes that are read,
  and the shapes that are refused, so an agent writing a script does not assume `km` works.
- **Negative control:** disabling the numeral table and re-running the voice suite fails exactly
  the three numeral tests (the same reading, the speech render, and the older-take verification)
  and passes the other eighteen.
- **Tests: 114/114** with a usable Chromium (was 108/108). Six new in `test/numbers.test.mjs`.

Still unproven, and unchanged by this: nobody has listened. The tests measure a signal and
compare it with a script; they cannot say a person understood the sentence, and there is no
recogniser on this machine to stand in for one. `node voice/listening-test.mjs` is still the
way to settle it.
## Unreleased — an honest take whose record was rounded still verifies, and a wrong start is not a wrong script, 2026-11-27

A supervisor found a fourth case at the same entry point, and unlike the first three it was not
about *which* file was read: it was about what the check did with an honest one. A take of four
sentences, rendered by the old rules voice, with a copy of its own timeline whose starts and
durations were kept to **two decimal places** - `4.38` for `4.3835147`, which is exactly what
the card displays - was refused as "not the sound these words make", and the phrases were blamed
for a number that had merely been rounded.

- **The cause was structural, so the fix is too.** Phrases are joined with no gap: each start is
  exactly the sum of the renders before it, and the only thing in doubt is how many places the
  record was written to. `writtenSlack` derives the permitted half-place from the number's own
  written form - two decimals is 0.005 s, which is 110 samples at 22.05 kHz, while a value
  written to the sample is exact - capped at 0.05 s, because a whole-second record is a
  different claim rather than an imprecise one. Before this the search was ±1 sample.
- **The search is coarse then fine**, because the frame test at 1103 offsets was measured to take
  minutes: whole-phrase correlation finds the position, then the same frame test decides whether
  those words are there. An exact record is treated exactly as before - no coarse pass, ±1.
- **Nothing is loosened.** A phrase can only slide inside a rounding, and an edited one still
  disagrees frame for frame wherever it lands. The supervisor's own five-case control
  (`/var/tmp/hm-rounded-fix-review.WI9fmS`) passes: exact and rounded verify at 1.000, and a
  changed first word, a changed near-equal-length ending, and a start moved 40 ms are refused.
- **A refusal no longer blames the wrong phrase.** Explaining a take with the first reading table
  tried made an honest phrase look wrong when a *previous* phrase had been read differently - the
  supervisor's one-word edit reported phrases 1 and 3 when only phrase 1 differed. The
  explanation now comes from whichever table accounts for the most audio. It only chooses the
  wording; nothing is accepted on it.
- **A right-words-wrong-time record says so.** The supervisor's 40 ms case has correct words and
  a wrong start, and the old message accused the script. The file is now searched for the phrase,
  and an exact match elsewhere is reported as "the right words, but not where the timeline puts
  them … the start time written for this phrase is wrong" - a person told "the words are wrong"
  would rewrite a sentence that is already correct.
- **An accepted take says when it was realigned** ("2 of 4 phrase(s) were found up to 96 samples
  from where the record puts them: this timeline rounded its start times"), so a rounded record
  is never presented as an exact one.
- **Negative control:** restoring the ±1 window fails only the two new rounding tests, with the
  honest take refused; the other fifteen bind tests still pass.
- **Tests: 108/108** with a usable Chromium (was 104/104). Four new, and each covers a way the
  two things can be confused: a rounded record that must verify, the precision rule itself, a
  realignment that is accepted inside a rounding and refused outside it, and the two messages
  that must never be swapped.

## Unreleased — a refused fallback says which take it picked, 2026-11-27

A supervisor ran the third case against a real card and found the same command wrong in a
third way. Two takes and their timelines were copied into a directory with no workspace record
- an archive, or a card whose record was lost - and `node voice/verify-take.mjs <dir>` verified
**v9** while **v10** was the newest publish, and announced v9 as "the newest published take".
The cause was one call: the fallback sorted filenames as strings, where `v9-` comes after
`v10-`. Answering confidently about the wrong recording is exactly the failure the two earlier
fixes were for, so it is worth naming that a card reaching ten takes is enough to hit it.

- **The publish ordinal is compared as a number.** `ordinalOf` reads the `N` in `vN-`, and a
  file with no ordinal (an artifact from before publishing existed) sorts first rather than
  last, so it can never be mistaken for the newest take. Ten takes are covered by a test; two
  of them carry different words, so the report's own text shows which file was read.
- **The guess is as specific as what it replaces.** The line now names the file and what it
  chose among - "the newest published take (`v10-narration.wav`, of 10 takes on this card) was
  checked instead" - because "the newest take" is a claim this command has now been wrong
  about, and a reader must be able to check it at a glance. It still says it is not the take
  the card is showing, and still points at naming a WAV to choose deliberately.
- **Negative control:** restoring the string sort fails only the new test, with the supervisor's
  own shape of output (v9 verified, called the newest of ten).
- **Tests: 104/104** with a usable Chromium (was 103/103).


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
  produces a file to listen to, and record the defects a listener *would* hear as a different
  word and a measurement of the signal does not (`science` → "S-S-IY-N-S", `moved` →
  "M-AA-V-EH-D"). Those were found by comparing the readings with a dictionary, not by ear. `test/docs.test.mjs` pins
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
