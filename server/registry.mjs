import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("../types", import.meta.url).pathname);
const dirs = readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory());
export const typeRegistry = new Map();
export const methodRegistry = new Map();
// A method that names a tool nobody installed is not a method a person can use. Two of
// them (`tts.cpp`, `bark.cpp`) point at binaries under `~/`, and on a machine without
// them the audio card still offered them - and, because the list was sorted by name,
// chose `bark.cpp` as the default for a brand-new audio card. Pressing Generate then
// failed with the agent's own message about a missing file. A method now says what it
// needs, and the registry answers whether that is there, so the canvas offers what works
// first and can say why the rest do not.
const expand = path => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
const installed = method => (method.requires || []).every(path => { try { return statSync(expand(path)).isFile(); } catch { return false; } });
for (const dir of dirs) {
  const type = (await import(pathToFileURL(join(root, dir.name, "index.mjs")))).type;
  typeRegistry.set(type.id, type);
  const methods = join(root, dir.name, "methods");
  for (const file of readdirSync(methods).filter(x => x.endsWith(".mjs"))) {
    const method = (await import(pathToFileURL(join(methods, file)))).method;
    if (method) methodRegistry.set(`${type.id}/${method.id}`, method);
  }
}
export const qualities = ["sketch", "demo", "standard", "artistic", "realistic"];
export function typeForFile(file) {
  const lower = String(file).toLowerCase();
  return [...typeRegistry.values()].find(type => type.extensions.some(ext => lower.endsWith(ext)))?.id;
}
// Methods a person can actually run come first, so the default for a fresh card is one
// that works with nothing installed. The others stay in the list rather than being
// hidden: a person who does have the binary must still be able to reach the method, and
// a canvas that silently dropped registry entries would be lying about what exists.
export function methodsFor(type) {
  const methods = [...methodRegistry].filter(([key]) => key.startsWith(`${type}/`)).map(([, method]) => ({ ...method, available: installed(method) }));
  return methods.sort((a, b) => (b.available - a.available) || a.id.localeCompare(b.id));
}
// What the server will actually run. Used before a run starts, so a card whose method
// needs a missing binary says so itself instead of failing later with an agent error.
export function methodFor(type, id) {
  return methodsFor(type).find(method => method.id === id) || null;
}
// The method a brand-new card of this type starts on.
//
// "First that works" was `available` order alone, and that was right while every method was an
// agent: the only thing that could be missing was a binary. It is no longer the whole question.
// A method that the server runs itself (`builtin`) needs no account, no route and no binary, so a
// card a person adds should start on one of those when the type has one - the first film should
// not depend on a model being reachable. The agent methods stay in the list, and a card switched
// to them still runs them; this only decides which one a new card is pointed at.
export function defaultMethodFor(type) {
  const usable = methodsFor(type).filter(method => method.available !== false);
  return usable.find(method => method.builtin)?.id ?? usable[0]?.id ?? null;
}
export function registryInfo() {
  const defaults = Object.fromEntries([...typeRegistry.keys()].map(type => [type, defaultMethodFor(type)]));
  return { types: [...typeRegistry.values()], methods: Object.fromEntries([...typeRegistry.keys()].map(type => [type, methodsFor(type)])), defaults, qualities };
}
