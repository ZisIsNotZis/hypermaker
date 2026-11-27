# Re-reading a narration at another pace: what an operator found

This file exists because three defects in the first version of `/api/repace` were found by
somebody walking the canvas, not by me and not by a test I had written. Each one is recorded
here with the reproduction that showed it, the fix, and the check that now holds it. The
reproductions lived outside this repository while the work was going on; what is written here
is what they measured, and every one of them is re-run inside the suite.

Context: the route reads the words out of a published take's own `timeline.json`, renders them
again with `voice/render.mjs` at a requested pace, and publishes only after `verifyNarration`
passes. No agent is involved. `docs/impl.md` describes the design; this file is the failure
history.

## 1. A Stop published anyway

**Reported.** The operator started a re-read, waited until the previous take was being compared,
pressed Stop, and got a receipt that said the user had stopped the run - while the card had
moved onto a new take. Their words: the selected v1 was pushed down by a v2, and the card stayed
`running`.

**Reproduced** with their instrument, which delays the previous-take re-render by 1.2 s and
writes a marker when it starts:

```
{"cancelStatus":200,"original":"versions/v1-narration.wav",
 "final":"versions/v2-narration.wav","finalStatus":"running",
 "reason":"the earlier take's own settings no longer render: Re-read stopped by the user"}
```

The cause is in that last field. `reproducesPrevious` catches every rejection from its child
process and answers `same: false`, and the kill raised by Stop arrives as exactly that: a
rejection. So the comparison reported "could not reproduce" - a legitimate outcome that does not
stop publishing - and the re-read continued. The status was `running` for the second defect's
reason.

**Fixed** by typing the stop: `server/repace.mjs` raises `StoppedError`, and
`reproducesPrevious` rethrows it instead of reasoning about it. The route checks for a stop
immediately before `publish` as well as after the first render, because the comparison is the
window a person actually stops in. `HYPERMAKER_REPACE_HOLD_BEFORE_PUBLISH_MS` holds that last
step open so a test walks the window instead of racing it.

**Check.** `test/repace.test.mjs` - "Stop during a re-read keeps the approved take and cancels
the run": same artifact afterwards, `cancelled`, no version kept. The operator's recheck then
printed `{"original":"versions/v1-narration.wav","final":"versions/v1-narration.wav",
"finalStatus":"cancelled"}`.

## 2. A successful re-read never settled

**Reported.** Alongside the first finding: the card stayed on `running`.

**Cause.** The success path wrote the new take without `status: "idle"`. The agent path gets
that from `{...result, status: "idle", error: null}`; this route built its own patch and
omitted it, so the stored status kept the `running` written at the press. Every later press was
then refused as "already generating".

I hit this myself before the report - my first end-to-end probe hung at `node 2 never settled` -
and did not look closely enough at it, which is worth writing down.

**Fixed** by writing `status: "idle", error: null` on the success patch.

**Check.** `test/repace.test.mjs` asserts `status === "idle"` after a successful re-read, and
the operator's success run printed `{"finalStatus":"idle", "beforeWpm":147.8,"afterWpm":198.5,
"sameWords":true,"onlyPace":true}`.

## 3. A no-op press spent a version

**Reported.** The box showed the take's own pace (147). The operator pressed Read again without
editing it. The card made and selected a second take: 147.2 → 147.0. No new speed was asked for,
so the version should not have moved - and repeated presses would fill the comparison panel with
takes nobody can tell apart.

**Cause.** Nothing checked the request against what the take already reads at. The rendered
paces differ by a rounding (147.2 asked, 147.0 reached), so comparing rendered paces after the
fact would let the first no-op through and only catch the second.

**Fixed** in two places, because they answer two different questions:

- before anything is created, a request for the integer the box displays is answered with
  `200` and a notice, and no take is made;
- before publishing, a render that is byte-identical to the take on the card is refused the same
  way, which covers two different requests that land on the same audio.

**Check.** `test/repace.test.mjs` - "asking for the pace a take already has is not a new take":
artifact unchanged, `idle`, no version spent, measured pace unchanged. The operator's canvas
reproduction then printed `{"after":"versions/v1-narration.wav","beforeWpm":147.2,
"afterWpm":147.2,"requestStatuses":[200]}`.

## 4. What the operator confirmed works, and one distinction worth keeping

After the fixes, the operator walked the canvas and reported: typing 120 published a take that
reads at about 120, opening compare played both panes, and the card named the selected version.

They also rendered a real MP4 and changed its narration to 120 from the canvas. The film's bytes
did not move, the card still said it was made from v1, and it said the next press would use v2 -
so re-recording the voice and re-cutting the film are visibly two actions. That distinction is
now pinned with a real Remotion render in `test/repace-ui.test.mjs`.

## Open

- Whether a person understands the voice. These takes measure as speech and are bound to their
  scripts; that is not a listening result and none is claimed.
- Whether a model obeys a pace instruction. Unchanged from `docs/evidence/README.md`: the route
  was still blocked at workspace discovery on 2026-11-28 when re-checked for this work.
- A pace control before the first read. The box appears once a take exists.
