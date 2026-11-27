// The public documents drifted away from the code, and nothing noticed until a reader
// did. Three separate contradictions were found by reading on 2026-11-27:
//
//   * the README's own status line said `npm test` passes 51/51 while the suite was 56;
//   * the README said audio "is wired but not yet backed by a real-generation test"
//     in one section while a later section reported a real WAV and a measured film;
//   * `docs/project-status.md` and both READMEs still said no further development was
//     planned, on a branch that was actively changing the generation path.
//
// A promise in prose cannot go stale visibly, so the numbers and the claims that have a
// checkable answer are checked here instead. This is deliberately narrow: it pins the
// facts that a reader is misled by when they rot, not the wording around them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const doc = name => readFileSync(join(root, name), "utf8");

// The number the documents are allowed to state. Counted the same way `npm test`
// discovers them: every `test(...)`/`canvasTest(...)` declaration in test/*.test.mjs.
const declared = readdirSync(join(root, "test")).filter(f => f.endsWith(".test.mjs"))
  .flatMap(f => [...readFileSync(join(root, "test", f), "utf8").matchAll(/^\s*(?:canvasTest|test)\(/gm)]);

test("every document that states a test count states the real one", () => {
  const expected = declared.length;
  const docs = ["README.md", "README.zh-CN.md", "docs/project-status.md"];
  const stated = [];
  for (const name of docs) {
    // `0:00 / 0:04` is a player timestamp, not a pass count, so the left side has to
    // be a standalone number rather than the tail of a clock reading.
    for (const m of doc(name).matchAll(/(?<![\d:])(\d+)\s*\/\s*(\d+)\b/g)) stated.push({ name, text: m[0], n: Number(m[1]) });
  }
  assert.ok(stated.length > 0, "the documents are expected to state how many tests pass");
  for (const s of stated) assert.equal(s.n, expected, `${s.name} states ${s.text} but the suite declares ${expected} tests`);
});

test("the documents do not claim audio has no real-generation evidence", () => {
  // `test/audio.test.mjs` does render a real 6-second WAV and asserts the player can
  // report its length, and one real CLI run produced a 4-second WAV. The stale sentence
  // survived both because nothing connected the claim to the test.
  for (const name of ["README.md", "README.zh-CN.md"]) {
    const text = doc(name);
    assert.doesNotMatch(text, /not yet backed by a real-generation test/, `${name} still says audio has no real-generation test`);
    assert.doesNotMatch(text, /还没有真实生成测试/, `${name} still says audio has no real-generation test`);
  }
});

test("speech synthesis is never presented as something that works", () => {
  // `tts.cpp` and `bark.cpp` name binaries that are not on this machine, so no speech
  // run has ever been taken. Both READMEs used to list speech generation as a current
  // capability; a reader would only find out otherwise several sections later.
  const en = doc("README.md"), zh = doc("README.zh-CN.md");
  assert.doesNotMatch(en, /`tts\.cpp`\/`bark\.cpp` cover speech/, "README.md presents speech as working");
  assert.doesNotMatch(zh, /`tts\.cpp` 或 `bark\.cpp` 方法生成/, "README.zh-CN.md presents speech as working");
  // The honest statement has to be present, not merely the wrong one absent - and it has
  // to be attached to the capability bullet a reader uses to decide whether an audio card
  // is usable. Forbidding one exact old sentence was not enough: a negative control that
  // wrote "Speech works" in its place left this test (and the claim) green.
  const audioBullet = (text, marker) => text.split("\n").find(l => l.startsWith(marker)) || "";
  assert.match(audioBullet(en, "- Generate audio"), /Speech is not available out of the box/, "README.md's audio capability names speech as unavailable");
  assert.match(audioBullet(zh, "- 用离线的 `synth`"), /\*\*语音开箱不可用\*\*/, "README.zh-CN.md's audio capability names speech as unavailable");
  assert.match(en, /Speech synthesis is not proven/, "README.md says plainly in Verification limits that speech is unproven");
  assert.match(zh, /\*\*语音合成没有证据\*\*/, "README.zh-CN.md says the same in its Verification limits");
});

test("the status documents agree on where the project stands", () => {
  // Two contradictory status blocks at the top of one README is what a reader met: an
  // "active, versions kept" line followed immediately by "no further development is
  // planned". Exactly one of those can be true.
  const status = doc("docs/project-status.md");
  assert.doesNotMatch(status, /No further development is planned/, "project-status.md still closes the project on a branch that is changing it");
  for (const name of ["README.md", "README.zh-CN.md"]) {
    const text = doc(name);
    assert.doesNotMatch(text, /no further development is planned/i, `${name} still says development has stopped`);
    assert.doesNotMatch(text, /不再计划开发/, `${name} still says development has stopped`);
  }
});

test("the capability list matches the registry it describes", async () => {
  // The Chinese README listed five methods while the registry had six: `synth` was
  // added exactly because the speech binaries were missing, and the list that a reader
  // uses to decide whether an audio card is usable did not mention it.
  const { methodsFor } = await import("../server/registry.mjs");
  const audio = methodsFor("audio").map(m => m.id).sort();
  // The *registry line of the roadmap*, not the whole document: `synth` is also named in
  // prose further down, so searching the document let a control that dropped it from the
  // list stay green - the assertion and the claim had drifted apart.
  const line = doc("README.zh-CN.md").split("\n").find(l => l.includes("四种输出类型")) || "";
  assert.ok(line, "README.zh-CN.md still states the registry's size");
  for (const id of audio) assert.ok(line.includes(`\`${id}\``), `README.zh-CN.md's method list omits ${id}; it says: ${line}`);
  assert.match(line, /六(?:个|种)方法/, `README.zh-CN.md's method count matches the registry; it says: ${line}`);
});
