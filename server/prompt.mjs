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
    const artifact = source.artifact ? join(dir, source.artifact) : "";
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
    if (sourceFile && existsSync(sourceFile)) lines.push(`source: ${source.script}`, "source content:", "```", fileText(sourceFile), "```");
    const memory = join(dir, "AGENTS.md");
    if (existsSync(memory)) lines.push("AGENTS.md:", "```", fileText(memory), "```");
    return lines.join("\n");
  }).join("\n\n");
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
