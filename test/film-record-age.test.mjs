import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserPath, launchBrowser } from "./browser.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";
import { writeWorkspace } from "../server/workspace.mjs";

// A card says what its take measured, never what today's check would have measured.
//
// When the narration check was strengthened from "one sampled window" to "every tenth of a second
// the narration speaks", the card was written to call the number a `worst window` and print the
// coverage. Films made before that have a correlation and no window count - they were measured a
// weaker way - so the new wording handed them a claim nobody had made about them. A supervisor
// opened an accepted 5.65 s film, read `worst window` beside a promise that every tenth of a second
// had been checked, and had to say so. The rule that came out of it is one line: the label comes
// from the record, not from the build showing it.
//
// This test writes the older record by hand, because the point is a file written before this build
// existed: a workspace with a published film, measured the old way. Opening it must show the old
// measurement, must not print a coverage figure, and must not touch or re-measure the film.
const root = process.cwd();
const chrome = browserPath();
const skip = existsSync(chrome) ? null : `no browser (set HYPERMAKER_CHROME); looked at ${chrome}`;

test("an older film's card describes the measurement it has, and the film is not remade", async t => {
  if (skip) return t.skip(skip);
  const base = mkdtempSync(join(tmpdir(), "hypermaker-old-film-"));
  const workdir = join(base, "ws");
  mkdirSync(join(workdir, "7", "versions"), { recursive: true });
  // This is a question about what the *card* says, and the card's line is built from the record
  // alone - so the published file only has to exist. Its bytes are deliberately not a playable MP4,
  // and this test asserts nothing about playback; `test/first-cut.test.mjs` plays real film.
  const filmFile = join(workdir, "7", "versions", "v1-film.mp4");
  writeFileSync(filmFile, Buffer.from("a published film from an earlier build"));
  const before = readFileSync(filmFile);
  // The older record, exactly as the previous build wrote it: windows after the film's name, and
  // a correlation with no `windows`. It is written through the real serializer so this test cannot
  // drift from the file format - what is old about it is the *shape of the measurement*, which is
  // the thing under test.
  writeWorkspace(workdir, {
    7: {
      x: 0, y: 0, inputs: [], type: "video", method: "firstcut", prompt: "", quality: "standard",
      script: "versions/v1-first-cut-source.jsx", artifact: "versions/v1-film.mp4", status: "idle", error: null,
      film: { seconds: 5.65, frames: 170, fps: 30, width: 1280, height: 720, videoCodec: "h264", audioCodec: "aac", peak: 0.63, correlation: 0.999, lagSamples: -941, soundtrackSeconds: 5.6 }
    }
  });
  let app;
  try {
    const port = await freePort();
    app = startServer({ cwd: root, port, env: { HYPERMAKER_WORKDIR: workdir, HYPERMAKER_CHROME: chrome } });
    await waitReady(port);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      await page.goto(`http://127.0.0.1:${port}/`);
      const line = page.locator(".card[data-id=\"7\"] .film");
      await line.waitFor({ state: "visible", timeout: 10000 });
      const text = await line.innerText(), title = await line.getAttribute("title");
      assert.match(text, /matched 0\.999/, `the old number is still the number: ${text}`);
      assert.doesNotMatch(text, /worst window/, `an old take must not be relabelled as a worst window: ${text}`);
      assert.doesNotMatch(text, /windows/, `and must not claim a coverage figure it never had: ${text}`);
      assert.match(text, /one sampled window/, `it should say what its measurement was: ${text}`);
      assert.match(title, /earlier check/, `and the tooltip should say the same: ${title}`);
    } finally {
      await browser.close();
    }
    // Opening a workspace is a read: the take it holds must be byte-identical afterwards, and no
    // new version may have appeared. A person who did not ask for a new film did not get one.
    assert.deepEqual(readFileSync(filmFile), before, "the old film was not rewritten");
    const versions = readFileSync(join(workdir, "workspace.yml"), "utf8");
    assert.match(versions, /versions\/v1-film\.mp4/, "the film is still the one published before");
  } finally {
    stopServer(app);
    stopAll();
  }
});
