import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assembledPrompt, discover, eventFromLine, generate, methodsFor } from "../server/index.mjs";

test("discovers manifest DAG and deduplicates shared input", () => {
  const root = mkdtempSync(join(tmpdir(), "hypermaker-")), shared = join(root, "shared.txt"); writeFileSync(shared, "shared");
  const dir = join(root, "out"); mkdirSync(dir); const out = join(dir, "out.txt"); writeFileSync(out, "out");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, prompt: "p", inputs: { "shared.txt": "../shared.txt" }, script: "make.js", output: "out.txt", type: "text", method: "llm" }));
  const nodes = discover(out); assert.equal(nodes.size, 2); assert.equal(nodes.get(out).inputs["shared.txt"], shared);
});
test("malformed and missing manifests remain visible", () => {
  const root = mkdtempSync(join(tmpdir(), "hypermaker-")), file = join(root, "x.txt"); writeFileSync(file, "x"); writeFileSync(join(root, "manifest.json"), "{");
  assert.equal(discover(file).get(file).status, "warning");
  const missing = join(root, "missing.txt"), out = join(root, "out.txt"); writeFileSync(out, "o"); writeFileSync(join(root, "manifest.json"), JSON.stringify({ version: 1, inputs: { missing }, prompt: "", script: "x", output: "out.txt" })); assert.equal(discover(out).get(out).status, "warning");
});
test("normalizes trajectory and generates draft with supported Codex flags", async () => {
  assert.equal(eventFromLine("plain reason", "n").kind, "reason"); assert.equal(eventFromLine(JSON.stringify({ type: "item.completed", item: { type: "reasoning", id: "item_0", text: "✨" } }), "n"), null); assert.equal(eventFromLine(JSON.stringify({ type: "turn.started" }), "n"), null); assert.equal(eventFromLine(JSON.stringify({ type: "function_call", name: "x", arguments: "{\"a\":1}" }), "n").kind, "tool_call"); assert.equal(eventFromLine(JSON.stringify({ item: { type: "command_execution", output: "ok" } }), "n").kind, "tool_result");
  assert.equal(eventFromLine(JSON.stringify({ item: { type: "command_execution", output: "" } }), "n"), null); assert.equal(eventFromLine(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "pwd" } }), "n").input, "pwd");
  const root = mkdtempSync(join(tmpdir(), "hypermaker-fake-")), fake = join(root, "codex");
  writeFileSync(fake, `#!/bin/sh\nnode ${JSON.stringify(join(process.cwd(), "test/fake-codex.mjs"))}\n`); chmodSync(fake, 0o755);
  const workdir = join(process.cwd(), ".hypermaker", "nodes", `test-${Date.now()}`); mkdirSync(workdir, { recursive: true }); const events = [], old = process.env.CODEX_BIN; process.env.CODEX_BIN = fake;
  try { await generate({ nodeId: "draft:test", workdir, type: "text", method: "llm", prompt: "为程序员小明设计一个详细的人设", inputs: {} }, event => events.push(event)); } finally { if (old) process.env.CODEX_BIN = old; else delete process.env.CODEX_BIN; }
  assert.ok(events.some(e => e.kind === "tool_call")); assert.ok(events.some(e => e.kind === "tool_result")); assert.ok(events.some(e => e.kind === "tool_result" && e.output === process.cwd())); assert.equal(events.at(-1).kind, "complete"); assert.ok(readFileSync(join(workdir, "manifest.json"), "utf8").includes("xiaoming_persona.txt")); assert.ok(events.find(e => e.kind === "command").text.includes("plain UTF-8 text"));
});

test("accepts MIME output types returned by Codex and normalizes them to artifact types", async () => {
  const root = mkdtempSync(join(tmpdir(), "hypermaker-mime-")), fake = join(root, "codex"), workdir = join(process.cwd(), ".hypermaker", "nodes", `mime-${Date.now()}`);
  writeFileSync(fake, `#!/bin/sh\nnode ${JSON.stringify(join(process.cwd(), "test/fake-image-codex.mjs"))}\n`); chmodSync(fake, 0o755); mkdirSync(workdir, { recursive: true });
  const old = process.env.CODEX_BIN; process.env.CODEX_BIN = fake;
  try { const result = await generate({ nodeId: "draft:mime", workdir, type: "image", method: "hyperframe", prompt: "draw a person", inputs: {} }); assert.equal(result.type, "image"); assert.equal(result.method, "hyperframe"); }
  finally { if (old) process.env.CODEX_BIN = old; else delete process.env.CODEX_BIN; }
});

test("supports remotion image and video methods in registry", () => {
  assert.deepEqual(methodsFor("image"), ["hyperframe", "remotion"]);
  assert.deepEqual(methodsFor("video"), ["hyperframe", "remotion"]);
});

test("generates a real Remotion image artifact", { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hypermaker-remotion-")), fake = join(root, "codex"), workdir = join(process.cwd(), ".hypermaker", "nodes", `remotion-${Date.now()}`);
  writeFileSync(fake, `#!/bin/sh\nnode ${JSON.stringify(join(process.cwd(), "test/fake-remotion-codex.mjs"))}\n`); chmodSync(fake, 0o755); mkdirSync(workdir, { recursive: true });
  const old = process.env.CODEX_BIN; process.env.CODEX_BIN = fake;
  try { const result = await generate({ nodeId: "draft:remotion", workdir, type: "image", method: "remotion", prompt: "draw", inputs: {} }); assert.equal(result.type, "image"); assert.equal(result.method, "remotion"); assert.match(readFileSync(result.artifact).toString("ascii", 0, 8), /PNG/); }
  finally { if (old) process.env.CODEX_BIN = old; else delete process.env.CODEX_BIN; }
});

test("generates a real Remotion video artifact", { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hypermaker-remotion-video-")), fake = join(root, "codex"), workdir = join(process.cwd(), ".hypermaker", "nodes", `remotion-video-${Date.now()}`);
  writeFileSync(fake, `#!/bin/sh\nREMOTION_TEST_VIDEO=1 node ${JSON.stringify(join(process.cwd(), "test/fake-remotion-codex.mjs"))}\n`); chmodSync(fake, 0o755); mkdirSync(workdir, { recursive: true });
  const old = process.env.CODEX_BIN; process.env.CODEX_BIN = fake;
  try { const result = await generate({ nodeId: "draft:remotion-video", workdir, type: "video", method: "remotion", prompt: "animate", inputs: {} }); assert.equal(result.type, "video"); assert.equal(result.method, "remotion"); assert.match(readFileSync(result.artifact).toString("ascii", 0, 12), /ftyp/); }
  finally { if (old) process.env.CODEX_BIN = old; else delete process.env.CODEX_BIN; }
});

test("assembles only direct inputs with injected memory, metadata, and fixed section order", async () => {
  const root = mkdtempSync(join(tmpdir(), "hypermaker-prompt-")), workdir = join(root, "node"), parent = join(root, "parent.txt"), image = join(root, "asset.png");
  mkdirSync(workdir, { recursive: true }); writeFileSync(join(workdir, "AGENTS.md"), "remember plain output\n"); writeFileSync(parent, "direct text\n"); writeFileSync(image, Buffer.from("not-a-real-image")); writeFileSync(join(root, "make-parent.js"), "export default () => 'direct text';\n"); writeFileSync(join(root, "AGENTS.md"), "input memory\n"); writeFileSync(join(root, "manifest.json"), JSON.stringify({ version: 1, inputs: {}, script: "make-parent.js", output: "parent.txt", type: "text", method: "llm" }));
  const prompt = assembledPrompt({ workdir, type: "text", method: "llm", prompt: "user request", inputs: { "parent.txt": parent, "asset.png": image }, context: { inputs: { "parent.txt": parent, "asset.png": image } } });
  const sections = ["# SHARED PROMPT", "# OUTPUT TYPE", "# GENERATION METHOD", "# CURRENT AGENTS.md", "# DIRECT INPUTS", "# CONTEXT", "# USER PROMPT"];
  for (let i = 1; i < sections.length; i++) assert.ok(prompt.indexOf(sections[i - 1]) < prompt.indexOf(sections[i]));
  assert.match(prompt, /remember plain output/); assert.match(prompt, /direct text/); assert.match(prompt, /asset\.png/); assert.match(prompt, /bytes/); assert.match(prompt, /make-parent\.js/); assert.match(prompt, /export default/); assert.match(prompt, /input memory/); assert.doesNotMatch(prompt, /read and update/);
});

test("keeps generation prompt compact while retaining method inventory and AGENTS memory", () => {
  const prompt = assembledPrompt({ workdir: "/tmp/node", type: "text", method: "llm", prompt: "x", inputs: {}, context: {} });
  assert.match(prompt, /Node: \/tmp\/node/);
  assert.match(prompt, /Node\.js, Python, shell/);
  assert.doesNotMatch(prompt, /npx\/network|search for packages|generic skill files/);
});

test("always creates empty AGENTS memory when agent omits it", async () => {
  const root = mkdtempSync(join(tmpdir(), "hypermaker-agents-")), fake = join(root, "codex"), workdir = join(process.cwd(), ".hypermaker", "nodes", `agents-${Date.now()}`);
  writeFileSync(fake, `#!/bin/sh\nnode ${JSON.stringify(join(process.cwd(), "test/fake-codex.mjs"))}\n`); chmodSync(fake, 0o755); mkdirSync(workdir, { recursive: true });
  const old = process.env.CODEX_BIN; process.env.CODEX_BIN = fake;
  try { await generate({ nodeId: "draft:agents", workdir, type: "text", method: "llm", prompt: "x", inputs: {} }); assert.match(readFileSync(join(workdir, "AGENTS.md"), "utf8"), /plain UTF-8/); }
  finally { if (old) process.env.CODEX_BIN = old; else delete process.env.CODEX_BIN; }
});

test("rejects unimplemented generation methods", async () => {
  await assert.rejects(() => generate({ nodeId: "draft:bad-method", workdir: join(process.cwd(), ".hypermaker", "nodes", `bad-${Date.now()}`), type: "text", method: "builtin", prompt: "x", inputs: {} }), /Unsupported output type or generation method/);
});

test("ignores empty normalized Codex events without crashing", () => {
  assert.equal(eventFromLine(JSON.stringify({ item: { type: "command_execution", output: "" } }), "n"), null);
});
test("Codex stdin closes so exec cannot hang waiting for extra prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "hypermaker-stdin-")), fake = join(root, "codex"), workdir = join(process.cwd(), ".hypermaker", "nodes", `stdin-${Date.now()}`); mkdirSync(workdir, { recursive: true });
  writeFileSync(fake, `#!/bin/sh\nnode ${JSON.stringify(join(process.cwd(), "test/fake-codex.mjs"))}\n`); chmodSync(fake, 0o755);
  const old = process.env.CODEX_BIN; process.env.CODEX_BIN = fake;
  try { await Promise.race([generate({ nodeId: "draft:stdin", workdir, type: "text", method: "llm", prompt: "中文" }), new Promise((_, reject) => setTimeout(() => reject(new Error("Codex stdin hang")), 2000))]); } finally { if (old) process.env.CODEX_BIN = old; else delete process.env.CODEX_BIN; }
});
