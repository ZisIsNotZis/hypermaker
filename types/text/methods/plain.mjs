// A text card that writes down what the person typed.
//
// The first step of every chain on this canvas is a text card, and until now every text card was
// an agent turn: `llm` hands the prompt to Codex and asks it to write a file. For a chain that
// starts from words the person already has - the ordinary first film - that is a model call to
// copy a sentence, and on a machine with no working model route it is a chain that cannot start.
// Measured: a blank canvas, one card, one sentence, Generate, and the card answered "Cannot run
// the Codex CLI ... it is not installed or on PATH". There was no way to the film after that.
//
// So this method writes the prompt to an artifact verbatim. It is not a replacement for `llm`,
// which is what a person reaches for when the words are meant to be written by a model; it is the
// case where the words are already decided.
//
// `builtin: "plain"` makes the server do it. Everything else is the ordinary run: the press claims
// the card, the artifact is published under `versions/v2-...`, the previous take is kept, and the
// text card's own prompt is what is written - not a prompt that has been rewritten by anything.
export const method = {
  id: "plain",
  builtin: "plain",
  guide: [
    "The server writes the prompt itself to a text artifact, unchanged.",
    "Nothing is handed to a model for this method, and no agent runs. Use `llm` when the words should be written by a model."
  ].join("\n"),
  tools: ["filesystem APIs"]
};
