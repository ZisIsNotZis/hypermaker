# The built-in voice is not understood. An installed engine is. Both were measured.

This file records a product defect that every signal-level check in this repository was blind to,
the measurements that showed it, and the measurement that shows it is fixed **when a machine has a
speech engine** - which is not every machine, so both halves matter.

Method throughout: **faster-whisper 1.2.1, model `tiny.en`, int8, cpu, `beam_size=5`,
`condition_on_previous_text=False`, `language="en"`.** Every number below came from that one
recognizer on this machine on 2026-11-28. It is a small model; a larger one would read both voices
better, and no larger one is available offline here. What a number here answers is *"can a recognizer
trained on ordinary English recover the words?"* - strong evidence, not the same claim as a person
having listened (`voice/listening-test.mjs` is still the sheet for that, still unanswered).

## The defect: the built-in voice

| Recording | Result |
| --- | --- |
| this repository's narration, one sentence | **0 segments, `""`** |
| this repository's narration, the 69-word corpus below | **0 segments, WER 1.0** |
| eSpeak saying the same 69 words | 3-4 word errors of 69, **WER 0.043** |
| this repository's narration | PocketSphinx 5.1.1 (weaker; not used for the judgement) | `"to to to to to to"` |

The 69 words are the project's own listening corpus:

```
The sea at night is never still.
It carries every colour of the sky.
The picture on the wall is a photograph of the ocean at sunrise.
Science and music change how we hear the world.
He wanted to know what the machine was doing.
Nothing about the building looks the same in the morning light.
Walk slowly down toward the house.
The garden is quiet in the rain.
```

The signature checks all passed that voice: it measured as speech, its phrases followed one another,
its words were words the voice could say, and its published bytes reproduced from its own timeline.
**Those checks were never evidence of comprehension**, which is the lesson worth keeping.

Two repairs to the synthesizer were built, measured and **reverted** - routing consonant noise around
the vowel formants (2-4 kHz went from -25 dB to -29 dB relative to the loudest band, where eSpeak is
0 dB), and raising consonant gain with source pre-emphasis (which also went unstable, caught by the
renderer's own reproducibility check). Neither moved the recognizer off zero. The honest conclusion
was that a three-formant cascade needs formant *transitions* modelled as such, which is a different
synthesizer and not a different constant.

## The fix: speak with an engine when the machine has one

`voice/engine.mjs` discovers eSpeak NG and `voice/synth.mjs` dispatches to it. Three properties made
eSpeak the right engine rather than merely an available one, each measured rather than assumed:

| Property | Measurement |
| --- | --- |
| Byte-deterministic | two renders of one phrase identical; the whole 69-word corpus re-renders identically |
| The project's own format | 22050 Hz mono 16-bit PCM - exactly `RATE`, read by `wavSamples` |
| The project's own judge accepts it | verdict `speech`, no problems (corpus: voicedShare .867, onsets 170, 9 vowel kinds) |
| A phrase re-renders alone | each phrase scores **1.000** frame agreement at its own slice; a wrong phrase fails at **-0.391** |
| Cost | ~5 ms per call, and it is a separate program - GPL-3.0 invoking into AGPL-3.0 |

### Which voice inside the engine, and why that was measured

eSpeak carries several English voices and the choice changes the bytes. On the 69-word corpus at
150 wpm:

| eSpeak voice | WER | Words recovered |
| --- | --- | --- |
| `en` (British) | 0.116 | 61/69 |
| `en-us` (American) | **0.043** | **66/69** |
| `en-gb` | 0.116 | 61/69 |

`en-us` reproduces the recorded 0.043 reference exactly and is three times fewer misheard words than
`en` on the same audio. On a four-line story at the pace a person uses (150 wpm) it is 0.100 against
0.133 for `en`. The recognizer is trained on ordinary American English, which is the likely reason,
and it does not matter for the decision: the number is what a listener would have to reconstruct.
`ENGINE_VOICE` is therefore `en-us`, and **every take records it**, because swapping it later must not
silently change the sound of a take that named the old voice.

### The end-to-end measurement, from a real film

`test/story-engine-voice.mjs` walks the whole product through the canvas - blank workspace, two
pictures brought in with **+ File**, a four-line two-act story, a narration at 150 words a minute,
both pictures and the voice dragged onto a film card - and then takes the recognizer measurement
**from the published MP4's own audio track**, after AAC, at the pace the film plays. That is what a
viewer hears; an encoder that mangled it would leave every upstream check green.

| What was measured | Result |
| --- | --- |
| The narration the server made | espeak-ng (en-us) 1.52.0, asked 150 wpm, **reads 149.7** |
| The film's own track, by the project's judge | verdict **speech**, 12.1 s, 80 onsets, 9 vowel kinds |
| The film's track against the take it names | correlation 1.000 at its place |
| **A recognizer on the film's track** | **WER 0.100, 27 of 30 words recovered, verdict `understood`** |
| What it heard | "The harbour wakes before the sun, a girl raps a shell on the stones, A evening the last boat turns for home, The water keeps the light a little longer." |
| Both acts' pictures | own scene 0.909 / 0.972; the other picture 0.507 / 0.547 |
| Captions at the pace they are spoken | worst 13.3 characters/second, comfortable 20 |
| The published take reproduces from its own record | correlation 1.000, as an engine take |

Compare the same walk's narration spoken by the built-in voice: **WER 1.0, nothing heard.** That is
the defect and the fix, measured the same way, in one file.

The numbers above are the **second** measurement of this walk. The first read **0.133, 26 of 30**,
with `harbour` heard as "harbor" and three substitutions. An independent review found that one of
those was this repository's arithmetic rather than the engine's: the WAV reader decodes 16-bit
samples as `int/32768` while the writer encodes `round(x*32767)`, so a take's audio differed from
eSpeak's own output by one step on 461 of 121800 samples. Transcribed side by side at identical
engine settings, eSpeak's bytes were heard as "harbour" and the product's rounded copy as "harbor".
The engine path now rescales so its samples return exactly the integers eSpeak wrote, and the same
walk re-measured at **0.100** with `harbour` recovered - the reviewer's prediction, confirmed.

### What the residual 0.100 is, and what it is not

Three words of thirty, and each cause was checked rather than attributed - with one of the checks
partly overturning an earlier version of this list:

* **partly this product's arithmetic, and that part is fixed** - see above. One LSB of rounding was
  enough to lose "harbour", so a small part of what had been blamed on the engine was ours.
* **not the AAC encoder** - the raw WAV transcribed identically to the extracted track;
* **the phrase silence: it depends on the speed, and it is NOT simply the engine's.** This one was
  measured three times with different answers and the record has to carry all three. A review found
  that at engine setting `-s 116` the product's own inter-phrase silence costs
  a word: eSpeak's single call over the four lines transcribed **0.067**, the product's per-phrase
  render with eSpeak's ~471 ms tail kept **0.100**, and the same with each tail trimmed to 20 ms
  back to **0.067** - the word lost was "By", heard as "a". So at that speed the losing cause is
  this project's phrase splitting, not the engine. **But the product speaks at speed 132**, and
  re-measured there the same trimming recovers nothing: tails capped at 60, 120, 200 and 1000 ms score **0.100**; the 20 ms cap worsens it to **0.133**, and at 132 the engine's *own* single call over the same lines also
  says "A evening" where at 116 it said "by evening". Nor is the phrase at fault on its own: "By
  evening the last boat turns for home." rendered alone at 132 is heard as "**My** evening ...".
  So the honest statement is narrower than either earlier version: the tail is not a defect this
  build can remove at the pace it ships (trimming did not recover `By` at any tested cap), the engine is not uniformly to blame either, and the recognizer's
  reading of a two-word function-word onset near a boundary is unstable across speeds - which is
  itself a reason not to spend a change on it;
* **not context** - probing each missed word alone and in a carrier sentence showed `gull` heard as
  "girl"/"Kyle" in every position, and `drops` heard as "raps".
* **NOT "not the pace".** An earlier version of this file said the same errors appeared at four paces
  and drew "not the pace" from it. That was wrong, and a review measured it: on this story at
  100/132/175/200 wpm the WER was 0.067 / 0.100 / 0.200 / 0.167 and **different words failed each
  time** (at 175, "and all rocks are" for "A gull drops"; at 200, "girl rocks" and "even in"). What
  survives is the narrower claim that these particular substitutions are not caused *at 150 wpm*,
  which is the pace the film is read at. Pace plainly matters, and a faster read is measurably worse.

So the remaining errors are eSpeak's front end, this project's phrase splitting at some speeds, and a
small recognizer - and the three cannot be separated by this instrument at the pace the product
ships. What is decided: the rounding was ours and is fixed; the "By"/"gull"/"drops" substitutions
are not removed by trimming the phrase tails at speed 132, so they are not worth a change there. A
larger recognizer is the way to separate the remainder, and there is none offline here.

## What this means, stated exactly

* **On a machine with eSpeak NG installed**, a new take is spoken by it, the take records the engine,
  its version and its voice, and a recognizer transcribes the published film close enough to the
  script to be understood.
* **On a machine without one**, the built-in formant voice still speaks, and **it is still not
  understood**. Nothing about this change improves it. The card says "the built-in voice" on that
  take, so a person is not left guessing why their film sounds like that.
* **No stored take changes.** `engine` is absent from every take made before this field existed, and
  absent means the built-in voice, always. Measured: the voice tests - `test/narration.test.mjs`,
  `test/voice.test.mjs`, `test/voice-takes-still-verify.test.mjs` and `test/engine.test.mjs`,
  including the fixture take that must reproduce to 1.000 and the old-rules take - are **34 tests,
  all passing with an engine installed, and 29 passing with 5 loud skips without one**. (An earlier version
  of this file said "45 tests", which matched no set of files. It was wrong.)
* **A named engine that is absent is a refusal, not a fallback** - a take that says espeak-ng spoke it
  must never be quietly re-rendered by something else. A different engine *version* is refused too: a
  later eSpeak is a different voice.

## Two things the tests got wrong, found by an operator

Both are the same class of mistake this project keeps meeting - a green check that cannot differ from
a wrong answer.

1. **The reading test re-implemented the reading.** It copied the alignment into the test file and
   asserted against that copy, so replacing the tool's verdict with the known-wrong rule ("total edits
   equal to word count means nothing was heard") left all three tests green while the tool still
   misreported. The reading now lives in `voice/transcript.mjs`, the tool and the test both import it,
   and the test drives `voice/asr-check.mjs --stub`. The wrong rule now fails two tests; that was
   checked by applying it.
2. **The voice guard forbade an intended change.** It compared the fixture's bytes against today's
   default reading table, so publishing a new table for new takes failed it - while an old take still
   verified at 1.000 under its own table. The property that matters is not "the default never changes";
   it is "an approved take reproduces from the table it recorded". The guard now renders the fixture
   with the fixture's own table.

## How to reproduce any of this

```sh
# 1. An engine, if this machine has none. Unpacking the .debs needs no root; the prefix is derived
#    from the binary, so no other variable has to be set.
export HYPERMAKER_ESPEAK=/path/to/prefix/usr/bin/espeak-ng
node voice/render.mjs --engine-check

# 2. The measurement on the project's own corpus, engine against built-in.
node voice/asr-check.mjs --python <venv/bin/python> --model <tiny-en dir> --engine espeak-ng
node voice/asr-check.mjs --python <venv/bin/python> --model <tiny-en dir>

# 3. The whole product, walked through the canvas, transcribed from the finished film.
HYPERMAKER_CHROME=<chrome> HYPERMAKER_ESPEAK=<espeak-ng> \
ASR_PYTHON=<venv/bin/python> ASR_MODEL=<tiny-en dir> node test/story-engine-voice.mjs

# 4. That no stored take changed, with an engine installed.
HYPERMAKER_ESPEAK=<espeak-ng> node --test --test-concurrency=1 test/bind.test.mjs test/voice.test.mjs
```

The old file name was `voice-not-intelligible.md`; the verdict it recorded was true of the built-in
voice and is kept above unchanged. It was renamed because "not intelligible" is now wrong as a
statement about the product and right only as one about a machine with no engine.
