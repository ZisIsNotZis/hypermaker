// The first take, read by the server itself.
//
// This method has no agent in it. The words are already on the card - a linked text card, or the
// card's own prompt - and reading them out loud is mechanical: `voice/render.mjs` ships in this
// repository, needs nothing installed, and is the same renderer an agent was told to call. What
// used to be required was a Codex install with a working model route, which is a lot to ask of
// somebody who wants to hear one sentence, and on a machine whose route does not answer it made
// the first take impossible.
//
// So `builtin` is what tells the server to produce this artifact itself. Everything around it is
// unchanged: the press claims the card, the run gets its own directory, the material is frozen,
// the card is guarded, the WAV is published under a fresh `v2-` name, the previous take becomes
// `kept v1`, and `verifyNarration` refuses a take whose bytes do not measure as speech or which
// says words the card was not given. The pace box on the card is applied to the *first* read, so
// the number a person sets is the number the first take uses.
//
// `tts.cpp` and `bark.cpp` remain the path to a natural voice for anyone who has those binaries;
// the `narration` method still hands the job to an agent, which is the path for a script the
// card's own words and pace do not already give.
export const method = {
  id: "readaloud",
  builtin: "readaloud",
  guide: [
    "The server reads the material out loud with the voice that ships with this project, at the pace set on the card.",
    "Nothing is handed to a model for this method, and no agent runs."
  ].join("\n"),
  tools: ["Node.js", "voice/render.mjs"]
};
