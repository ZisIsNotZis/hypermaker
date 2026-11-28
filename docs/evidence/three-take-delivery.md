# Find and take away the right film

The recipient did not get a version number: **find the night ferry with the line about the last boat crossing as the lights come on**. They started at `/` without reading the setup, source or workspace. Three synthetic six-second cuts include one with the caption but the wrong picture, one with the picture but the wrong caption, and the requested cut. No private material, model calls or external requests.

## Where the old path slowed down

On the pre-change local checkout, Compare initially put the wrong-picture cut on the right. The two night-ferry takes shared the same first frame and pictures and had no useful prompt. In the two panes they differed only in the text card's version number until the film reached scene 2. The recipient changed the right pick and used Play three times (the second player stopped the first), then read the actual captions to choose. No wrong file was downloaded. The browser interaction counted **5 actions to confirmation** (Compare, select, three Plays), then one Download. The roughly two minutes of wall time include tool and observation time; they are not a human usability benchmark.

The change is in Compare, not in the file path: **Find a take by picture or caption** displays each take's scene thumbnails, picture names and recorded captions before playback. The thumbnails read from the same version's frozen picture files, not the upstream card now on the canvas. Previewing a retained take changes the right pane, not the current film or the left pane. The same reviewer repeated the brief on a fresh page (they already knew the material): **Compare → Preview**, with both compare players at 0 s. They could reject the wrong-image and wrong-caption takes without playing either. The repeat's roughly 18 seconds are descriptive, not a controlled speed comparison. At 390×844 the reviewer also reproduced a nested-scroll barrier and keyboard focus escaping into the canvas. The final panel uses one scroll surface at that width and an actual modal dialog. In the reviewer's repeat, the target remained readable, Preview reached Download, Tab did not enter the canvas, and Escape closed Compare and restored focus to its button.

## The file, not the canvas

`film-v2.mp4` is 58,287 bytes in this run, SHA-256 `043b4b6aa6e0afcbdad0dba4d38ef52ea6bf803e7e35f39fa7a1552796b784ba`, matching the original retained take and the reviewer's repeat export. One H.264 video stream, 1280×720, six seconds; the captions are burned into the video, with no audio or separate subtitle stream (as intended). Download did not change the canvas selection. After the server refused connections and the original browser exited, a fresh Chromium opened the saved MP4 directly with `file://` and no HTTP(S). It showed the dawn harbour followed by the night ferry with the requested line and reached `ended` at 6.000 s.

| Delivery gate | Status |
| --- | --- |
| Import ordinary images, write captions, cut, keep/reopen edits | Walked from a blank canvas with synthetic local files; no account, speech engine or model needed. Requires an installed render Chromium and dependencies. |
| Identify and preview a retained cut by its content without changing the project | Independent GUI pass and three-cut regression. Not a claim about large collections or many similar scenes. |
| Hand over a self-contained, exact copy | Browser download and direct file playback on this machine are proven. The downloaded file does not need Hypermaker, the picture files or a subtitle file. |
| Actual delivery to another person or device | Not tested: no send/share/receipt step on this path. Use an external file-transfer channel and verify hash and playback on the recipient's target device/player. A localhost canvas URL isn't a share link. |
| Other deliverables | An editable project or separate/subtitle-toggle delivery is not established by this MP4. Narrated film has existing embedded-audio/ASR evidence, not a human listening approval. Real visual-model discovery remains unverified and was not retried. |

## Replay locally

From the repository root, with installed dependencies and `HYPERMAKER_CHROME` set to an existing Chromium executable:

```sh
STORY_OUT=.tmp/three-take-replay node test/story-captions-only.mjs --local-files --restart
```

This builds and reopens the synthetic workspace, asserts each displayed thumbnail's actual bytes and identifies the candidate by the picture and caption. It plays and downloads the matching cut, stops the server, checks the socket refuses connections, then plays only the saved file in another browser with HTTP(S) blocked. Inspect `.tmp/three-take-replay/receipt.json` (`reopened.delivery`), `find-three-takes.png`, `opened-delivered-file.png`, and `delivery/film-v2.mp4`. Hash above is from this run; the regression checks equality to the rendered cut on the machine doing the replay, not to this number.

To repeat with a person, open the test workspace in a new localhost session after the automated run:

```sh
node test/serve-delivery-workspace.mjs .tmp/three-take-replay/receipt.json
```

Give them just the printed address and the content brief, not the receipt. From the film card open Compare, select by images and captions, play the chosen pane, and download it without choosing **Use on canvas**. Close the test server with Ctrl-C and close the canvas browser. Open only the downloaded file and verify the pictures and captions. Stop short of actually transmitting any file unless that has separately been authorized.

The final replay ran from an isolated checkout based on published commit `f918a613`. The earlier action counts describe the local reviewer’s before-and-after runs. A 390×844 check also confirmed that the matching Preview leads to the download button and that Escape returns keyboard focus to Compare.
