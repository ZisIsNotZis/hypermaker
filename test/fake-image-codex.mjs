import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR || process.cwd(); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "draw.js"), "export default () => {};\n"); writeFileSync(join(dir, "person.png"), "fake image\n");
const result = { prompt: "draw a person", script: "draw.js", artifact: "person.png", type: "image", method: "hyperframe", error: null }; const output = process.argv[process.argv.indexOf("--output-last-message") + 1]; if (output) writeFileSync(output, JSON.stringify(result));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
