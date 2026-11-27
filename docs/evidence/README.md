# Evidence kept outside the tests

## `real-run-backend-unreachable.jsonl`

The real Codex CLI's own transcript from the one attempt to have a model choose a narration
pace, taken 2026-11-27 on `codex-cli 0.172.0` — the same version the README reports for the
earlier real runs. The binary is installed locally under `~/.codex/packages/` and
`~/.codex/auth.json` exists, so this was not a missing-CLI problem.

Every turn failed the same way:

```
workspace routing discovery timed out
```

while reconnecting to `https://chatgpt.com/backend-api/ps/mcp`. A probe from the same shell
says why: `chatgpt.com` returned no response at all (curl reported `000`) while `example.com`
returned `200`. The model backend is not reachable from this host; general internet access is.

**What this does not prove.** Nothing about pace. No model chose a pace, so the question the
attempt was meant to answer — whether a model reading "brisk" passes `--wpm 200` — is still
open. It stays open in `docs/impl.md` and in the changelog entry, which is why this file is
kept: so the next person does not read "no real run exists" as "nobody tried", and does not
spend another submission rediscovering the same network wall on this host.

**To close it,** run the same flow somewhere that can reach `chatgpt.com/backend-api`, with a
`CODEX_BIN` pointing at a logged-in CLI:

```
HYPERMAKER_CHROME=/path/to/chrome \
CODEX_BIN=/path/to/codex \
node test/film-story.mjs        # the stand-in path, for the mechanics
```

and then the same script with the real binary in place of the fixture. The evidence to keep is
the narration card's `codex.jsonl` (did the model pass `--wpm`?), the take's `timeline.json`
(`pace.askedWpm` against `pace.wpm`), and a person's answer to whether the words are
followable — which no measurement in this repository can substitute for.
