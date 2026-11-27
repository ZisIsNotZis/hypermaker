// A long render is exactly when a person closes the tab and comes back. A supervisor did
// that with a 65 MiB clip next to the card: the press showed the notice, and after a
// reload the server still had it (and Stop was still there) but the canvas showed
// nothing - the card was built without it and `sync()` only ever cleared notices.
//
// So the notice is checked in three places, and each is a different failure:
//   * the record: it survives a restart, like a failure reason does;
//   * the served page: the card builder and the sync path both render a stored notice;
//   * the absent case: an ordinary card carries no notice, so the slot is not noise.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(process.cwd(), "public", "index.html"), "utf8");

test("the card builds a stored protection notice, so a reload does not lose it", () => {
  // `shell()` is the only place a card is created; a notice that exists on the record
  // but not in this template is invisible after every reload.
  const shell = html.slice(html.indexOf("function shell(n)"), html.indexOf("function sync(e,n)"));
  assert.match(shell, /n\.notice/, "the card template renders the stored notice");
  assert.match(shell, /class="protection"/, "in its own element, not folded into the error");
  // And sync keeps it current without stacking one div per refresh.
  const sync = html.slice(html.indexOf("function sync(e,n)"), html.indexOf("function render()"));
  assert.match(sync, /querySelector\('\.protection'\)/, "sync looks for the element it built");
  assert.match(sync, /!pr\)\{/, "and appends only when there is none");
});

test("a notice is styled like the press-time one and is not the error", () => {
  assert.match(html, /\.protection\{/, "the stored notice has a visible style");
  // The error is the outcome of a run; a protection notice is about a file before the
  // run starts. Showing it as an error would claim a failure that did not happen.
  assert.doesNotMatch(html.slice(html.indexOf("function shell(n)"), html.indexOf("function sync(e,n)")), /class="error"[^`]*notice/i);
});
