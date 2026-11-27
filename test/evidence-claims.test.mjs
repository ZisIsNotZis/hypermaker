import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// What the documents may say about the one real-model run that was attempted.
//
// The first version of that claim said "the model backend is unreachable from this host",
// because a plain curl from the agent's sandbox got no response from chatgpt.com. A supervisor
// measuring from the host got the opposite kind of answer - the site loads, workspace discovery
// returns 451, the model entry returns 405 to an unauthenticated GET - so the zeros were the
// sandbox's egress, not the service. The difference matters: "the backend is down" tells the
// next person to wait, while "discovery answered 451 from there, and nothing answers from here"
// tells them what to try next.
//
// The lesson generalises, which is why it is a test rather than a note: a measurement describes
// the vantage point it was taken from, and a claim that drops the vantage point is a different,
// stronger claim than the one the evidence supports. The failure is silent - both sentences
// point at the same file - so it needs a check.
const root = process.cwd();
const read = name => readFileSync(join(root, name), "utf8");
const files = {
  "docs/impl.md": read("docs/impl.md"),
  "CHANGELOG.md": read("CHANGELOG.md").split(/^## /m).slice(0, 3).join("## "),
  "docs/evidence/README.md": read("docs/evidence/README.md"),
  "test/film-story.mjs": read("test/film-story.mjs"),
};

test("no document claims the model backend is unreachable, because that is not what was measured", () => {
  for (const [name, text] of Object.entries(files)) {
    assert.doesNotMatch(text, /backend is unreachable|backend is not reachable|cannot reach chatgpt\.com/i,
      `${name} states the backend is unreachable; the measurements show specific routes answering 451 and 405 from the host, and silence from the agent's sandbox`);
    assert.doesNotMatch(text, /no Codex CLI/i,
      `${name} says there is no Codex CLI; codex-cli 0.172.0 is installed locally`);
  }
});

test("the documents that describe the attempt name the route and its status", () => {
  // The three facts a reader needs to judge the claim, in the places a reader looks.
  for (const name of ["docs/impl.md", "docs/evidence/README.md"]) {
    const text = files[name];
    assert.match(text, /workspace discovery|routing discovery/i, `${name} does not say where the run stopped`);
    assert.match(text, /451/, `${name} does not report the status workspace discovery returned`);
  }
  // And the statuses must be attributed to the vantage point, not stated bare.
  // Attributed by naming the vantage point beside the status, not by one phrasing of a
  // preposition: the table has a column for it and the prose names both sides.
  assert.match(files["docs/evidence/README.md"], /the host/i, "the evidence does not name the host as a vantage point");
  assert.match(files["docs/evidence/README.md"], /\*\*451\*\*[^\n]*\n?/, "the evidence does not record the 451 status");
  assert.match(files["docs/evidence/README.md"], /sandbox/i, "the evidence does not distinguish the sandbox's measurements");
});

test("the evidence file exists under a name that says where the run stopped", () => {
  // A filename is a claim too: `real-run-backend-unreachable.jsonl` asserted the conclusion in
  // the one place a person sees before opening anything.
  const name = "docs/evidence/real-run-stopped-at-workspace-discovery.jsonl";
  assert.ok(existsSync(join(root, name)), `the evidence file is missing: ${name}`);
  assert.equal(existsSync(join(root, "docs/evidence/real-run-backend-unreachable.jsonl")), false,
    "the old file name still exists, and it asserts a cause the evidence does not support");
  const transcript = read(name);
  assert.match(transcript, /workspace routing discovery timed out/, "the transcript does not contain the failure it is kept for");
  assert.match(transcript, /chatgpt\.com\/backend-api/, "the transcript does not name the route that timed out");
  // A session identifier is not evidence and does not belong in a public tree.
  assert.doesNotMatch(transcript, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    "the transcript still carries a session id");
});

test("the evidence says what it does not prove, so it cannot be read as a pace result", () => {
  const text = files["docs/evidence/README.md"];
  assert.match(text, /does not prove|unproven|remains unproven/i, "the evidence does not state its limit");
  assert.match(text, /pace/i, "the evidence does not say the pace question is separate and open");
  assert.match(text, /not repeated|no further/i, "the evidence does not say the failure was not re-run to confirm it");
});
