# Two handwritten lines → a captions-only film

Measured 2026-11-28 with **no usable speech engine** in the replay environment. No model, account or image upload was used.

## What a person does

1. Start from a blank canvas. Add a `plain` text card and write two short lines:

   ```
   The flood washes the market road away.
   By dawn, the village takes the high crossing.
   ```

2. Make two `titlecard` image cards locally. Link the text and then both pictures to a `firstcut`
   video card. The card says **Captions only (no audio)**.
3. Press **Make**, play the film. Change only the second picture card, press **Make** again, then
   choose **kept v1** to restore the first film. The links stay in place.

The script was [test/story-captions-only.mjs](../../test/story-captions-only.mjs). It drives the
real canvas and blocks every non-local browser request. It also blocks both upload routes, and
sets a Codex fixture that would write a marker if called; no marker was written.

Replay from the repository root, with a local Chromium:

```bash
export HYPERMAKER_CHROME=/path/to/existing/chromium
node test/story-captions-only.mjs
```

Set `STORY_OUT=/some/dir` to choose where evidence is kept. Otherwise it is written to
`.tmp/story-captions-only/`.

## What the run measured

- The model was never invoked and no browser request left `127.0.0.1`; image upload was never used.
- The first MP4 is 6.00 seconds, 1280×720 h264. `ffprobe` lists **one video stream and zero audio
  streams**. Its SHA-256 is `bfd3ebf8a073d02367b4c840b3966c8a3120d9d1d637ee21258a4bc4f5613ac5`.
- The two scenes are 0–3 s and 3–6 s. Their captions are the two distinct handwritten lines. The cues
  are on screen for 3 s each at 12.7 and 15.0 characters/s, below the 20 characters/s gate.
- Each scene's midpoint frame was compared with its source picture: 0.927 and 0.915.
  The bright caption region was present at each scene's first, middle and last sampled frame.
- Chromium played the first MP4 from `0:00` through both acts to its natural end (`ended: true`).
- Changing only act II's image card produced a different MP4. Act I's extracted frame stayed
  byte-identical; act II's changed.
- The visible **kept v1** button restored the original MP4 byte for byte, and Chromium played that
  original again. The three links were unchanged, and the second cut remained listed as `v2`.
  The saved workspace record gives both the restored film and its kept alternative their own
  scene plan and composition path.

Screenshots in the evidence directory show the first cut and the restored card. `first.mp4` and
`recut.mp4` are the playable results; `receipt.json` has the measured timings, scene matches and film hashes. The two extracted midpoint frames are visual evidence of the words, not only of caption
pixels.

## What this does not claim

- It did not use a real photo pair. Both pictures were locally rendered title cards, because the
  walk deliberately made no upload. The scene matcher can reject a pair that is visually too
  similar; distinct title cards have a clear enough match.
- It did not test a machine with a speech engine. The narrated path is covered by the existing
  `npm test` film tests and remains selected when audio is linked.
- A web-page reload was tested, not a server restart. The replay separately parses the saved workspace to check the kept film record.
