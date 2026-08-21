import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.HYPERMAKER_NODE_DIR || process.cwd(); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "draw.js"), "export default () => {};\n"); writeFileSync(join(dir, "person.png"), "fake image\n");
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ prompt: "draw a person", script: join(dir, "draw.js"), artifact: join(dir, "person.png"), type: "image/png", method: "hyperframe", error: null }) } }));
