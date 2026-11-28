// The first film, cut by the server itself: the linked narration as the soundtrack, the linked
// poster as the picture, and the linked text's first line as the title.
//
// This is the same decision the `remotion` method hands to an agent, and the reason it is here as
// well is that it contains no creative choice a first film needs: one audio track, one still, a
// duration taken from the soundtrack. Asking a model to make that costs a model route - and on a
// machine where the route does not answer, it costs the film. The agent method stays for anything
// that needs a composition of its own.
//
// `builtin` makes the server run it. It renders a real h264 MP4 with an AAC track through the
// project's own Remotion install, and `server/film.mjs` measures the result before publishing: a
// video stream, a duration at least as long as the narration, a peak that is not silence, and an
// embedded track that correlates with the narration it was given. A film shorter than its own
// soundtrack, or one playing a different take's voice, is refused with the sentence that says
// which of those it was.
export const method = {
  id: "firstcut",
  builtin: "firstcut",
  guide: [
    "The server cuts one film from the linked material: the narration as the soundtrack, and each linked picture as one scene, in link order.",
    "Scenes are apportioned by how long the narration speaks and cut at its measured phrase boundaries, so no cut falls inside a sentence; each scene is captioned with its own words.",
    "The duration is the narration's own length. One picture is a film of one scene, and still works. More than one picture needs a narration with measured phrase times, which every take this build reads has.",
    "Nothing is handed to a model for this method, and no agent runs."
  ].join("\n"),
  tools: ["Remotion 4", "@remotion/bundler", "@remotion/renderer", "Playwright Chromium"]
};
