# Evidence kept outside the tests

## `real-run-stopped-at-workspace-discovery.jsonl`

The name says where it stopped, not what was wrong with the network: the first version of this
file was called `real-run-backend-unreachable`, which asserted a cause the measurements below
do not support.

The real Codex CLI's own transcript from the one attempt to have a model choose a narration
pace, taken 2026-11-27 on `codex-cli 0.172.0`. The binary is installed locally under
`~/.codex/packages/` and credentials are present, so this was not a missing-CLI problem.

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

Run the same flow through a real, authorized model entry and record which link it used:

```
HYPERMAKER_CHROME=/path/to/chrome CODEX_BIN=/path/to/codex node test/film-story.mjs
```

The evidence to keep: the narration card's `codex.jsonl` (did the model pass `--wpm`?), the
take's `timeline.json` (`pace.askedWpm` against `pace.wpm`), and a person's answer on the
listening sheet. The mechanics can be rehearsed with no model using
`test/film-story.mjs`'s stand-in agent, which is what the suite already covers.
