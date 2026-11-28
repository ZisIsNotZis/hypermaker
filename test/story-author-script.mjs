// Blank canvas → image-conditioned CLI fixture → edit → narrate → play → swap.
// Run from the repo root; this never calls a model or tests human listening.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium } from 'playwright';
import { harbourPng } from './harbour.mjs';
import { freePort, startServer, stopServer, waitReady } from './server.mjs';
import { correlation } from '../voice/bind.mjs';
import { wavSamples } from '../voice/wav.mjs';

const root = process.cwd();
const chrome = process.env.HYPERMAKER_CHROME || process.env.CHROME_BIN;
const espeak = process.env.HYPERMAKER_ESPEAK;
assert.ok(chrome && existsSync(chrome), 'set HYPERMAKER_CHROME to the Chromium binary');
assert.ok(espeak && existsSync(espeak), 'set HYPERMAKER_ESPEAK to the eSpeak NG binary');
const out = mkdtempSync(join(tmpdir(), 'hyper-author-script-'));
const evidence = process.env.STORY_OUT || join(root, '.tmp', 'story-author-script');
mkdirSync(evidence, { recursive: true });
const ws = join(out, 'workspace');
const intent = 'A quiet harbour going from morning to evening, as if the boats are coming home.';
const draft = ['The first light finds the boats at rest.', 'At dusk the last boat turns for home.'];
const edited = [draft[0], 'At dusk a steady lamp guides the last boat back to shore.'];
const photos = ['dawn', 'dusk', 'nightferry'].map(name => {
  const file = join(out, `${name}.png`);
  writeFileSync(file, harbourPng(name));
  return file;
});
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const hashes = photos.map(sha);
assert.equal(new Set(hashes).size, 3);
const log = join(out, 'fixture.jsonl'), fixture = join(out, 'codex.mjs');
writeFileSync(fixture, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const images = argv.flatMap((arg, i) => arg === '--image' ? [argv[i + 1]] : []);
const prompt = readFileSync(join(process.env.HYPERMAKER_NODE_DIR, 'prompt.txt'), 'utf8');
const hashes = images.map(file => createHash('sha256').update(readFileSync(file)).digest('hex'));
const value = key => argv.includes(key) ? argv[argv.indexOf(key) + 1] : null;
const model = value('--model');
appendFileSync(${JSON.stringify(log)}, JSON.stringify({images, hashes, model, configOverride: value('-c'), intentSeen: prompt.includes(${JSON.stringify(intent)})}) + '\\n');
if (model === 'gh/fixture-vision') {
  console.log(JSON.stringify({type: 'turn.started'}));
  console.error('workspace routing discovery failed: private-route-marker');
  process.exit(1);
}
const flag = argv.indexOf('--output-last-message');
if (flag < 0 || !argv[flag + 1]) throw Error('missing last-message output path');
writeFileSync(argv[flag + 1], ${JSON.stringify(draft.join('\n') + '\n')});
`);
const lines = text => text.trim().split(/\r?\n/);
const read = path => readFileSync(path, 'utf8');
const calls = () => existsSync(log) ? lines(read(log)).filter(Boolean).map(JSON.parse) : [];
const pathFor = (id, file) => join(ws, String(id), file);
const ff = args => execFileSync(join(root, 'node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
let gridId = 0;
function grid(path) {
  const output = join(out, `grid-${++gridId}.rgb`);
  ff(['-i', path, '-frames:v', '1', '-vf', 'crop=iw:ih*0.6667:0:0,scale=24:14:force_original_aspect_ratio=increase,crop=24:14', '-pix_fmt', 'rgb24', '-c:v', 'rawvideo', '-f', 'image2', output]);
  return readFileSync(output);
}
const grids = photos.map(grid);
const port = await freePort();
const app = startServer({ cwd: root, port, env: { CODEX_BIN: fixture, HYPERMAKER_WORKDIR: ws, HYPERMAKER_RESET_WORKSPACE: '1', HYPERMAKER_CHROME: chrome, HYPERMAKER_ESPEAK: espeak } });
const base = `http://127.0.0.1:${port}`;
const start = performance.now();
const elapsed = () => Math.round(performance.now() - start);
const receipt = { kind: 'synthetic canvas walk (no model)', pictures: photos, workspace: ws, intent, steps: {} };
const note = (name, row) => { receipt.steps[name] = { atMs: elapsed(), ...row }; console.log(name, JSON.stringify(receipt.steps[name])); };
let browser;
try {
  await waitReady(port);
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  const page = await browser.newPage({ viewport: { width: 1900, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const nodes = async () => (await (await fetch(`${base}/api/workspace`)).json()).nodes;
  const node = async id => (await nodes())[id];
  const card = id => page.locator(`.card[data-id="${id}"]`);
  async function until(check, what, ms = 10000) {
    const deadline = performance.now() + ms;
    do {
      const value = await check();
      if (value) return value;
      await page.waitForTimeout(100);
    } while (performance.now() < deadline);
    assert.fail(`timed out: ${what}`);
  }
  async function add(x, type, method, y = 600) {
    const old = new Set(Object.keys(await nodes()));
    assert.ok(await page.evaluate(([left, top]) => !document.elementFromPoint(left, top)?.closest('.card'), [x, y]), 'new card starts on empty canvas');
    await page.mouse.dblclick(x, y);
    const id = Number(await until(async () => Object.keys(await nodes()).find(id => !old.has(id)), 'a new card'));
    if (type !== 'text') await card(id).locator('[data-field=type]').selectOption(type);
    const menu = card(id).locator('[data-field=method]');
    await menu.locator(`option[value="${method}"]`).waitFor({ state: 'attached', timeout: 10000 });
    if (await menu.inputValue() !== method) await menu.selectOption(method);
    await until(async () => (await node(id))?.method === method, `#${id} stores ${method}`);
    return id;
  }
  async function link(from, to, expected) {
    const a = await card(from).locator('header').boundingBox(), b = await card(to).locator('header').boundingBox();
    await page.mouse.move(a.x + 40, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up();
    await until(async () => JSON.stringify((await node(to)).inputs) === JSON.stringify(expected), `#${to} receives links ${expected}`);
  }
  async function typeIn(id, text) {
    const box = card(id).locator('[data-prompt]');
    await box.fill(text);
    await box.blur();
    await until(async () => (await node(id))?.prompt === text, `#${id} stores typed text`);
  }
  async function make(id, label) {
    const before = await node(id);
    await card(id).getByRole('button', { name: label, exact: true }).click({ timeout: 10000 });
    const next = await until(async () => {
      const n = await node(id);
      return n?.status !== 'running' && (n?.error || (n?.artifact && n.artifact !== before.artifact)) && n;
    }, `#${id} ${label} publishes`, 180000);
    assert.equal(next.error, null, `#${id} ${label} refused: ${next.error}`);
    return next;
  }
  await page.goto(base);
  await page.locator('#cards').waitFor();
  assert.deepEqual(Object.keys(await nodes()), []);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#add-file').click()]);
  await chooser.setFiles(photos.slice(0, 2));
  const supplied = await until(async () => {
    const nn = Object.values(await nodes()).filter(n => n.type === 'image').sort((a, b) => a.x - b.x);
    return nn.length === 2 && nn;
  }, 'two supplied pictures');
  const pics = supplied.map(n => n.id);
  const live = supplied.map(n => pathFor(n.id, n.artifact));
  assert.deepEqual(live.map(sha), hashes.slice(0, 2));
  const writer = await add(80, 'text', 'two-act');
  const methodText = await until(async () => {
    const text = await card(writer).locator('.method-slot').innerText({ timeout: 1000 });
    return text.includes('sends both pictures and the intent through Codex') && text;
  }, 'the two-act card states what Generate sends');
  assert.match(methodText, /sends both pictures and the intent through Codex/);
  await link(pics[0], writer, pics.slice(0, 1));
  await link(pics[1], writer, pics);
  await typeIn(writer, intent);
  const draftStart = elapsed();
  const first = await make(writer, 'Generate');
  assert.deepEqual(lines(read(pathFor(writer, first.artifact))), draft);
  await until(async () => (await card(writer).locator('.preview pre').textContent({ timeout: 1000 }))?.trim() === draft.join('\n'), 'the draft is on the canvas');
  assert.equal(calls().length, 1);
  const [call] = calls();
  assert.ok(call.intentSeen, 'the fixture saw the user intent');
  assert.deepEqual(call.hashes, hashes.slice(0, 2), 'the right image bytes in act order');
  assert.deepEqual(call.images, first.sources.map(s => pathFor(writer, s.file)), 'the take’s own frozen inputs');
  assert.ok(call.images.every(file => !live.includes(file)), 'attachments are not live files');
  const invocation = JSON.parse(read(pathFor(writer, 'codex-command.json')));
  assert.equal(invocation.route, 'simulated-cli');
  assert.equal(invocation.imageCount, 2);
  assert.equal(invocation.model, null);
  assert.equal(invocation.effort, null);
  assert.equal(call.model, null, 'leaving Codex model blank sends no --model override');
  assert.equal(call.configOverride, null, 'configured effort sends no -c override');
  assert.equal(invocation.args, undefined);
  const runRows = lines(read(pathFor(writer, 'codex.jsonl'))).map(JSON.parse);
  assert.equal(runRows.length, 1);
  const [run] = runRows;
  assert.equal(run.type, 'two-act.run');
  assert.equal(run.route, 'simulated-cli');
  assert.equal(run.exit, 0);
  assert.ok(!run.timedOut && !run.cancelled);
  assert.equal(run.usage, null);
  note('draft', { durationMs: elapsed() - draftStart, artifact: first.artifact, lines: draft, fixture: call, invocation, run });

  await card(writer).getByRole('button', { name: 'Edit script locally', exact: true }).click({ timeout: 10000 });
  const switched = await until(async () => { const n = await node(writer); return n.method === 'plain' && n; }, 'draft becomes local plain');
  assert.deepEqual(lines(switched.prompt), draft);
  await until(async () => lines(await card(writer).locator('[data-prompt]').inputValue()).join('\n') === draft.join('\n'), 'editor populated with draft');
  assert.deepEqual(switched.inputs, pics);
  assert.equal(switched.artifact, first.artifact);
  await typeIn(writer, edited.join('\n'));
  assert.deepEqual(lines(read(pathFor(writer, (await node(writer)).artifact))), draft, 'published script unchanged until Make');
  const local = await make(writer, 'Make');
  assert.deepEqual(lines(read(pathFor(writer, local.artifact))), edited);
  assert.deepEqual(local.inputs, pics);
  const original = local.versions?.find(v => v.artifact === first.artifact);
  assert.ok(original, 'the original draft is kept');
  assert.deepEqual(lines(read(pathFor(writer, original.file))), draft);
  assert.deepEqual(original.sources, first.sources);
  note('edit', { before: first.artifact, after: local.artifact, kept: original.file, lines: edited, links: local.inputs });

  const voice = await add(420, 'audio', 'readaloud');
  await link(writer, voice, [writer]);
  const pace = card(voice).locator('.repace input');
  await pace.fill('150');
  await pace.blur();
  const take = await make(voice, 'Make');
  assert.equal(take.narration?.voice?.engine, 'espeak-ng');
  assert.equal(take.sources[0].artifact, local.artifact);
  const wav = pathFor(voice, take.artifact), wavHash = sha(wav);
  const expected = wavSamples(readFileSync(wav)).samples;
  assert.deepEqual(take.narration.phrases.map(phrase => phrase.text), edited);
  note('narration', { source: take.sources[0].artifact, artifact: take.artifact, wavHash, voice: take.narration.voice, phrases: take.narration.phrases });

  const film = await add(760, 'video', 'firstcut');
  const inputs = [voice, ...pics];
  for (let i = 0; i < inputs.length; i++) await link(inputs[i], film, inputs.slice(0, i + 1));
  async function measure(cut, indexes, tag) {
    const file = pathFor(film, cut.artifact);
    const { scenes, soundtrack } = cut.film;
    assert.equal(scenes.length, 2);
    assert.deepEqual(scenes.map(scene => scene.caption), edited);
    assert.equal(sha(pathFor(film, soundtrack.file)), wavHash);
    const samples = [];
    const scores = scenes.map((scene, i) => {
      const at = (Number(scene.start) + Number(scene.end)) / 2;
      const sample = join(evidence, `${tag}-act-${i + 1}.png`);
      ff(['-ss', String(at), '-i', file, '-frames:v', '1', sample]);
      samples.push(basename(sample));
      const frame = grid(sample);
      const row = grids.map(picture => correlation(frame, picture));
      assert.ok(row[indexes[i]] > 0.8 && row.every((score, j) => j === indexes[i] || row[indexes[i]] - score > 0.2), `act ${i + 1} shows the intended picture: ${row}`);
      return row.map(v => Number(v.toFixed(3)));
    });
    const decoded = join(out, `${basename(file)}.wav`);
    ff(['-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '22050', decoded]);
    const heard = wavSamples(readFileSync(decoded)).samples;
    assert.ok(heard.length >= expected.length - 2205, 'the film’s audio covers the take');
    let best = -1;
    for (let d = -2205; d <= 2205; d++) best = Math.max(best, correlation(heard.subarray(22050, 44100), expected.subarray(22050 + d, 44100 + d)));
    assert.ok(best > 0.8, `the film actually plays the take it names: ${best}`);
    const player = card(film).locator('video');
    await until(async () => {
      const src = await player.getAttribute('src', { timeout: 1000 });
      return src && new URL(src, base).searchParams.get('path')?.endsWith(`/${cut.artifact}`);
    }, `the canvas player loads ${cut.artifact}`);
    const playback = await player.evaluate(async video => {
      video.muted = true;
      await video.play();
      await new Promise(resolve => setTimeout(resolve, 700));
      video.pause();
      return { seconds: video.currentTime, duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    }, undefined, { timeout: 10000 });
    assert.ok(playback.seconds > 0.3 && playback.width > 0 && playback.height > 0, `Chromium plays the published film: ${JSON.stringify(playback)}`);
    return { artifact: cut.artifact, scores, samples, playback, heardMatch: Number(best.toFixed(4)), decodedHash: sha(decoded), captions: scenes.map(scene => scene.caption) };
  }
  const cutStart = elapsed();
  const before = await make(film, 'Make');
  const firstMeasurement = await measure(before, [0, 1], 'first');
  note('first cut', { durationMs: elapsed() - cutStart, ...firstMeasurement });
  const box = await card(pics[1]).boundingBox();
  const accepted = await page.evaluate(({ b64, x, y }) => {
    const hit = document.elementFromPoint(x, y);
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'nightferry.png', { type: 'image/png' }));
    return ['dragover', 'drop'].map(type => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x, clientY: y });
      hit.dispatchEvent(event);
      return event.defaultPrevented;
    });
  }, { b64: readFileSync(photos[2]).toString('base64'), x: box.x + box.width / 2, y: box.y + box.height / 2 });
  assert.deepEqual(accepted, [true, true]);
  const swap = await until(async () => { const n = await node(pics[1]); return n.artifact !== supplied[1].artifact && n; }, 'a new picture on the same card');
  assert.equal(sha(pathFor(pics[1], swap.artifact)), hashes[2]);
  assert.equal(sha(pathFor(pics[1], swap.versions[0].file)), hashes[1]);
  assert.equal(sha(live[0]), hashes[0]);
  assert.equal(sha(call.images[1]), hashes[1]);
  assert.deepEqual(photos.map(sha), hashes, 'source files outside the workspace are unchanged');
  const recutStart = elapsed();
  const after = await make(film, 'Make');
  const final = await nodes();
  assert.deepEqual(final[film].inputs, inputs);
  assert.deepEqual(final[writer].inputs, pics);
  assert.equal(final[writer].artifact, local.artifact);
  assert.equal(final[voice].artifact, take.artifact);
  assert.equal(sha(wav), wavHash);
  assert.ok(after.versions?.some(v => v.artifact === before.artifact && existsSync(pathFor(film, v.file))), 'the first film is kept');
  assert.equal(calls().length, 1, 'all subsequent steps were local');
  const secondMeasurement = await measure(after, [0, 2], 'recut');
  assert.equal(secondMeasurement.decodedHash, firstMeasurement.decodedHash, 'the complete decoded audio is unchanged');
  assert.deepEqual(errors, []);
  note('re-cut', { durationMs: elapsed() - recutStart, ...secondMeasurement, keptFilm: before.artifact, keptPicture: swap.versions[0].file, dragGates: accepted, wavHash });
  // Exercise the first-draft failure path too: a custom name is forwarded as-is,
  // a discovery failure names the blocker, and writing locally never enters Codex.
  const fallback = await add(1510, 'text', 'two-act', 420);
  for (const [i, picture] of pics.entries()) await link(picture, fallback, pics.slice(0, i + 1));
  await typeIn(fallback, intent);
  await page.getByRole('textbox', { name: 'Codex model' }).fill(' gh/fixture-vision ');
  await page.locator('#effort').selectOption('low', { timeout: 5000 });
  const fallbackCard = card(fallback);
  await fallbackCard.getByRole('button', { name: 'Generate', exact: true }).click();
  const failed = await until(async () => { const n = await node(fallback); return n?.error && n; }, 'the discovery failure is reported');
  assert.ok(!failed.artifact);
  assert.deepEqual(failed.inputs, pics);
  assert.match(failed.error, /could not discover its configured route/);
  assert.doesNotMatch(failed.error, /private-route-marker/);
  await fallbackCard.getByText(/could not discover its configured route/).waitFor({state: 'visible', timeout: 5000});
  await page.screenshot({ path: join(evidence, 'route-error.png') });
  const failedRun = JSON.parse(read(pathFor(fallback, 'codex.jsonl')));
  assert.equal(failedRun.outcome, 'discovery');
  assert.equal(failedRun.turnStarted, true);
  assert.doesNotMatch(JSON.stringify(failedRun), /private-route-marker/);
  const attempts = calls();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].model, 'gh/fixture-vision');
  assert.equal(attempts[1].configOverride, 'model_reasoning_effort=low');
  await fallbackCard.getByRole('button', { name: 'Write script locally', exact: true }).click();
  await until(async () => (await node(fallback)).method === 'plain', 'switch to local script');
  await fallbackCard.getByText(/Replace your brief with two script lines/).waitFor({state: 'visible', timeout: 5000});
  assert.equal(await fallbackCard.locator('[data-prompt]').inputValue(), intent, 'brief is kept until the person replaces it');
  await typeIn(fallback, edited.join('\n'));
  // A last-run error stays on the card until Make starts. Wait for the artifact,
  // not the old error that may still be visible between the press and the run.
  await fallbackCard.getByRole('button', { name: 'Make', exact: true }).click();
  const handwritten = await until(async () => { const n = await node(fallback); return n?.artifact && n; }, 'handwritten local script publishes');
  assert.deepEqual(lines(read(pathFor(fallback, handwritten.artifact))), edited);
  assert.deepEqual(handwritten.inputs, pics);
  assert.equal(calls().length, 2);
  assert.deepEqual(errors, []);
  note('local fallback', { error: failed.error, run: failedRun, artifact: handwritten.artifact, lines: edited });
  // Continue the normal canvas gesture after a failed draft, all the way to a cut.
  await page.setViewportSize({width: 2850, height: 1100});
  const localVoice = await add(1950, 'audio', 'readaloud', 420);
  await link(fallback, localVoice, [fallback]);
  const localTake = await make(localVoice, 'Make');
  assert.equal(localTake.sources[0].artifact, handwritten.artifact);
  assert.deepEqual(localTake.narration.phrases.map(x=>x.text), edited);
  const localFilm = await add(2380, 'video', 'firstcut', 420);
  const localInputs = [localVoice, ...pics];
  for (let i=0;i<localInputs.length;i++) await link(localInputs[i], localFilm, localInputs.slice(0,i+1));
  const localCut = await make(localFilm, 'Make');
  assert.deepEqual(localCut.film.scenes.map(x=>x.caption), edited);
  const video = card(localFilm).locator('video');
  await video.waitFor({state:'attached'});
  const continued = await video.evaluate(async player => {
    player.muted=true;
    await player.play();
    await new Promise(resolve=>setTimeout(resolve,700));
    player.pause();
    return {time:player.currentTime,width:player.videoWidth,height:player.videoHeight};
  });
  assert.ok(continued.time>0);
  assert.deepEqual([continued.width,continued.height],[1280,720]);
  assert.equal(calls().length,2);
  const fallbackMovie=pathFor(localFilm,localCut.artifact);
  ff(['-i',fallbackMovie,'-map','0:a:0','-ac','1','-ar','22050',join(evidence,'fallback-decoded.wav')]);
  note('fallback film', {artifact:localCut.artifact,playback:continued,captions:localCut.film.scenes.map(x=>x.caption)});

  receipt.passed = true;
} catch (error) {
  receipt.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  receipt.durationMs = elapsed();
  receipt.calls = calls();
  const file = join(evidence, 'receipt.json');
  writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
  console.log(`receipt: ${file}`);
  try { await browser?.close(); } finally { stopServer(app); }
}
