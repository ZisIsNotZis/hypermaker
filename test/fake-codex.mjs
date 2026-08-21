import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const outputDir = process.env.HYPERMAKER_NODE_DIR || process.cwd();
if (process.env.FAKE_CODEX_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_CODEX_DELAY)));

console.log(JSON.stringify({ type: "turn.started" }));
console.log(JSON.stringify({ type: "reasoning", text: "Inspecting Chinese prompt" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "function_call", name: "write_file", arguments: "{}" } }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", output: "render complete" } }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", output: process.cwd() } }));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "compose.js"), "export default function compose(){return 'ok'}\n");
writeFileSync(join(outputDir, "xiaoming_persona.txt"), "程序员小明：热爱编程。\n");
writeFileSync(join(outputDir, "AGENTS.md"), "Keep text artifacts plain UTF-8.\n");
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ prompt: "optimized Chinese prompt", script: "compose.js", artifact: "xiaoming_persona.txt", type: "text", method: "LLM", error: null }) } }));
