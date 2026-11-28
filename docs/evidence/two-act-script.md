# Two pictures → editable script → two-act film

## Real model: no draft on this host (2026-11-28)

The installed Codex CLI (0.172.0) supports `exec --image` according to its local help. The prior real probe used the existing session and CLI model defaults, without changing configuration or exporting credentials. It never verified vision support. The canvas used to override those defaults with one of three hard-coded model IDs and `medium`; it no longer does. Leave **Codex model** blank and **Effort** at **Configured in Codex**, or enter an exact vision-capable model ID supported by your route if you normally pass one explicitly.

| Attempt | Pictures | Wall time | Outcome |
| --- | --- | ---: | --- |
| CLI attachment argument check | Two synthetic PNGs | <1 s | Rejected locally, before a turn; `--` is needed to delimit the prompt after the image options. |
| Real CLI, same configured route, with `--` | Two synthetic PNGs | 105.0 s | The CLI emitted `turn.started`, then workspace-routing discovery and model-refresh errors. Deadline exit 124, no `turn.completed`, no script and no reported token usage. |

One eligible real **image** submission, zero completed generations. Server-side usage or charges cannot be inferred. The probe was outside the canvas; it establishes where that request stopped, not model behavior. This revision made **zero new real requests**. The offline route review found no different authorized vision route or evidence that discovery had recovered.

| Candidate | What is known | What is missing |
| --- | --- | --- |
| Installed Codex CLI and existing route | The CLI can attach two ordered files. A prior [text-only check](README.md#the-model-route-re-checked-2026-11-28-later-the-same-day) also failed at discovery/refresh; historical successful text runs do not show present availability. | Authenticated discovery and model refresh must work for this launch environment; the resolved model must accept both attachments and complete a turn. |
| Explicit model in the same CLI | The canvas can forward an exact model ID, including a provider prefix. | A name override does not establish access or repair discovery. Only use a model already supported by a working authorized route. |
| Alternate provider or local runtime | No separately authorized working provider was verified; the [prior offline runtime inventory](README.md#the-model-route-re-checked-2026-11-28-later-the-same-day) found no local runtime to try. CLI modes or flags alone do not establish an authorized backend. | No available backend and verified vision model for a distinct attempt. |

Once the configured route is known to work in your terminal environment with a model that supports images, launch Hypermaker from that environment (`CODEX_BIN` can point to the installed executable). Retry **once, from the canvas**, with two small synthetic images whose distinctive features are not in the brief. For example, the images from `test/harbour.mjs` have visibly different sky, coastline and boat shapes. Import the two pictures, link them in playback order to `two-act`, write a brief and press **Generate**. Only send images you intend to share with the configured route. Success means a completed turn and a published script where each line uses a real, distinct detail from its corresponding image. Then use **Edit script locally**, **Make**, `readaloud` and `firstcut`; play the first cut, swap the second picture, re-cut and verify the narration stays the same. The card's `codex.jsonl` records the stage/outcome, duration and any reported usage, not raw provider diagnostics. Until the route works, start with `plain` or choose **Write script locally** after a failed first draft. Write two lines and use the same local film pipeline.

To prepare those inputs without contacting a provider, run this from the checkout, then use `dawn.png`, `dusk.png` and `nightferry.png` from `.tmp/vision-sample/`:

```sh
node --input-type=module -e 'import {mkdirSync,writeFileSync} from "node:fs"; import {harbourPng} from "./test/harbour.mjs"; mkdirSync(".tmp/vision-sample",{recursive:true}); for (const name of ["dawn","dusk","nightferry"]) writeFileSync(`.tmp/vision-sample/${name}.png`,harbourPng(name))'
```

## Simulated CLI: complete canvas walk

In a clean checkout, install the locked dependencies (`npm ci`; `npm ci --offline` if already cached). Then run from the repository root with Chromium and eSpeak NG. The synthetic walk does not need credentials or media skill submodules. The workflow was verified in clean checkouts after an offline install.

```sh
HYPERMAKER_CHROME=/path/to/chrome \
HYPERMAKER_ESPEAK=/path/to/espeak-ng \
node test/story-author-script.mjs
```

The script launches a local app, starts at a blank canvas, imports two deliberately different synthetic pictures using **+ File**, and links them to a `two-act` card. A CLI fixture receives the two **frozen** picture files in order (checked by SHA-256) and the creative intent. It returns two sentences; it does not infer either one from the pictures. **Edit script locally** loads the draft into the editable text box and selects `plain`, leaving the published draft unchanged until Make. The edit replaced “At dusk the last boat turns for home.” with “At dusk a steady lamp guides the last boat back to shore.” The two decoded film builds kept the edited words as captions and both used the same narration take. The original generated fixture text remained readable as v1.

| Check against the film's own bytes | First cut | After dropping a new picture on the second input and pressing film Make |
| --- | ---: | ---: |
| Act one picture similarity to original act one | 0.909 | 0.909 |
| Act two picture similarity to original act two | 0.972 | −0.056 |
| Act two picture similarity to replacement | −0.357 | 0.905 |
| Decoded AAC similarity to the unchanged narration take | 0.9981 | 0.9981 |

The first film still exists; both source files outside the workspace, the old picture versions and the links are unchanged. The browser's `dragover` and `drop` both accepted the replacement. The test checks the edit against the script, narration timing record and film captions. Chromium played both 1280×720 cuts (8.02 s each), and their complete decoded audio tracks had identical SHA-256 hashes. In the current walk there are **two local fixture invocations and zero real model requests**: the first succeeds with no model or effort flags; the second uses the explicit ID `gh/fixture-vision` and `low`, emits a synthetic discovery failure, and publishes nothing. The failure card keeps its links and brief. **Write script locally** then switches to `plain`; **Make** publishes handwritten lines without starting a third CLI process. Linking the handwritten card to `readaloud` and then `firstcut` produces another playable 1280×720 cut with those captions and an audio track that decodes. The receipt, decoded frame samples and the discovery-error screenshot are regenerated under `.tmp/story-author-script/` (or `STORY_OUT`). Audio similarity proves that the same take made it into both films; no human listening test was performed.
