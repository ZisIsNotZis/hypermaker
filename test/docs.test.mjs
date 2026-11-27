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

test("speech is claimed only as far as it was measured", () => {
  // This test used to say "speech synthesis is never presented as something that works",
  // because `tts.cpp` and `bark.cpp` name binaries that are not on this machine and no
  // speech run had ever been taken. That fact changed: the `narration` method speaks with a
  // formant synthesizer in this repository (`voice/`), and both a real WAV and a film
  // carrying its audio have been measured. The claim is rewritten rather than deleted, and
  // it is not weakened - it now pins *both* halves, because each can rot on its own:
  //   * the working part must stay described as working, and attached to the audio
  //     capability bullet a reader uses to decide whether an audio card is usable;
  //   * the unproven part must stay unproven: `tts.cpp`/`bark.cpp` are still documented
  //     methods whose binaries are absent, and no natural-voice run exists.
  // A control that wrote "natural speech works out of the box" in the same breath would
  // still be caught by the negatives below.
  const en = doc("README.md"), zh = doc("README.zh-CN.md");
  // The exact sentences that were true before and are not true now. `tts.cpp`/`bark.cpp`
  // cover *a natural voice*, not speech as such, and the offline voice is not unavailable.
  assert.doesNotMatch(en, /`tts\.cpp`\/`bark\.cpp` cover speech/, "README.md presents speech as working");
  assert.doesNotMatch(zh, /`tts\.cpp` 或 `bark\.cpp` 方法生成/, "README.zh-CN.md presents speech as working");
  // Found by a negative control that left the word "robotic" in place while adding "speech
  // is unavailable out of the box" to the same bullet: every earlier assertion stayed green
  // on a document that contradicted itself in one sentence. A claim and its negation in the
  // same bullet is exactly the rot this file exists for.
  for (const [name, text] of [["README.md", en], ["README.zh-CN.md", zh]]) {
    assert.doesNotMatch(text, /speech is (?:not available|unavailable) out of the box/i, `${name} says speech is unavailable while shipping a voice`);
    assert.doesNotMatch(text, /Speech synthesis is (?:not proven|unproven)/i, `${name} says speech synthesis is unproven, though the offline voice is measured`);
    assert.doesNotMatch(text, /语音开箱不可用/, `${name} says speech is unavailable while shipping a voice`);
    assert.doesNotMatch(text, /语音合成没有证据/, `${name} says speech synthesis has no evidence`);
    assert.doesNotMatch(text, /speech synthesis has never run/i, `${name} says speech has never run`);
    assert.doesNotMatch(text, /语音从没真正跑过/, `${name} says speech has never run`);
  }
  // The honest statement has to be present, not merely the wrong one absent - and it has to
  // be attached to the capability bullet a reader uses to decide whether an audio card is
  // usable. Forbidding one exact old sentence was not enough: a negative control that wrote
  // "Speech works" in its place left an earlier version of this test (and the claim) green.
  const audioBullet = (text, marker) => text.split("\n").find(l => l.startsWith(marker)) || "";
  const bullet = audioBullet(en, "- Generate audio");
  // Both methods are named in that one bullet, so a reader learns the offline voice exists
  // and that it is robotic, before pressing Generate.
  assert.match(bullet, /`narration`/, "README.md's audio capability names the offline voice");
  assert.match(bullet, /robotic/i, "README.md's audio capability says the voice is robotic rather than natural");
  assert.match(bullet, /`tts\.cpp` and `bark\.cpp`/, "README.md still says the natural-voice methods need binaries");
  const zhBullet = audioBullet(zh, "- 音频有两条");
  assert.match(zhBullet, /`narration`/, "README.zh-CN.md's audio capability names the offline voice");
  assert.match(zhBullet, /机械/, "README.zh-CN.md says the voice is robotic rather than natural");
  assert.match(zhBullet, /`tts\.cpp`\/`bark\.cpp`/, "README.zh-CN.md still says the natural-voice methods need binaries");
  // Verification limits must keep the distinction: the offline voice is measured (with the
  // numbers a person can reproduce), and a *natural* voice is still unproven.
  assert.match(en, /\*\*Narration is measured, not asserted\.\*\*/, "README.md's Verification limits says what the voice check measures");
  assert.match(en, /no natural-voice run has been taken/, "README.md still says a natural voice has no evidence");
  assert.match(zh, /\*\*离线语音已经测过\*\*/, "README.zh-CN.md says in Verification limits that the offline voice was measured");
  assert.match(zh, /从未跑过一次自然嗓音/, "README.zh-CN.md still says a natural voice has never run");
  // The open-work list is where a reader checks what is *left* to do, and a second negative
  // control walked straight past it: replacing that item with "**Speech works.**" left every
  // assertion above green, because they all live in the capability bullet and in Verification
  // limits. The item is now pinned by name, so removing it fails rather than quietly
  // shrinking the list of what is unproven.
  assert.match(en, /^- \*\*A natural voice\.\*\*/m, "README.md's open work still names the natural voice as the missing piece");
  assert.match(zh, /^- \*\*自然嗓音。\*\*/m, "README.zh-CN.md's open work still names the natural voice as the missing piece");
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
  // uses to decide whether an audio card is usable did not mention it. It then said six
  // when `narration` made seven, so the count follows the registry rather than a number
  // typed once: the loop below names every audio method, and the count is a multiplier.
  const { methodsFor, methodRegistry } = await import("../server/registry.mjs");
  const audio = methodsFor("audio").map(m => m.id).sort();
  // Every method in the registry, not only the audio ones, and the count stated in the
  // document is compared with what the registry actually holds. Typing "six" again was how
  // the count fell behind the first time.
  const all = [...new Set([...methodRegistry.values()].map(m => m.id))].sort();
  const words = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
  const counted = words[all.length];
  // The *registry line of the roadmap*, not the whole document: `synth` is also named in
  // prose further down, so searching the document let a control that dropped it from the
  // list stay green - the assertion and the claim had drifted apart.
  const line = doc("README.zh-CN.md").split("\n").find(l => l.includes("四种输出类型")) || "";
  assert.ok(line, "README.zh-CN.md still states the registry's size");
  for (const id of [...all, ...audio.filter(id => !all.includes(id))]) {
    assert.ok(line.includes(`\`${id}\``), `README.zh-CN.md's method list omits ${id}; it says: ${line}`);
  }
  assert.ok(new RegExp(`${counted}(?:个|种)方法`).test(line), `README.zh-CN.md's method count matches the registry (${all.length}); it says: ${line}`);
});
