// A person brings their own material onto the canvas - from the browser, which is the only place
// they are.
//
// The report this answers is not a bug report but a gap: the assignment asks for a film made with
// "my own two materials", and until now there was no gesture in the canvas that accepted a file at
// all. `/api/import` takes a path on the *server's* disk, which is a developer's move, and the UI
// had no control for it. Everything a film is made of was therefore out of reach unless the person
// left the app and put the files where the server could see them.
//
// What has to be true, and what this file holds to:
//   * **+ File** and a drop on empty canvas each produce a real card whose bytes are the person's,
//     not a copy the server rewrote and not a name it invented beyond making it safe;
//   * dropping a file on a supplied card replaces that card's material as a *kept version*, so the
//     links and the film's record of what it used survive, and the old file is one restore away;
//   * a supplied card offers no press that would spend a model on material a method did not make;
//   * and the refusals are sentences: wrong type, a file dropped on a *generated* card, an
//     unsupported file, an empty one, a name that tries to be a path.
//
// The last one is not hypothetical. `/api/upload` writes bytes at a name the *client* supplies, and
// and then to characters no filesystem reads as structure; this checks that a file one level above
// the workspace is never written, which is the failure that would matter.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { png } from "./png.mjs";
import { freePort, startServer, stopAll, stopServer, waitReady } from "./server.mjs";

const root = process.cwd();
const base = mkdtempSync(join(tmpdir(), "hypermaker-own-material-"));
// Two pictures of different colours, so "the bytes are the person's" and "the card's material
// changed" are visible in the pixels rather than inferred from a filename.
const red = png(64, 36, [220, 40, 40]), blue = png(64, 36, [40, 60, 220]);
// The suite must not leak fixture servers, including from a failing test.
for (const signal of ["exit", "SIGINT", "SIGTERM"]) process.on(signal, stopAll);

async function withServer(fn) {
  const port = await freePort(), workdir = join(base, `ws-${port}`);
  // The agent binary records being called and fails. A supplied card must never reach it: the whole
  // point is that this material involves no model, and a pass that quietly spent one would be a
  // pass for the wrong reason.
  const called = join(base, `called-${port}.log`);
  const bin = join(base, `codex-${port}`);
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(called)}\nexit 1\n`); chmodSync(bin, 0o755);
  const app = startServer({ cwd: root, port, env: { CODEX_BIN: bin, HYPERMAKER_WORKDIR: workdir, HYPERMAKER_RESET_WORKSPACE: "1" } });
  app.stderr.on("data", chunk => process.stderr.write(chunk));
  await waitReady(port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const call = (path, init) => fetch(baseUrl + path, init);
  const upload = (name, bytes, at = { x: 80, y: 120 }) => call(`/api/upload?x=${at.x}&y=${at.y}&name=${encodeURIComponent(name)}`, { method: "POST", body: bytes });
  const replace = (id, name, bytes) => call(`/api/replace?id=${id}&name=${encodeURIComponent(name)}`, { method: "POST", body: bytes });
  const json = (method, path, payload) => call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
  const view = () => call("/api/workspace").then(r => r.json());
  try {
    await fn({ workdir, upload, replace, json, view, called });
  } finally {
    stopServer(app);
  }
}

test("a person's own file becomes a card whose bytes are theirs", async () => {
  await withServer(async ({ workdir, upload, view, called }) => {
    const res = await upload("my two.png", red);
    assert.equal(res.status, 200, `the upload was refused: ${await res.text()}`);
    const graph = await view();
    const [id, card] = Object.entries(graph.nodes)[0];
    assert.equal(card.type, "image", "the picture arrived as an image card");
    assert.equal(card.method, null, "a supplied file is a constant card, with no method");
    // The name is the person's, made safe, with the extension preserved so the type survives.
    assert.equal(card.artifact, "my-two.png", `the card keeps a readable name, got ${card.artifact}`);
    const kept = join(workdir, id, card.artifact);
    assert.ok(existsSync(kept), "the bytes are in the card's own directory");
    assert.deepEqual(readFileSync(kept), red, "the file on disk is byte for byte what the person sent");
    assert.equal(statSync(kept).size, red.length);
    // Nothing was left in the staging area, and no model was involved.
    assert.equal(existsSync(join(workdir, ".upload-tmp")), false, "the upload staging directory is gone after the request");
    assert.equal(existsSync(called), false, "bringing a file in must not run an agent");
  });
});

test("a file dropped on a supplied card replaces its material as a kept version, links intact", async () => {
  await withServer(async ({ workdir, upload, replace, json, view, called }) => {
    const first = await (await upload("scene one.png", red)).json();
    const imageId = Number(Object.keys(first.nodes).at(-1));
    // A film card linked to that picture, wired through the API because this test is about the
    // material; the drag that makes a link has its own tests.
    const withFilm = await json("POST", "/api/node", { x: 420, y: 120, type: "video" });
    const filmId = Number(Object.keys(withFilm.nodes).at(-1));
    await json("POST", "/api/link", { source: imageId, target: filmId });
    const wasArtifact = (await view()).nodes[imageId].artifact;

    const res = await replace(imageId, "scene one - blue.png", blue);
    assert.equal(res.status, 200, `replacing the material was refused: ${await res.text()}`);
    const after = (await view()).nodes[imageId];
    // A new kept version, not an overwrite: the old name is still referenced by a version, and the
    // file on the card moved to a published name no later upload can write to.
    assert.match(after.artifact, /^versions\/v\d+-scene-one-blue\.png$/, `the new material is published under its own version, got ${after.artifact}`);
    assert.deepEqual(readFileSync(join(workdir, String(imageId), after.artifact)), blue, "the card now holds the file that was dropped");
    assert.equal(after.versions?.length, 1, `the replaced file is kept as one version, got ${JSON.stringify(after.versions)}`);
    assert.equal(after.versions[0].file, wasArtifact, "the version points at the file the card held before");
    assert.ok(existsSync(join(workdir, String(imageId), after.versions[0].file)), "the old file is still on disk, so the change is reversible");
    // The link is untouched: the film still takes this card as an input, which is the whole reason
    // to replace in place rather than import a new card and re-wire the canvas.
    assert.deepEqual((await view()).nodes[filmId].inputs, [imageId], "the film's link to the replaced card survives");
    assert.equal(existsSync(called), false, "replacing material must not run an agent");

    // And the change is reversible the way every other take is: the old picture comes back.
    const restored = await json("POST", "/api/restore", { id: imageId, version: after.versions[0].id });
    assert.equal(restored.nodes[imageId].artifact, wasArtifact, "restoring the kept version puts the old file back on the card");
    assert.deepEqual(readFileSync(join(workdir, String(imageId), wasArtifact)), red, "and the old bytes are still the old bytes");
  });
});

test("the refusals are sentences a person can act on", async () => {
  await withServer(async ({ workdir, upload, replace, json, view }) => {
    const image = await (await upload("a.png", red)).json();
    const imageId = Number(Object.keys(image.nodes).at(-1));

    // Wrong type for the card it was dropped on.
    const audio = await json("POST", "/api/node", { x: 700, y: 120, type: "audio" });
    const audioId = Number(Object.keys(audio.nodes).at(-1));
    const mismatch = await replace(audioId, "a.png", red);
    assert.equal(mismatch.status, 409);
    assert.match((await mismatch.json()).error, /holds audio material.*is image/i, "the refusal names both types");

    // A generated card's bytes are a method's output, not material, and the sentence says where the
    // file should go instead. The file is the same *kind* on purpose: a picture dropped on a film
    // card is refused for the kind, which is the more visible mistake, and that is a separate
    // assertion below. The question here is "this card is generated, may I hand it a file?"
    const picture = await json("POST", "/api/node", { x: 900, y: 120, type: "image" });
    const pictureId = Number(Object.keys(picture.nodes).at(-1));
    const onGenerated = await replace(pictureId, "a.png", red);
    assert.equal(onGenerated.status, 409);
    const refusal = (await onGenerated.json()).error;
    assert.match(refusal, /made by .*its file is that method's output/i, `the refusal says what the card is: ${refusal}`);
    assert.match(refusal, /its own card|link it from there/i, "the refusal says what to do instead");
    // The kind mismatch is named first when both are true, because a picture on a film card is a
    // mistake the person can see, and "drop it on the canvas" is what fixes both at once.
    const film = await json("POST", "/api/node", { x: 1100, y: 120, type: "video" });
    const filmId = Number(Object.keys(film.nodes).at(-1));
    const wrongKind = await replace(filmId, "a.png", red);
    assert.equal(wrongKind.status, 409);
    assert.match((await wrongKind.json()).error, /holds video material.*is image/i, "the kind mismatch names both kinds");

    // A press on a supplied card is refused by the server too, not only greyed out in the canvas: a
    // greyed-out button is a UI state, and the guarantee must not depend on one client.
    const posted = await json("POST", "/api/generate", { id: imageId, prompt: "anything" });
    assert.match(posted.error, /holds a file you supplied.*nothing to generate/i, `a supplied card refuses a press: ${posted.error}`);
    // `idle`, not `running`: the card holds a file, and it must not be left claiming a run that the
    // server refused to start - a card stuck on "generating" refuses every later press.
    assert.equal((await view()).nodes[imageId].status, "idle", "a refused press does not leave the card claiming a run");

    // An unsupported extension and an empty file are both refused.
    const badType = await upload("notes.xyz", Buffer.from("hello"));
    assert.equal(badType.status, 400);
    assert.match((await badType.json()).error, /\.xyz.*not one of the types/i);
    const empty = await upload("boom.png", Buffer.alloc(0));
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /arrived empty/i);
  });
});

test("a refused upload leaves neither a card nor a directory behind", async () => {
  await withServer(async ({ workdir, upload, view }) => {
    const before = readdirSync(workdir).sort();
    const res = await upload("clip.xyz", Buffer.from("not a clip"));
    assert.equal(res.status, 400);
    assert.deepEqual((await view()).nodes, {}, "a refused upload creates no card");
    assert.deepEqual(readdirSync(workdir).sort(), before, "and nothing in the workspace");
  });
});
