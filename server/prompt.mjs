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
