import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A stand-in for an agent that follows the `narration` method's guide. It is deliberately
// not a shortcut: it reads the text input out of the prompt the server assembled, writes a
// script, and runs the *real* `voice/render.mjs` from the project. So the WAV this test
// publishes is the same WAV a person would get, produced by the same code, and the server's
// check runs against real speech rather than against a fixture that was tuned to pass.
const dir = process.env.HYPERMAKER_NODE_DIR || process.cwd();
const promptPath = join(dir, "prompt.txt");
const prompt = existsSync(promptPath) ? readFileSync(promptPath, "utf8") : "";

// The text card's content arrives fenced inside INPUTS; fall back to the user prompt when
// there is no text input, which is exactly what the guide tells a real agent to do.
const fenced = /artifact content:\n```\n([\s\S]*?)\n```/.exec(prompt);
const userPrompt = /# USER PROMPT\n([\s\S]*)$/.exec(prompt);
const text = (fenced ? fenced[1] : userPrompt ? userPrompt[1] : "").trim();

const scriptText = join(dir, "script.txt");
writeFileSync(scriptText, text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join("\n"), "utf8");

const root = process.env.HYPERMAKER_PROJECT || process.cwd();
const wav = join(dir, "narration.wav"), timeline = join(dir, "timeline.json");
execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--file", scriptText, "--out", wav, "--timeline", timeline], { stdio: "inherit" });

// The guide's own verification step, run for real. If the audio is not speech this throws
// and the run fails, which is what would happen to a real agent that did not check.
const words = text.replace(/\s+/g, " ").trim();
const report = JSON.parse(execFileSync(process.execPath, [join(root, "voice/render.mjs"), "--check", wav, "--words", words], { encoding: "utf8" }));
if (report.verdict !== "speech") throw new Error(`the rendered narration did not measure as speech: ${report.problems.join("; ")}`);

// What a person would read afterwards, written where the canvas shows it.
writeFileSync(join(dir, "AGENTS.md"), `Narrated ${report.words} words in ${report.seconds.toFixed(2)}s: ${report.onsets} syllable onsets, ${report.vowelKinds} vowel regions, verdict ${report.verdict}.\n`, "utf8");

const artifact = wav;
const result = { prompt: "a narration", script: scriptText, artifact, type: "audio", method: "narration", error: null };
const output = process.argv[process.argv.indexOf("--output-last-message") + 1];
if (output) writeFileSync(output, JSON.stringify(result));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
