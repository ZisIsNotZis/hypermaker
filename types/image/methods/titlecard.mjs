// One picture, drawn by the server from the card's words.
//
// This exists because a film could not have a second scene without a model. A video card laid its
// linked pictures one after another, but an image card's only methods handed the work to an agent,
// and the model route on this machine does not answer - so the "pictures" a film could be given
// were the ones a person happened to have on disk, imported by hand through HTTP. A scene is not a
// feature nobody can reach.
//
// It is the smallest honest picture: a full-frame gradient with the first line large and the rest
// beneath it, sized so a film's caption band sits under the text rather than over it. The colours
// come from the words, so two different sentences never look alike by accident.
//
// The server runs it (`builtin`), so it needs no account and no network, and it renders through the
// project's own Remotion install. The same words at the same size render byte-identical pixels,
// which is what lets a film's scene be checked against the picture it claims to show.
export const method = {
  id: "titlecard",
  builtin: "titlecard",
  guide: [
    "The server draws one 1280x720 picture from this card's words: the first line large, the rest beneath it, over a gradient whose colours come from the words.",
    "Nothing is handed to a model for this method, and no agent runs. Link it to a film card to give that film a scene."
  ].join("\n"),
  tools: ["Remotion 4", "@remotion/bundler", "@remotion/renderer", "Playwright Chromium"]
};
