// How a picture is placed in the film frame, and what of it survives.
//
// A real report, from a person using their own pictures: a 640x700 portrait in a 1280x720 film was
// `objectFit: cover`, which fills the frame and discards the rest. Both people in the picture lost
// their heads and their feet, and the film published anyway. Two things were wrong, and this file is
// the first half of the fix:
//
//   1. The placement had no rule. "Fill the frame" is a reasonable default for a picture that is
//      already frame-shaped, and a destructive one for a portrait, a panorama, or a careful
//      composition - and the person had no way to know which they were going to get until the film
//      was made. So the rule is stated: a picture within a small tolerance of the frame's own shape
//      fills it (bars would be a visible defect for no gain), and anything further off is shown
//      *whole*, with dark bars. Losing part of a picture is a decision; it is not made silently.
//   2. Nothing said what would happen before the render. `placePicture` is the one answer to "which
//      pixels of this picture reach the screen", and it is published with the card, so a person can
//      see the kept fraction before pressing and the card can say it afterwards.
//
// The numbers here are the renderer's: `rect` is where the placed picture sits in frame pixels, and
// `crop` is the part of the source that is visible. The composition in `server/offline.mjs` uses the
// first, and `verifyScenes` in `server/film.mjs` uses the second to compare a frame with the exact
// pixels it should show - so a checker and a renderer cannot disagree about what a scene is.

// How much of a picture can be cropped before showing it whole is the better answer. A 16:9 frame
// against 3:2 still is 6.25% off; against 4:3 it is 25% off and already worth bars. 4% keeps
// frame-shaped pictures filling the frame (where a bar would look like a mistake) and treats
// everything else as a composition to preserve.
const CROP_TOLERANCE = 0.04;

export function chooseFit(source) {
  const aspect = Number(source?.width) / Number(source?.height);
  if (!Number.isFinite(aspect) || aspect <= 0) return "cover";
  const frameAspect = 16 / 9;
  // The fraction of the picture that a cover placement would keep in each direction: the smaller of
  // the two is what survives.
  const kept = aspect > frameAspect ? frameAspect / aspect : aspect / frameAspect;
  return kept >= 1 - CROP_TOLERANCE ? "cover" : "contain";
}

// `fit` is the choice; it defaults to the rule above so a caller cannot accidentally get the old
// behaviour by forgetting to pass it.
export function placePicture(source, frame, fit = chooseFit(source)) {
  const width = Number(source?.width), height = Number(source?.height);
  const fw = Number(frame.width), fh = Number(frame.height);
  if (!(width > 0 && height > 0 && fw > 0 && fh > 0)) throw new Error(`cannot place a ${source?.width}x${source?.height} picture in a ${fw}x${fh} frame`);
  if (fit === "cover") {
    // Fill the frame: scale by the larger ratio, and the source band that is visible is the frame's
    // own shape, centred.
    const scale = Math.max(fw / width, fh / height);
    const visibleWidth = Math.min(width, fw / scale), visibleHeight = Math.min(height, fh / scale);
    return {
      fit,
      rect: { x: 0, y: 0, width: fw, height: fh },
      crop: { x: (width - visibleWidth) / 2, y: (height - visibleHeight) / 2, width: visibleWidth, height: visibleHeight },
      kept: (visibleWidth * visibleHeight) / (width * height),
      bars: null,
    };
  }
  // Show it whole: scale by the smaller ratio, centre it, and say where the bars are.
  const scale = Math.min(fw / width, fh / height);
  const placedWidth = width * scale, placedHeight = height * scale;
  const x = (fw - placedWidth) / 2, y = (fh - placedHeight) / 2;
  return {
    fit,
    rect: { x, y, width: placedWidth, height: placedHeight },
    crop: { x: 0, y: 0, width, height },
    kept: 1,
    bars: x > 0.5 ? { left: x, right: fw - x - placedWidth, top: 0, bottom: 0 } : y > 0.5 ? { left: 0, right: 0, top: y, bottom: fh - y - placedHeight } : null,
  };
}

// A sentence for a person, or null when there is nothing worth saying. "Kept 51%" is the number that
// would have warned about the reported crop, and a picture shown whole needs no warning at all.
export function placementNotice(source, place) {
  if (!place || place.fit !== "cover" || place.kept >= 0.995) return null;
  const kept = Math.round(place.kept * 100);
  const lost = place.crop.height < source.height ? "top and bottom" : "left and right";
  return `this picture is ${source.width}x${source.height} and the film is 16:9, so its ${lost} are cropped and ${kept}% of it is on screen`;
}
