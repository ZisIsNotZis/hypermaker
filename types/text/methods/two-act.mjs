// One short line is one phrase in readaloud and therefore one usable act boundary in firstcut.
const shape = /^(?=.{1,100}$)[A-Za-z][A-Za-z ,;'’\-]*[.!?]$/u;

export const method = {
  id: "two-act",
  hint: "Link two PNG or JPEG pictures in act order and write a short intent. Generate sends both pictures and the intent through Codex and asks for two English narration lines.",
  guide: "Write a short English voiceover for a two-act film. The two images are attached in act order. Use a visible detail from the first image in line one and a detail from the second image in line two. Connect the two lines into a story shaped by the person's intent. Return only two nonempty lines, one short sentence per line, at most 100 characters each. Use plain English words and simple punctuation, no labels, markdown, digits, or camera directions. Do not use tools or read files; the images and brief are the entire material.",
  // The images arrive as attachments on the message; the model is told not to read files.
  tools: ["image attachments"],
  imageInputs(sources, prompt) {
    if (sources.length !== 2 || sources.some(s => s.type !== "image" || !/\.(?:png|jpe?g)$/i.test(s.artifact || ""))) {
      return "Link exactly two PNG or JPEG picture cards to two-act, in the order the film should show them.";
    }
    if (!prompt?.trim()) return "Write a short creative intent for the two-act script before pressing Generate.";
    return null;
  },
  imageReply(reply) {
    const lines = reply.trim().split(/\r?\n/).map(line => line.trim());
    if (lines.length !== 2 || lines.some(line => !shape.test(line))) {
      throw new Error("The model did not return two short English sentences, one per line. No script was published. Try a simpler intent or use plain to write the lines yourself.");
    }
    return lines.join("\n") + "\n";
  }
};
