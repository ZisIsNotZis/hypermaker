// A server-cut film: an audio link requests narration; a script and two pictures can
// also make a self-contained captioned film without a voice or a model.
export const method = {
  id: "firstcut",
  builtin: "firstcut",
  guide: [
    "For a captions-only film, link one plain text card with two nonblank lines and exactly two pictures in act order. Leave audio unlinked. The server holds each picture long enough to read its line and burns the words into an MP4 with no audio stream.",
    "For a narrated film, link a finished audio card as the soundtrack. With several pictures, cuts follow the narration's measured phrase boundaries.",
    "Nothing is handed to a model for this method, and no agent runs."
  ].join("\n"),
  tools: ["Remotion 4", "@remotion/bundler", "@remotion/renderer", "Chromium"]
};
