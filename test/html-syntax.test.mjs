// A broken canvas script is invisible to the user until every control stops
// working, so parse the single-file UI script here as part of `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const html = readFileSync(join(process.cwd(), "public", "index.html"), "utf8");

test("canvas script blocks parse as JavaScript", () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length >= 1, "expected at least one script block");
  const dir = mkdtempSync(join(tmpdir(), "hypermaker-syntax-"));
  scripts.forEach((source, index) => {
    const file = join(dir, `block-${index}.mjs`);
    writeFileSync(file, source);
    const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(check.status, 0, `script block ${index} failed to parse:\n${check.stderr}`);
  });
});

test("canvas keeps the promised interaction hooks", () => {
  for (const hook of ["data-delete", "data-generate", "data-download", "data-prompt", "raise(", "function draw(", "worldPoint", "add-card"]) {
    assert.ok(html.includes(hook), `missing ${hook}`);
  }
  assert.equal(html.includes("document.addEventListener('click'"), false, "duplicate capture-phase click handlers removed");
});
// Every name the canvas script calls must be declared somewhere in that script.
// Pan and zoom both called an undefined setView(), so the canvas silently never
// moved while every test that did not pan still passed. This is a lightweight
// lexical check, not a type checker: it strips comments, strings and template
// *text* so those cannot fake a declaration or a call.
//
// A template literal can hold another template literal - `${cond ? `<b>${x}</b>` : ''}` is
// ordinary canvas code - and the first version of this stripper treated the inner backtick
// as the end of the outer template. The code after it was then read as script text, so the
// check reported names like `render(` and `unknown(` as "called but never declared" on a
// canvas that parsed and ran. Interpolations are code, so they are stripped recursively and
// kept: a name used only inside `${...}` is checked like any other.
function strip(source, from = 0, inTemplate = false) {
  let out = "", i = from, braces = 0;
  while (i < source.length) {
    const c = source[i], n = source[i + 1];
    if (c === "/" && n === "/") { while (i < source.length && source[i] !== "\n") i++; continue }
    if (c === "/" && n === "*") { i += 2; while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++; i += 2; continue }
    if (c === "'" || c === '"') {
      const quote = c; i++;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue }
        if (source[i] === quote) { i++; break }
        i++;
      }
      out += '""';
      continue;
    }
    if (c === "`") {
      i++;
      out += "``";
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue }
        if (source[i] === "`") { i++; break }
        if (source[i] === "$" && source[i + 1] === "{") {
          const inner = strip(source, i + 2, true);
          out += ` ${inner.out} `;
          i = inner.i;
          continue;
        }
        i++;
      }
      continue;
    }
    // End of an interpolation: the code inside it is kept, the braces are not.
    if (inTemplate && c === "}" && braces === 0) return { out, i: i + 1 };
    if (c === "{") braces++;
    else if (c === "}") braces--;
    out += c; i++;
  }
  return { out, i };
}

// The check is a function so a deliberately broken script can be fed through it: a
// checker that stopped seeing anything would report no missing names for every input.
function undeclared(canvasScript) {
const strippedScript = strip(canvasScript).out;
// Names bound anywhere in the script, plus the globals the browser and Node provide.
const bound = new Set(["if", "for", "while", "switch", "catch", "return", "typeof", "await", "new", "delete", "void", "in", "of", "do", "else", "try", "throw", "case", "yield", "function", "async", "class", "const", "let", "var", "import", "export", "default", "extends", "super", "this", "null", "true", "false", "undefined",
  "fetch", "setTimeout", "clearTimeout", "setInterval", "confirm", "alert", "encodeURIComponent", "requestAnimationFrame", "cancelAnimationFrame", "EventSource", "URL", "JSON", "Math", "Object", "Array", "String", "Number", "Boolean", "Promise", "Map", "Set", "Date", "Error", "RegExp", "Symbol", "Intl", "console", "document", "window", "globalThis", "parseInt", "parseFloat", "isNaN", "structuredClone", "queueMicrotask"]);
for (const m of strippedScript.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) { bound.add(m[1]); for (const p of m[2].split(",")) if (/[A-Za-z_$]/.test(p)) bound.add(p.trim().replace(/^...$/, "")) }
for (const m of strippedScript.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
for (const m of strippedScript.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
for (const m of strippedScript.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:[A-Za-z_$][\w$]*|\([^)]*\))\s*=>/g)) bound.add(m[1]);
for (const m of strippedScript.matchAll(/(?:[A-Za-z_$][\w$]*|\([^)]*\))\s*=>/g)) { const head = m[0].replace(/\s*=>\s*$/, ""); for (const p of head.replace(/[()]/g, "").split(",")) if (/^[A-Za-z_$][\w$]*$/.test(p.trim())) bound.add(p.trim()) }

  const called = [...strippedScript.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
  return [...new Set(called)].filter(name => !bound.has(name));
}

const canvasScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");

test("every canvas helper that gets called is declared in the canvas script", () => {
  assert.deepEqual(undeclared(canvasScript), [], "called but never declared");
});

test("a helper used only inside a nested template interpolation is still checked", () => {
  // The control that caught the stripper: one template inside another ended the outer
  // template early, so code after it read as text. The canvas has since used exactly this
  // shape (a tooltip built as `${cond ? `${x}` : ''}`), and the check called it broken.
  const script = 'function a(n){return `${n ? `<b>${missingHelper(n)}</b>` : ""}`}\nfunction draw(){a(1)}';
  assert.deepEqual(undeclared(script), ["missingHelper"]);
});
