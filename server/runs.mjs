// Where a run works, and what is done if it damages the card anyway.
//
// A card's directory holds things a person put there and the bytes they kept. A run
// used to work in `<card>/attempts/<start>`, which is inside that directory, and the
// agent was handed the card's own path (HYPERMAKER_CARD_DIR) and runs with
// `--sandbox danger-full-access`. An earlier probe stood in for an agent that tidied
// one file next to the card: the file answered 200 before the run and 404 after it,
// and the run still ended idle. A path in a prompt is a request, not a boundary, so
// neither the directory layout nor the instruction not to touch it can be the whole
// answer.
// Three things changed here, and they are layers rather than alternatives:
//
//   1. A run works in `<workdir>/.runs/<card>/<start>` - outside the card's own
//      directory, so nothing it writes or deletes is next to what a person keeps.
//      The card directory is not named to the agent at all.
//   2. Every file under the card is copied into `<run>/.guard` before the agent
//      starts - a real copy, not a hardlink. The first version hardlinked, and that
//      was wrong in a way a supervisor named before it shipped: the commonest way a
//      tool saves is to open the existing file and write into it, and a hardlink and
//      the original are one piece of content, so such a save changes the "saved"
//      copy too and the after-run comparison would find the two identical and call
//      the file untouched. A copy shares nothing, so an in-place write leaves the
//      guard holding the older bytes and the difference is visible.
//   3. After the run - success, failure, Stop, or the next startup when the process
//      died - every guarded file is compared with the card by content and put back if
//      it is gone or different, and the result says so. A run that damaged the card
//      is not presented as a clean success, because the person's file was what it
//      was given to use.
//
// The guard holds the card's *own* files. A take is published into `versions/` only
// after the run has ended, so nothing there is the run's to damage; the card's own
// take is protected by publishing rather than by this.
//
// The cost is a copy of the card's contents per run, which is why `pruneRuns`
// bounds how many runs are kept and why a successful run drops its directory as soon
// as the report has been made. A 65 MiB video clip is ordinary material here, and the
// first version treated files over 64 MiB as outside the promise and said so only
// after the run - a supervisor put a clip of that size next to a card, watched the run
// end normally, and found no warning anywhere. So the boundary now has two levels
// instead of one, and both are stated *before* the agent starts:
//
//   * a small file (up to `copyLimit`) is copied, so it survives a deletion *and* an
//     in-place rewrite, which is what the guard's content check needs;
//   * a large file is hardlinked instead. That costs no disk and no time, and it still
//     keeps the bytes of a deleted file reachable through the link, so "the run removed
//     my clip" is still repaired. What a hardlink cannot see is a rewrite of that file's
//     contents in place, and that is the one sentence the person is told in advance.
//
// Nothing is silent: `guardCard` returns which files got which, the press that starts
// the run reports them, and the card keeps that sentence.
import { copyFileSync, createReadStream, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

export const runsRoot = ".runs";
export const guardName = ".guard";
export const runMarker = "run.json";
// A crash note is written once and is not material a person put there, so it is not
// guarded (a second crash would otherwise protect the first note from being updated).
const crashNote = "KEPT-AFTER-CRASH.txt";
// The harness's own files in the card, by name: each is written or removed around the
// run rather than being something the person had. Guarding them would report the
// harness's own bookkeeping as damage and, worse, put a stale prompt back after a
// newer one was saved.
const ownFiles = new Set([runMarker, crashNote, "prompt.txt", "codex.jsonl", "codex-final.json", "codex-command.json"]);
// Files that belong to the card and are still not the agent's leftovers: `AGENTS.md` is
// the card's own memory, written empty for a card that has none, so it is guarded (an
// agent that deletes it gets it back) but never reported as an addition.
const harnessMade = new Set(["AGENTS.md"]);
// Up to this size a file is copied, so an in-place rewrite is caught as well as a
// deletion. Above it the file is hardlinked: still protected against deletion, but a
// rewrite of its contents in place is not visible, and the person is told that before
// the run starts. The limit is about the cost of a second copy per run, not about
// whether the file matters - 64 MiB clips are ordinary material, which is why being
// outside the *copy* tier is announced rather than used to write the file off.
const copyLimit = 64 * 1024 * 1024;
export const copyLimitBytes = copyLimit;

const inside = (file, dir) => { const r = relative(resolve(dir), resolve(file)); return r === "" || (!r.startsWith("..") && !r.startsWith("/")); };

// Every file under the card, whatever its subdirectory - except the guard itself,
// which belongs to the run and is about to be written into. Directories are made as
// they are met, so a file the person put three levels down can be put back where it
// was and not at the top.
function cardFiles(cardDir) {
  const files = [];
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== guardName) walk(path); continue; }
      if (ownFiles.has(entry.name)) continue;
      if (entry.isFile()) files.push(path);
    }
  };
  walk(cardDir);
  return files;
}

// A digest of the bytes the guard holds for each file, so the after-run check is about
// content and never about a name or an inode. That distinction is the whole point:
// an in-place save keeps the name and changes the bytes, and a same-size rewrite keeps
// the size. Hashing is what tells them apart without carrying a second reading of every
// file around.
const digest = file => new Promise((ok, no) => {
  const hash = createHash("sha256"), stream = createReadStream(file);
  stream.on("data", chunk => hash.update(chunk));
  stream.on("error", no);
  stream.on("end", () => ok(hash.digest("hex")));
});

// Two levels, and the reason for each. A small file is copied, so the guard holds the
// older bytes and an in-place rewrite is visible. A large file is hardlinked: the cost
// of copying a hundred-megabyte render on every press is real, while deletion is the
// failure that actually happened, and a link keeps the bytes reachable through it. The
// sentence a person gets before the run names the large files and says what is not
// covered for them, rather than leaving them to assume full protection.
//
// Nothing is silently omitted: a file the filesystem refused outright is reported as
// `unprotected` with the reason, never as a quiet success.
export async function guardCard(cardDir, guardDir) {
  const held = { files: [], linked: [], skipped: [], unprotected: [] };
  if (!existsSync(cardDir)) return held;
  rmSync(guardDir, { recursive: true, force: true });
  mkdirSync(guardDir, { recursive: true });
  for (const file of cardFiles(cardDir)) {
    const rel = relative(cardDir, file), heldAt = join(guardDir, rel);
    let size = 0;
    try { size = statSync(file).size; } catch { continue; }
    mkdirSync(dirname(heldAt), { recursive: true });
    if (size > copyLimit) {
      // The link keeps the same bytes; nothing is read or written. If the filesystem
      // refuses a link (another volume, a mount without hardlinks) the file is named as
      // unprotected instead of being treated as safe.
      try { linkSync(file, heldAt); held.linked.push(rel); }
      catch (error) { held.unprotected.push({ rel, why: `could not be linked for this run (${error.code || error.message})` }); }
      continue;
    }
    try {
      // Copy to a temporary name and rename, so a guard that is interrupted cannot hold
      // a half-copied file that would later be put back over a whole one.
      const part = `${heldAt}.part`;
      copyFileSync(file, part);
      renameSync(part, heldAt);
      held.files.push({ rel, size, digest: await digest(heldAt) });
    } catch (error) { held.unprotected.push({ rel, why: `could not be copied for this run (${error.code || error.message})` }); }
  }
  writeFileSync(join(guardDir, "manifest.json"), JSON.stringify(held, null, 1), "utf8");
  return held;
}

// What the person is told *before* the run starts: which of their files are covered for
// deletion only, because they were too large to copy. It is a warning, not a refusal -
// a clip of any size is legitimate material - and it names the sizes, because "too big"
// without a number is not something a person can act on.
export function guardNotice(held) {
  const lines = [];
  if (held.linked?.length) lines.push(`${held.linked.join(", ")}: ${held.linked.length === 1 ? "this file is" : "these files are"} larger than ${Math.round(copyLimit / (1024 * 1024))} MiB, so ${held.linked.length === 1 ? "it is" : "they are"} kept by a link rather than a copy. If this run deletes ${held.linked.length === 1 ? "it" : "them"}, ${held.linked.length === 1 ? "it" : "they"} will be put back; if it writes over ${held.linked.length === 1 ? "its contents in place" : "their contents in place"}, that change cannot be undone.`);
  if (held.unprotected?.length) lines.push(`${held.unprotected.map(u => `${u.rel} (${u.why})`).join(", ")}: not protected this run at all.`);
  return lines.join(" ") || null;
}

// Putting one file back where it was. A copy that cannot be written is reported rather
// than swallowed: a person must not be told their file is back when it is not.
function putBack(held, target) {
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { force: true, recursive: true });
  try { copyFileSync(held, target); return true; } catch { return false; }
}

// The card as the run left it, compared with the guard *by content*. Every file the
// guard holds is hashed again and compared with what it held; a file whose bytes differ
// - including a same-size rewrite in place, which keeps the name and the size and only
// changes what is inside - is put back, and named in the report. A file that is gone is
// put back too. Nothing is decided from a timestamp or an inode.
//
// Run once per guard. A second pass would compare the card against copies that already
// have their bytes, so it would find nothing to restore - and it would report every file
// the agent added twice. The `spent` marker records that this pass happened, and a run
// that dies between this check and its end therefore reports what it found rather than
// repeating it.
export async function keepCard(cardDir, guardDir) {
  const report = { restored: [], damaged: [], added: [], failed: [], unprotected: [], linkedGone: [] };
  if (!existsSync(guardDir)) return report;
  if (existsSync(join(guardDir, "spent"))) return report;
  let manifest = null;
  // A guard without a manifest is a guard that never finished being written, so there is
  // nothing it promised and nothing to check. That is stated, not assumed: the run is
  // told the snapshot is missing rather than silently reported clean.
  try { manifest = JSON.parse(readFileSync(join(guardDir, "manifest.json"), "utf8")); }
  catch { report.unprotected.push("the record of what this card held could not be read, so nothing about it could be checked"); return report; }
  const manifestFiles = manifest.files || [], manifestLinked = manifest.linked || [];
  for (const [rel, why] of (manifest.unprotected || []).map(u => [u.rel, u.why])) report.unprotected.push(`${rel} (${why})`);
  const known = new Set([...manifestFiles.map(f => f.rel), ...manifestLinked]);
  for (const entry of manifestFiles) {
    const rel = entry.rel, copy = join(guardDir, rel), target = join(cardDir, rel);
    const there = existsSync(target) && !lstatSync(target).isDirectory();
    // Hashing the card's file and the guard's copy is the only comparison that can see an
    // in-place save. It is also why the guard holds copies rather than hardlinks.
    if (there && await digest(target) === entry.digest) continue;
    const changed = there;
    if (!putBack(copy, target)) { report.failed.push(rel); continue; }
    (changed ? report.damaged : report.restored).push(rel);
  }
  // A hardlinked file cannot be compared - the link *is* the file - so the only question
  // it can answer is whether the card still has it. "Gone" is put back from the link; a
  // rewrite in place is what the notice warned about before the run started.
  for (const rel of manifestLinked) {
    const target = join(cardDir, rel);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    try { linkSync(join(guardDir, rel), target); report.restored.push(rel); }
    catch { report.linkedGone.push(rel); }
  }
  // A name the agent added next to the card is reported, not removed. Moving it out would
  // be the harness deleting from the card's directory on a guess, which is the class of
  // mistake this module exists to stop - and a run writes bookkeeping of its own there
  // too, so a name-based rule cannot always tell the two apart. A person can see the list
  // and decide.
  for (const file of cardFiles(cardDir)) {
    const rel = relative(cardDir, file);
    if (!known.has(rel) && !harnessMade.has(rel) && !ownFiles.has(rel)) report.added.push(rel);
  }
  writeFileSync(join(guardDir, "spent"), new Date().toISOString(), "utf8");
  return report;
}
export function damageReason(report) {
  const names = [...report.damaged, ...report.restored];
  if (!names.length && !report.failed.length && report.unprotected?.length) return `The card's files could not all be protected this run: ${report.unprotected.join("; ")}. The result was published; check those files before relying on them.`;
  if (report.linkedGone?.length) return `The run deleted ${report.linkedGone.join(", ")}, which was kept by a link rather than a copy and could not be put back. It is the only kind of file this guard cannot restore, and it is named here rather than reported as a clean run.`;
  if (!names.length) return report.failed.length
    ? `The run deleted or changed files in the card's directory (${report.failed.join(", ")}) and they could not be put back. The run was given this directory only to read; check that it still holds what you put there.`
    : null;
  const list = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
  // Neutral about the outcome on purpose: this sentence is attached to a success and to
  // a Stop, and saying "the result was published" on a stopped run would be false.
  return `The run ${report.damaged.length ? "changed" : "deleted"} files in the card's directory (${list}); ${report.damaged.length ? "their original bytes were" : "they were"} put back from the snapshot taken when it started, so nothing you put there is lost.`;
}

// A run's directory is named by a marker in the card, written *before* the directory
// exists. That order is what makes a crash safe: if the process dies between the two
// steps, the next startup finds a marker whose directory is absent and has nothing to
// put back - which is true, because nothing had been touched yet. The other order
// (`mkdir` then marker) leaves, for a moment, a directory that could hold the only
// record of what the card held, with nothing pointing at it.
export function beginRun(workdir, id, startedAt = Date.now()) {
  const cardDir = join(workdir, String(id)), dir = join(workdir, runsRoot, String(id), String(startedAt));
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(join(cardDir, runMarker), JSON.stringify({ startedAt, dir: relative(cardDir, dir), pid: process.pid }), "utf8");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function endRun(workdir, id) { rmSync(join(workdir, String(id), runMarker), { force: true }); }

// Where a frozen input copy for a run is written, and the copy it is: the card only
// records the published version it came from, and the name keeps the material's own
// filename in it so an agent (and a person reading the prompt) can tell which card's
// words or picture it is holding.
export function freezeSource(workdir, source, runDir) {
  const from = join(workdir, String(source.id), source.artifact || "");
  if (!source.artifact || !existsSync(from)) return { ...source, file: null };
  const dir = materialDir(runDir);
  mkdirSync(dir, { recursive: true });
  const name = `s-${source.id}-${basename(source.artifact).replace(/^v\d+-/, "")}`;
  copyFileSync(from, join(dir, name));
  return { ...source, frozen: join(dir, name) };
}

export const materialDir = runDir => join(runDir, "inputs");

// What keeps a workspace from growing without bound: run directories beyond the five
// most recent for a card are dropped. The guard is gone by then, so this cannot undo a
// recovery - it only removes scratch after the outcome has been recorded.
export const keepRuns = 5;
export function pruneRuns(workdir, id) {
  const root = join(workdir, runsRoot, String(id));
  if (!existsSync(root)) return;
  const dirs = readdirSync(root).map(Number).filter(n => !Number.isNaN(n)).sort((a, b) => b - a);
  for (const stale of dirs.slice(keepRuns)) rmSync(join(root, String(stale)), { recursive: true, force: true });
}

// A crash leaves the card marked running and its run directory behind, and - the part
// that matters to a person - the agent may have died halfway through deleting
// something. The marker names the run directory, so the guard is found without
// guessing and the card is put back before anything else looks at it. What was put
// back is written next to the card in plain words: the person was not watching, so
// this is the only place the recovery can be noticed.
//
// What to do about a take that a dead run published without saving it needs the
// card's records, so that decision stays in the server; this function hands back the
// run directory it recovered from and leaves versions/ alone.
export async function recoverRun(workdir, id) {
  const cardDir = join(workdir, String(id)), marker = join(cardDir, runMarker);
  if (!existsSync(marker)) return { ran: false, report: null };
  let runDir = null;
  try { const record = JSON.parse(readFileSync(marker, "utf8")); if (record.dir) runDir = resolve(cardDir, record.dir); } catch {}
  rmSync(marker, { force: true });
  if (!runDir || !inside(runDir, join(workdir, runsRoot))) return { ran: false, report: null };
  const report = await keepCard(cardDir, join(runDir, guardName));
  const names = [...report.damaged, ...report.restored, ...report.failed];
  if (names.length) {
    writeFileSync(join(cardDir, "KEPT-AFTER-CRASH.txt"), [
      "A run was cut off because the server stopped while it was working. This was",
      "written down when the run started - what the card's directory held - and read back",
      "afterwards. These names were missing or changed while it ran, and were put back",
      "with the bytes they held before it started:",
      "",
      ...names.map(f => `  ${f}`),
      "",
      "The interrupted run's own files are under .runs/ in the workspace, outside this",
      "card. Nothing else in this directory was touched.",
      ""
    ].join("\n"), "utf8");
  }
  return { ran: true, report, runDir };
}
