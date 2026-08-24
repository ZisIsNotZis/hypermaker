import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("../types", import.meta.url).pathname);
const dirs = readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory());
export const typeRegistry = new Map();
export const methodRegistry = new Map();
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
export function methodsFor(type) {
  return [...methodRegistry].filter(([key]) => key.startsWith(`${type}/`)).map(([, method]) => method);
}
export function registryInfo() {
  return { types: [...typeRegistry.values()], methods: Object.fromEntries([...typeRegistry.keys()].map(type => [type, methodsFor(type)])), qualities };
}
