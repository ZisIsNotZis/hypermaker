import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { methodRegistry, typeRegistry } from "./registry.mjs";

const promptRoot = new URL("../prompts/", import.meta.url);
const text = name => readFileSync(new URL(name, promptRoot), "utf8").trim();
const block = (title, body) => `# ${title}\n${body || "(none)"}`;
const fileText = file => existsSync(file) ? readFileSync(file, "utf8") : "";
function inputSection(node, inputs, workspace) {
  if (!inputs?.length) return "(no direct inputs)";
  return inputs.map((id, index) => {
    const source = workspace.nodes[id];
    if (!source) return `INPUT ${index + 1}\nmissing node ${id}`;
    const dir = join(workspace.workdir, String(id));
    // A run is given a frozen copy of its material (`frozen`), not the live file:
    // the card upstream can be regenerated or hand-replaced while a film renders,
    // and an agent that reads the live file while the record says something else
    // is exactly how a version ends up claiming material it never saw.
    const artifact = source.frozen || (source.artifact ? join(dir, source.artifact) : "");
    const sourceFile = source.script ? join(dir, source.script) : "";
    const lines = [`INPUT ${index + 1}`, `directory: ${dir}`, `artifact: ${source.artifact || "(none)"}`];
    // A linked card with no artifact yet is the ordinary way a person builds a
    // chain top-down, and it used to reach the agent as a bare `(none)` - the
    // agent had no way to know it was supposed to use a file that does not exist
    // and either failed or invented its own material. Say what is there and what
    // to do about it, so the failure (if any) is about the material, not the
    // prompt's silence.
    if (!source.artifact) lines.push(`note: this input has not been generated yet; it has no artifact to use. Its directory is empty of output, so do not wait for it. Either proceed without it, or say in your final JSON error that input ${index + 1} needs to be generated first.`);
    if (source.type === "text" && artifact && existsSync(artifact)) lines.push("artifact content:", "```", fileText(artifact), "```");
    else if (artifact) lines.push(`artifact path: ${artifact}`);
    // Say plainly that this is a copy, so an agent that wants to "improve" the
    // material edits it instead of reaching for the original card's file.
    if (source.frozen) lines.push(`note: this path is a frozen copy of the material taken when this run started; read it, do not modify it.`);
    if (sourceFile && existsSync(sourceFile)) lines.push(`source: ${source.script}`, "source content:", "```", fileText(sourceFile), "```");
    const memory = join(dir, "AGENTS.md");
    if (existsSync(memory)) lines.push("AGENTS.md:", "```", fileText(memory), "```");
    return lines.join("\n");
  }).join("\n\n");
}

// The words a run was actually given to read, as text.
//
// A narration has to be a selection of its material, and checking that means reading the
// material the same way the agent did: the frozen copy of every linked *text* card, and the
// card's own prompt for the words when there is none. It deliberately does not include the
// method guide, the quality preset or AGENTS.md - those are instructions to the agent, not
// material, and a script that quoted them back would be reading its own brief rather than the
// card. `from` names the first card whose text was used, so the evidence can say whose words
// were spoken.
export function materialText({ node, workspace }) {
  const parts = [];
  let from = null;
  for (const id of node.inputs || []) {
    const source = workspace.nodes[id];
    if (!source || source.type !== "text" || !source.artifact) continue;
    const file = source.frozen || join(workspace.workdir, String(id), source.artifact);
    if (!existsSync(file)) continue;
    parts.push(fileText(file));
    if (!from) from = { id: Number(id), artifact: source.artifact };
  }
  // With no text input, the guide tells the agent to narrate the prompt itself, and that is
  // material too - otherwise such a card could never pass its own check.
  if (!parts.length && node.prompt) parts.push(node.prompt);
  return { text: parts.join("\n"), from, hadTextInput: !!from };
}

export function assemblePrompt({ node, workspace, context = {} }) {
  const type = typeRegistry.get(node.type), method = methodRegistry.get(`${node.type}/${node.method}`);
  if (!type || !method) throw new Error("Unsupported output type or generation method");
  const memory = node.id && workspace.workdir ? fileText(join(workspace.workdir, String(node.id), "AGENTS.md")) : "";
  return [
    block("SHARED PROMPT", text("shared.txt").replaceAll("{{PROJECT}}", workspace.projectCwd || process.cwd()).replaceAll("{{NODE}}", join(workspace.workdir, String(node.id))).replaceAll("{{TYPE}}", node.type)),
    block("OUTPUT TYPE", `${text(`output-${node.type}.txt`)}\n\n${text(`type-${node.type}.txt`)}`),
    block("GENERATION METHOD", `${method.guide}\nAvailable tools: ${method.tools.join(", ")}.`),
    block("QUALITY", text(`quality-${node.quality || "standard"}.txt`)),
    block("AGENTS", memory || "(none)"),
    block("INPUTS", inputSection(node, node.inputs, workspace)),
    block("CONTEXT", JSON.stringify(context, null, 2)),
    block("USER PROMPT", node.prompt || "")
  ].join("\n\n");
}
