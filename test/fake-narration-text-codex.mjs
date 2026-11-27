import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The text half of the chain. It is a stand-in only in the sense that no model chose the
// words: the person's prompt *is* the text, so writing it out is the whole job. Anything
// cleverer would make the narration test depend on a model's judgment rather than on the
// pipeline it is meant to prove.
const dir = process.env.HYPERMAKER_NODE_DIR || process.cwd();
const prompt = readFileSync(join(dir, "prompt.txt"), "utf8");
const asked = /# USER PROMPT\n([\s\S]*)$/.exec(prompt)?.[1].trim() || "";

const script = join(dir, "write-text.mjs");
writeFileSync(script, "// written by the stand-in agent\n");
const artifact = join(dir, "lines.txt");
writeFileSync(artifact, `${asked}\n`, "utf8");

const result = { prompt: asked, script, artifact, type: "text", method: "llm", error: null };
const output = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (output) writeFileSync(output, JSON.stringify(result));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
