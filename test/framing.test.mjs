// Where a picture actually goes in a film frame, and what of it survives.
//
// A real report: a 640x700 portrait was placed into a 1280x720 film with `objectFit: cover`, which
// fills the frame and throws away everything outside it. Both people in the picture lost their heads
// and their feet, and the film published - the scene check only *ranked* the frame against the
// pictures, so a wrong-but-better-than-the-other match passed.
//
// So framing is a computation with one answer, in one place, that the renderer and the checker both
// read. `contain` shows the whole picture inside the frame, with the gaps left dark; `cover` fills
// the frame and crops. Whatever the mode, this says exactly which pixels of the source reach the
// screen, which is what makes "what will the film keep?" a question with an answer rather than a
// surprise after a two-minute render.
import test from "node:test";
import assert from "node:assert/strict";
import { chooseFit, placePicture } from "../server/framing.mjs";

const frame = { width: 1280, height: 720 };

test("a picture that already fits the frame is shown whole, with nothing cropped", () => {
  const place = placePicture({ width: 1280, height: 720 }, frame, "cover");
  assert.deepEqual(place.crop, { x: 0, y: 0, width: 1280, height: 720 }, "nothing is cropped from a frame-shaped picture");
  assert.equal(place.kept, 1, "all of it survives");
  assert.deepEqual(place.rect, { x: 0, y: 0, width: 1280, height: 720 });
  assert.equal(place.bars, null, "no letterbox for a picture that fills the frame");

  // A 4:3 landscape in a 16:9 frame, shown whole: the width fills, the height does not, so there are
  // bars above and below and nothing is lost.
  const fourThree = placePicture({ width: 640, height: 480 }, frame, "contain");
  assert.equal(fourThree.kept, 1, "nothing is lost");
  // 4:3 fitted inside 16:9 is height-limited: 720 tall, 960 wide, with side bars.
  assert.equal(fourThree.rect.height, 720);
  assert.ok(Math.abs(fourThree.rect.width - 960) < 1e-6, `the placed width is 960, got ${fourThree.rect.width}`);
  assert.ok(fourThree.bars.left > 0 && fourThree.bars.right > 0, "the gaps are at the sides");
});

test("a portrait is cropped by cover and only its middle survives - the reported loss", () => {
  // The exact shape from the report.
  const place = placePicture({ width: 640, height: 700 }, frame, "cover");
  // Cover scales so the frame is filled: scale = max(1280/640, 720/700) = 2.0, so the picture becomes
  // 1280x1400 and 680 of its 1400 pixels of height are outside the frame.
  assert.equal(place.rect.width, 1280);
  assert.equal(place.crop.width, 640, "the full width of the source is used");
  assert.ok(place.crop.height < 700, `cover must crop the height, kept ${place.crop.height} of 700`);
  assert.ok(Math.abs(place.kept - 720 / 1400) < 1e-9, `the kept fraction is the visible band, got ${place.kept}`);
  assert.ok(place.kept < 0.55, "and it is a large loss: just over half the picture");
  // The crop is centred, so it is the middle of the picture that survives.
  assert.ok(Math.abs(place.crop.y - (700 - place.crop.height) / 2) < 1e-9, "the visible band is centred");
});

test("contain keeps a portrait whole, and says where the bars are", () => {
  const place = placePicture({ width: 640, height: 700 }, frame, "contain");
  assert.equal(place.kept, 1, "contain never loses a pixel of the picture");
  assert.deepEqual(place.crop, { x: 0, y: 0, width: 640, height: 700 }, "the whole source is used");
  // Scale = min(1280/640, 720/700) = 1.0286, so the picture is 658.3 x 720: vertical bars at the sides.
  assert.ok(Math.abs(place.rect.height - 720) < 1e-6);
  assert.ok(place.rect.width < 1280);
  assert.ok(place.bars && place.bars.left > 0 && place.bars.right > 0, `bars at the sides: ${JSON.stringify(place.bars)}`);
  assert.equal(place.bars.top, 0);
});

test("the default keeps content unless the loss would be small enough to be invisible", () => {
  // A picture within a few percent of 16:9: cropping that little is not a composition decision, and
  // letterboxing it would put bars on a film that looks like it filled the frame.
  assert.equal(chooseFit({ width: 1280, height: 720 }), "cover");
  assert.equal(chooseFit({ width: 1280, height: 726 }), "cover", "a sliver of a difference is not worth bars");
  // A portrait, or a picture much wider than the frame: the person's composition would be destroyed.
  assert.equal(chooseFit({ width: 640, height: 700 }), "contain");
  assert.equal(chooseFit({ width: 700, height: 470 }), "contain");
  assert.equal(chooseFit({ width: 2000, height: 500 }), "contain", "a panorama is not cropped to a strip");
});
