// The reference a scene is compared with must be the FRAME, not the picture.
//
// The report: a 1440x180 panorama became scene two, was placed correctly in the frame (1280 wide,
// 160 tall, starting at y=280, measured independently at 0.9999), and the film was REFUSED with
// scene two scoring -0.391. The cause was in the checker, not the film: a contained picture was
// scaled to fill the 32x12 reference grid and centred in it, while the frame it was compared with was
// mostly black above and below the strip. Two correct things that disagree is the shape of a check
// that cannot pass, and loosening the threshold would have hidden it.
//
// What has to be true, and what this file holds to: the reference grid is built by placing the
// picture where the composition places it - same position, same size, same bars - and taking the
// band the frame grid takes. These cases are pure geometry plus one real render, because that is the
// failing part.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chooseFit, placePicture } from "../server/framing.mjs";
import { verifyFilm } from "../server/film.mjs";

const root = process.cwd();
const ff = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg");
const ffprobe = join(root, "node_modules/@remotion/compositor-linux-x64-gnu/ffprobe");

test("a panorama's placement is a narrow strip centred in the frame", () => {
  const place = placePicture({ width: 1440, height: 180 }, { width: 1280, height: 720 }, "contain");
  // Scale = min(1280/1440, 720/180) = 0.888.., so 1280 x 160, centred vertically at (720-160)/2 = 280.
  assert.equal(Math.round(place.rect.width), 1280);
  assert.equal(Math.round(place.rect.height), 160);
  assert.equal(Math.round(place.rect.y), 280, "the strip starts where the operator measured it");
  assert.equal(place.kept, 1, "a panorama is shown whole");
  // The rule must also CHOOSE contain for it, not cover.
  assert.equal(chooseFit({ width: 1440, height: 180 }), "contain");
});

// The real one: a panorama scene must pass its own picture check.
test("a film whose second scene is a panorama passes, and a film showing the wrong picture still fails", async t => {
  const chrome = process.env.HYPERMAKER_CHROME || process.env.CHROME_BIN;
  if (!chrome || !existsSync(chrome)) return t.skip("no browser for Remotion (set HYPERMAKER_CHROME)");
  const { harbourPng } = await import("./harbour.mjs");
  const { titleCard, firstCut } = await import("../server/offline.mjs");
  const { writeFileSync } = await import("node:fs");

  const dir = mkdtempSync(join(tmpdir(), "hypermaker-panorama-"));
  // The panorama is made by drawing a wide picture and cutting a strip, so it is a real PNG of the
  // reported shape with real content in it rather than three lines of solid colour.
  const wide = join(dir, "wide.png");
  writeFileSync(wide, harbourPng("dusk"));
  const pano = join(dir, "panorama.png");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", wide, "-vf", "scale=1440:-1,crop=1440:180:0:300", pano], { stdio: "pipe" });
  const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", pano], { encoding: "utf8" }));
  assert.deepEqual([Number(probe.streams[0].width), Number(probe.streams[0].height)], [1440, 180], "the fixture is the reported shape");

  const script = join(dir, "script.txt");
  writeFileSync(script, "The harbour wakes before the sun.\nA gull drops a shell on the stones.\nThe last boat turns for home.");
  const narration = join(dir, "narration.wav"), tl = join(dir, "timeline.json");
  execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", script, "--out", narration, "--timeline", tl, "--wpm", "150"], { stdio: "pipe" });
  const timeline = JSON.parse(readFileSync(tl, "utf8"));
  const first = await titleCard({ attemptDir: mkdtempSync(join(dir, "a-")), prompt: "The harbour lights\ncome on one by one.", cancelRef: {} });

  const sources = [
    { id: 1, type: "audio", artifact: "narration.wav", frozen: narration, phrases: timeline.phrases },
    { id: 2, type: "image", artifact: "card.png", frozen: first.artifact },
    { id: 3, type: "image", artifact: "panorama.png", frozen: pano },
  ];
  const cut = await firstCut({ attemptDir: mkdtempSync(join(dir, "cut-")), sources, cancelRef: {} });
  const panoPlace = cut.placements[1];
  assert.equal(panoPlace.fit, "contain", `a panorama is shown whole: ${JSON.stringify(panoPlace)}`);
  assert.equal(panoPlace.kept, 1);

  // THE CASE THAT WAS REFUSED. It must pass, and pass for the right reason: the strip's own pixels.
  const film = verifyFilm({ file: cut.artifact, soundtrackFile: narration, projectRoot: root, scenes: cut.scenes, placements: cut.placements });
  assert.equal(film.ok, true, `a correctly framed panorama must not be refused: ${film.problems.join("; ")}`);
  const second = film.evidence.scenes.find(s => s.scene === 1);
  assert.ok(second.agreement > 0.8, `scene two agrees with its panorama, got ${second.agreement}`);

  // NEGATIVE CONTROL: the same plan, claiming the OTHER picture. The check must still refuse, or
  // "place the picture where it sits" would have bought correctness by accepting anything.
  const relabelled = verifyFilm({
    file: cut.artifact, soundtrackFile: narration, projectRoot: root,
    scenes: cut.scenes.map((s, i) => i === 1 ? { ...s, picture: sources[1] } : s),
    placements: cut.placements,
  });
  assert.equal(relabelled.ok, false, "a scene that does not show the picture it names is still refused");
});
