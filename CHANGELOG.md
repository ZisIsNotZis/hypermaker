# Changelog

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
