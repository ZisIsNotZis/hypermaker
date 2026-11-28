# Evidence kept outside the tests

## `two-act-script.md`

[Two pictures → editable script → two-act film](two-act-script.md) keeps two results separate: the configured Codex CLI reached a turn but did not complete workspace discovery, while a local fixture drove the complete canvas workflow through script edit, playback and picture swap. It links the replay command and records which files and media measurements prove each step.

## `voice-not-understood.md`

An automatic recognizer transcribes the built-in voice's narration as **nothing at all** (zero
segments, WER 1.0 on the project's own 69-word corpus) while transcribing eSpeak on the same words
at WER 0.043. The file records both measurements, the 69 words, the two repairs to the synthesizer
that were tried and reverted because the number did not move, and the regression that makes changing
the synthesizer dangerous: an in-progress edit made a stored, approved take score 0.435 against its
own words instead of 1.000.

It now also records the fix and its measurement: a take spoken by an installed eSpeak NG, walked
through the canvas into a real film, is transcribed **from the published film's own audio track** at
WER 0.100 (27 of 30 words recovered) with the verdict `understood`, where the built-in voice's is
1.0. The file keeps its first reading (0.133, 26 of 30) beside it, because one of those four
errors turned out to be this repository's arithmetic rather than the engine's: the WAV reader
decoded at `/32768` while the writer encoded at `*32767`, and that one-step difference cost
`harbour` on a take that otherwise reproduced the engine. That includes why the engine's American
voice was chosen (`en-us` 0.043 against `en` 0.116 on the same corpus, both measured), what the
residual three words are - including that "not the pace" was measured false (100/132/175/200 wpm
score 0.067/0.100/0.200/0.167 with different words failing) - and what is still true on a machine
with no engine. `node voice/asr-check.mjs` reproduces the measurement;
`test/story-engine-voice.mjs` walks the whole product.

The earlier verdict is kept, not overwritten: "not intelligible" was true of the built-in voice and
is still true of a machine that has no engine. It was never true of a machine that has one.

## `repace-operator-findings.md`

Three defects in the first version of the "read this take again at another pace" route, found by
an operator walking the canvas rather than by me or by a test I had written: a Stop that published
anyway, a success that never settled the card, and a no-op press that spent a version. The file
records what each reproduction printed, what caused it, and the test that now holds it. Read it
with `docs/impl.md`'s *Reading a take again at another pace*, which describes the design the
failures were in.

## `real-run-stopped-at-workspace-discovery.jsonl`

The name says where it stopped, not what was wrong with the network: the first version of this
file was called `real-run-backend-unreachable`, which asserted a cause the measurements below
do not support.

The real Codex CLI's own transcript from the one attempt to have a model choose a narration
pace, taken **2026-11-28** on `codex-cli 0.172.0`. The binary is installed locally under
`~/.codex/packages/` and credentials are present, so this was not a missing-CLI problem.

Keep the two dates apart, because they are different runs and only one of them succeeded.
The earlier real-model success - three lines of text generated on the canvas - is from
**2026-11-27**, the receipt the README reports for `codex-cli 0.172.0`. The pace attempt
described here is the **next** day and stopped where this file says it did. A single sentence
covering both would credit the pace work with a success it never had.

Every turn failed the same way:

```
workspace routing discovery timed out
```

while reconnecting to `https://chatgpt.com/backend-api/ps/mcp`. That is the whole of what this
file shows: **the workspace-discovery step did not complete from this host**, and the model
turn never started.

### What the routes actually answered, and from where

This is deliberately narrow. "The model backend is down" is a claim these measurements do not
support, and it is written down here so nobody repeats it:

| Route | Measured from | Result |
| --- | --- | --- |
| `chatgpt.com` site (existing ChatGPT path) | the host | reaches the site |
| workspace discovery (`/backend-api/ps/…`) | the host | **451** |
| model entry point, GET with no credentials | the host | **405** (method rejected) |
| `chatgpt.com/backend-api/me`, plain `curl` | this agent's sandbox | `000` after a 10 s timeout |
| `api.openai.com/v1/models`, no credentials | this agent's sandbox | `000` after a 10 s timeout |
| `example.com` | this agent's sandbox | `200` |

So the two vantage points disagree, and that is the interesting fact rather than a nuisance: the
host can reach the site and gets a definite status from the model entry, while this sandbox gets
nothing at all from the same names. The `000` rows describe the sandbox's egress, not the machine
and not the service. A 451 on discovery and a 405 on the entry point are *answers*; treating them
as "no network" would have been the wrong conclusion to draw from the same evidence.

The sandbox is also not a clean vantage point for another reason: it is not where a real run
would be launched from, and its network path is not the host's.

**What remains unproven.** Whether a model reading "brisk" passes `--wpm 200`, and whether its
narration is followable. The first needs a real, authorized model entry point that completes
workspace discovery — not merely a reachable hostname — and the evidence has to name which
route it went through, because these routes answer differently. The second needs a person; see
below.

**Not repeated.** No further failed rounds were run to "confirm" the failure. One transcript is
enough to show where it stopped, and repeating it spends a submission to learn nothing.

### To close it

The story script now says which agent it runs, because the first version of this section
gave a command that did not do what it said: the script built its own stand-in and passed it
as `CODEX_BIN`, so a real binary named on the command line was ignored, three films were
produced, and the run exited 0. A supervisor found it by pointing `CODEX_BIN` at a probe that
records calls and exits immediately: the probe was never called.

```
# the mechanics, no model, no account
node test/film-story.mjs                      # or: --agent stand-in

# a real model, through the CLI you name
HYPERMAKER_CHROME=/path/to/chrome \
CODEX_BIN=/path/to/codex node test/film-story.mjs --agent real
```

`--agent real` refuses to start without `CODEX_BIN`, refuses a `CODEX_BIN` that points at this
repository's stand-in, and records both the agent and the per-card agent transcripts in
`receipt.json`, so a receipt cannot be read as the other kind of run. A bare `--agent` with no
value is a usage error rather than the default branch: it used to be indistinguishable from
no flag at all and quietly ran the stand-in, which is the one thing somebody writing `--agent`
was not asking for. An exported `CODEX_BIN`
with no `--agent` flag is reported as ignored rather than silently unused. Whichever entry is
used, record **which route** the model went through: the table above shows that these routes
answer very differently, and "a model ran" is not the same claim as "discovery succeeded".

The evidence to keep: the narration card's `codex.jsonl` (did the model pass `--wpm`?), the
take's `timeline.json` (`pace.askedWpm` against `pace.wpm`), and a person's answer on the
listening sheet. The mechanics can be rehearsed with no model using
`test/film-story.mjs`'s stand-in agent, which is what the suite already covers.

## The model route, re-checked 2026-11-28 (later the same day)

Asked to judge whether a supported route existed before promising a film with real model
participation, rather than assuming. **One** probe was spent; it reproduced the earlier failure
exactly, so no further rounds were run to "confirm" it.

| What was checked | Result |
| --- | --- |
| `codex` on `PATH` | **not present** (the binary is installed, just not exposed there) |
| the installed binary | `~/.codex/packages/app-server-daemon/current/codex`, `codex-cli 0.172.0`, `exec` subcommand present |
| `codex exec --json 'Reply with the single word: ready'` | **exit 124 after 180 s**; `workspace routing discovery timed out`, then `failed to refresh available models: request timed out` |
| a local runtime as an alternative | no configured local model runtime was available on the validation machine |

We did not find a working, supported real-model route on this host. This probe timed out at discovery, consistent with the earlier record; it did not establish the cause or test another authorized provider.
What follows from it: the half of the request that asks for "a film in which a real model takes
part" cannot be delivered here, and no receipt may claim it. The other half - a short film a
person composes from two of their own materials, where both acts read at ordinary speed - is
delivered and measured without a model, and its receipts name the model-free path explicitly
(`test/story-engine-voice.mjs`, `test/story-replace-material.mjs`).

This is a fact about **this host**, not about the product: `server/codex.mjs` matches the real
binary's contract and the route has worked before (2026-11-27). It is worth re-checking on a host
where discovery completes; the receipt has to name which route it went through, because the
routes answer very differently.
