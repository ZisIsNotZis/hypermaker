// Blank canvas → two pictures + handwritten text → play → recut → restore.
// Default: generated title cards. --local-files: choose and replace ordinary local PNGs.
// Add --restart to close both processes, reopen, and finish through video compare.
// No engine, model, account or remote requests. Run from the repository root.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { harbourPng } from './harbour.mjs';
import { parseWorkspace } from '../server/workspace.mjs';
import { freePort, startServer, stopServer, waitReady } from './server.mjs';

const localFiles = process.argv.includes('--local-files');
const restart = process.argv.includes('--restart');
assert.ok(!restart || localFiles, 'use --restart with --local-files');
const root = process.cwd();
const chrome = process.env.HYPERMAKER_CHROME || process.env.CHROME_BIN;
assert.ok(chrome && existsSync(chrome), 'set HYPERMAKER_CHROME to an existing Chromium executable');
const out = mkdtempSync(join(tmpdir(), 'hyper-captions-'));
const ws = join(out, 'workspace');
const evidence = process.env.STORY_OUT || join(root, restart ? '.tmp/story-reopen' : localFiles ? '.tmp/story-local-pictures' : '.tmp/story-captions-only');
mkdirSync(evidence, { recursive: true });
const story = localFiles ? ['The harbour wakes before the sun.', 'The last boat crosses as the lights come on.']
  : ['The flood washes the market road away.', 'By dawn, the village takes the high crossing.'];
const pictures = ['harbour-dawn.png', 'harbour-dusk.png', 'night-ferry.png'];
if (localFiles) for (const [i, drawing] of ['dawn', 'dusk', 'nightferry'].entries()) {
  writeFileSync(join(out, pictures[i]), harbourPng(drawing));
  copyFileSync(join(out, pictures[i]), join(evidence, pictures[i]));
}
const fixture = join(out, 'no-codex.mjs'), call = join(out, 'codex-called');
writeFileSync(fixture, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(call)}, 'unexpected Codex invocation');\nprocess.exit(1);\n`);
const env = { CODEX_BIN: fixture, HYPERMAKER_WORKDIR: ws, NODE_ENV: 'development', HYPERMAKER_RESET_WORKSPACE: '0', HYPERMAKER_CHROME: chrome, HYPERMAKER_ESPEAK: join(out, 'absent-espeak-ng') };
const engine = spawnSync(process.execPath, ['--input-type=module', '-e', `import { engineStatus } from './voice/engine.mjs'; console.log(JSON.stringify(engineStatus().installed));`], { env: { ...process.env, ...env }, encoding: 'utf8' });
assert.equal(engine.status, 0, engine.stderr);
assert.equal(engine.stdout.trim(), 'false', 'the engine cannot be discovered in this fixture');
const port = await freePort();
let app = startServer({ cwd: root, port, env });
const base = `http://127.0.0.1:${port}`;
const fileFor = (id, file) => join(ws, String(id), file);
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const tool = (name, args) => execFileSync(join(root, 'node_modules/@remotion/compositor-linux-x64-gnu', name), args);
let browser;
try {
  await waitReady(port);
  const nodes = async () => (await (await fetch(`${base}/api/workspace`)).json()).nodes;
  const errors = [], external = [], imports = [];
  let page;
  async function openBrowser() {
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 970 } });
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { external.push(url.origin); return route.abort(); }
      if (/^\/api\/(upload|replace)$/.test(url.pathname)) { imports.push(url.pathname); if (!localFiles) return route.abort(); }
      return route.continue();
    });
    await page.goto(base);
  }
  await openBrowser();
  const node = async id => (await nodes())[id];
  const card = id => page.locator(`.card[data-id="${id}"]`);
  async function until(check, what, ms = 10000) {
    const deadline = performance.now() + ms;
    do {
      const result = await check();
      if (result) return result;
      await page.waitForTimeout(100);
    } while (performance.now() < deadline);
    assert.fail(`timed out: ${what}`);
  }
  async function add(x, y, type, method) {
    const old = new Set(Object.keys(await nodes()));
    await page.mouse.dblclick(x, y);
    const id = Number(await until(async () => Object.keys(await nodes()).find(id => !old.has(id)), 'new card'));
    if (type !== 'text') await card(id).getByLabel('Output type').selectOption(type);
    await until(async () => (await node(id)).method === method, `#${id} defaults to ${method}`);
    return id;
  }
  async function typeIn(id, text) {
    const box = card(id).getByLabel('Prompt');
    await box.fill(text);
    await box.blur();
    await until(async () => (await node(id)).prompt === text, `#${id} stores its text`);
  }
  async function make(id) {
    const before = (await node(id)).artifact;
    await card(id).getByRole('button', { name: 'Make', exact: true }).click({ timeout: 10000 });
    const result = await until(async () => {
      const n = await node(id);
      return n.status !== 'running' && (n.error || (n.artifact && n.artifact !== before)) && n;
    }, `#${id} makes a version`, 180000);
    assert.equal(result.error, null, `#${id} failed: ${result.error}`);
    return result;
  }
  async function choose(name) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#add-file').click()]);
    await chooser.setFiles(join(out, name));
    const n = await until(async () => Object.values(await nodes()).find(n => n.artifact === name), `file ${name} is imported`);
    await card(n.id).getByRole('img').waitFor();
    assert.equal(n.method, null);
    assert.equal(sha(fileFor(n.id, n.artifact)), sha(join(out, name)));
    return n.id;
  }
  async function dropOn(id, name) {
    const {x, y, width, height} = await card(id).locator('header').boundingBox();
    const result = await page.evaluate(({x, y, name, bytes}) => {
      const target = document.elementFromPoint(x, y);
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], name, {type: 'image/png'}));
      const dispatch = type => !target.dispatchEvent(new DragEvent(type, {clientX:x, clientY:y, dataTransfer, bubbles:true, cancelable:true}));
      return {card: Number(target.closest('.card')?.dataset.id), over: dispatch('dragover'), drop: dispatch('drop')};
    }, {x: x + width / 2, y: y + height / 2, name, bytes: readFileSync(join(out, name)).toString('base64')});
    assert.deepEqual(result, {card: id, over: true, drop: true});
    return until(async () => { const n = await node(id); return n.artifact.includes(name) && n; }, 'act II card changes its file');
  }
  async function link(from, to, expected) {
    const [a, b] = await Promise.all([card(from).locator('header').boundingBox(), card(to).locator('header').boundingBox()]);
    await page.mouse.move(a.x + 35, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 35, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up();
    await until(async () => JSON.stringify((await node(to)).inputs) === JSON.stringify(expected), `#${to} gets links ${expected}`);
  }
  async function play(n, throughEnd = false, player = card(n.id).locator('.preview video')) {
    await until(async () => (await player.getAttribute('src', { timeout: 2000 }))?.includes(encodeURIComponent(n.artifact)), `player loads ${n.artifact}`);
    if (localFiles) {
      await until(() => player.evaluate(video => {
        if (video.error) throw new Error(`Video failed to load (${video.error.code}): ${video.error.message}`);
        return video.readyState >= 1;
      }, undefined, { timeout: 2000 }), `video metadata for ${n.artifact}`, 5000);
      // The lower-left native control is Chromium's Play button at this card size.
      const box = await player.boundingBox();
      await player.click({ position: { x: 24, y: box.height - 47 }, timeout: 5000 });
    }
    const played = await player.evaluate(async (video, {throughEnd, localFiles}) => {
      if (!localFiles) await video.play();
      if (video.paused) throw new Error('The canvas player did not start');
      if (throughEnd) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Video never reached its end')), 12000);
          video.addEventListener('ended', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      } else await new Promise(resolve => setTimeout(resolve, 500));
      video.pause();
      return { at: video.currentTime, duration: video.duration, ended: video.ended, width: video.videoWidth, height: video.videoHeight };
    }, {throughEnd, localFiles});
    if (throughEnd) assert.ok(played.ended, JSON.stringify(played));
    assert.ok(played.at >= 0.25 && played.width === 1280 && played.height === 720, JSON.stringify(played));
    assert.ok(Math.abs(played.duration - n.film.seconds) <= 0.04, JSON.stringify(played));
    return played;
  }
  function measure(n, expectedPictures, tag) {
    const file = fileFor(n.id, n.artifact);
    assert.equal(n.film.soundtrack, null);
    assert.equal(n.film.audioCodec, null);
    const probe = JSON.parse(tool('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
    assert.deepEqual(probe.streams.map(s => [s.codec_type, s.codec_name]), [['video', 'h264']]);
    assert.match(probe.format.format_name, /\bmp4\b/);
    assert.ok(Math.abs(Number(probe.format.duration) - n.film.seconds) <= 0.04);
    assert.deepEqual(n.film.scenes.map(s => s.from.artifact), expectedPictures);
    assert.deepEqual(n.film.scenes.map(s => s.caption), story);
    assert.equal(n.film.scenes[0].end, n.film.scenes[1].start);
    assert.equal(n.film.scenes[1].end, n.film.seconds);
    assert.equal(n.film.captions.cues.length, 2);
    // Extract actual first/mid/last frames of each act. Midpoints go in the evidence
    // bundle for a visual word-for-word check; staying visible at both edges is also tested.
    const seen = [];
    for (const [i, scene] of n.film.scenes.entries()) {
      assert.ok(scene.shown > 0.8, `scene ${i + 1}: picture match ${scene.shown}`);
      const cue = n.film.captions.cues[i];
      assert.equal(cue.scene, i);
      assert.ok(cue.seconds >= 3 && cue.charactersPerSecond <= 16, JSON.stringify(cue));
      assert.ok(Math.abs(scene.end - scene.start - cue.seconds) <= 0.021);
      const at = (scene.start + scene.end) / 2;
      tool('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', file, '-frames:v', '1', join(evidence, `${tag}-act-${i + 1}.png`)]);
      const captionPixels = time => tool('ffmpeg', ['-v', 'error', '-i', file, '-ss', time.toFixed(6), '-frames:v', '1', '-vf', 'crop=1120:140:48:540,format=gray', '-c:v', 'rawvideo', '-f', 'image2pipe', '-']).filter(v => v >= 225).length;
      const onScreen = [scene.start, at, scene.end - 0.037].map(captionPixels);
      assert.ok(onScreen.every(white => white > 600), `act ${i + 1}: bright caption pixels at start/mid/end: ${onScreen}`);
      seen.push({ picture: scene.from, text: scene.caption, start: scene.start, end: scene.end, match: scene.shown, cue, captionPixels: onScreen });
    }
    return { artifact: n.artifact, sha256: sha(file), seconds: n.film.seconds, streams: probe.streams.map(s => s.codec_type), scenes: seen };
  }

  await page.locator('#cards').waitFor();
  assert.deepEqual(Object.keys(await nodes()), []);
  let text, a, b, film;
  if (localFiles) {
    a = await choose(pictures[0]);
    b = await choose(pictures[1]);
    for (const id of [a, b]) {
      await card(id).getByText(/Imported file.*without changing its links/).waitFor();
      assert.equal(await card(id).getByRole('button', { name: 'Generate', exact: true }).isVisible(), false);
      assert.equal(await card(id).getByLabel('Generation method').isVisible(), false);
      const {x, y, width, height} = await card(id).locator('header').boundingBox();
      assert.equal(await page.evaluate(({x, y}) => Number(document.elementFromPoint(x, y)?.closest('.card')?.dataset.id),
        {x: x + width / 2, y: y + height / 2}), id, `imported card #${id} has a reachable header`);
    }
    text = await add(75, 150, 'text', 'plain');
    film = await add(420, 150, 'video', 'firstcut');
  } else {
    text = await add(75, 150, 'text', 'plain');
    a = await add(400, 150, 'image', 'titlecard');
    b = await add(725, 150, 'image', 'titlecard');
    film = await add(1050, 150, 'video', 'firstcut');
  }
  await card(film).getByText(/No speech engine needed/).waitFor({ timeout: 5000 });
  await typeIn(text, story.join('\n'));
  const script = await make(text);
  assert.equal(readFileSync(fileFor(text, script.artifact), 'utf8').trim(), story.join('\n'));
  if (!localFiles) {
    await typeIn(a, 'Market road closed\nThe river has cut the valley in two.');
    await typeIn(b, 'High bridge open\nThe first walkers cross above the flood.');
  }
  const firstImage = localFiles ? await node(a) : await make(a), secondImage = localFiles ? await node(b) : await make(b);
  const links = [text, a, b];
  for (const [i, id] of links.entries()) await link(id, film, links.slice(0, i + 1));
  await card(film).locator('.method-slot').filter({ hasText: /Captions only \(no audio\)/ }).waitFor({ timeout: 5000 });
  const first = await make(film);
  const cut = measure(first, [firstImage.artifact, secondImage.artifact], 'first');
  cut.play = await play(first, true);
  await card(film).locator('.film').filter({ hasText: /captions only \(no audio\)/ }).waitFor({ timeout: 5000 });
  await page.screenshot({ path: join(evidence, 'canvas-first.png') });

  // Edit only act II's picture card. Recut, then use the visible kept-version button.
  let replacement;
  if (localFiles) {
    replacement = await dropOn(b, pictures[2]);
    assert.equal(sha(fileFor(b, replacement.artifact)), sha(join(out, pictures[2])));
    const oldPicture = replacement.versions.find(v => v.artifact === secondImage.artifact);
    assert.ok(oldPicture);
    assert.equal(sha(fileFor(b, oldPicture.file)), sha(join(out, pictures[1])));
    assert.deepEqual((await node(film)).inputs, links);
    assert.equal((await node(film)).artifact, first.artifact);
    assert.equal(sha(fileFor(film, first.artifact)), cut.sha256);
    await card(film).locator('.next-slot').filter({ hasText: pictures[2] }).waitFor({ timeout: 5000 });
  } else {
    await typeIn(b, 'Crossing at sunrise\nLanterns go out as the last walker reaches the ridge.');
    replacement = await make(b);
  }
  assert.notEqual(sha(fileFor(b, replacement.artifact)), sha(fileFor(b, secondImage.artifact)));
  const second = await make(film);
  const recut = measure(second, [firstImage.artifact, replacement.artifact], 'recut');
  assert.notEqual(recut.sha256, cut.sha256);
  assert.equal(sha(join(evidence, 'recut-act-1.png')), sha(join(evidence, 'first-act-1.png')));
  assert.notEqual(sha(join(evidence, 'recut-act-2.png')), sha(join(evidence, 'first-act-2.png')));
  recut.play = await play(second, localFiles);
  assert.deepEqual(second.inputs, links);
  const old = second.versions.find(v => v.artifact === first.artifact);
  assert.ok(old, 'the earlier cut is offered as a kept version');
  assert.equal(sha(fileFor(film, old.file)), cut.sha256);
  let reopened;
  if (restart) {
    // Close the whole Chromium process and wait for the server to exit before starting it again.
    await browser.close();
    const exited = once(app, 'exit', { signal: AbortSignal.timeout(5000) });
    assert.ok(app.kill('SIGTERM'), 'stop the first server');
    await exited;
    app = startServer({ cwd: root, port, env });
    await waitReady(port);
    await openBrowser();
    await card(film).locator('header').getByText(/v2/).waitFor({ timeout: 5000 });
    await card(film).locator('.sources-slot').getByText(pictures[2], { exact: true }).waitFor();
    await page.screenshot({ path: join(evidence, 'canvas-reopened.png') });
    await card(film).locator('[data-compare]').click({ timeout: 5000 });
    const current = page.locator('.cmp [data-side="left"]');
    const previous = page.locator('.cmp [data-side="right"]');
    for (const [side, image] of [[current, pictures[2]], [previous, pictures[1]]]) {
      await side.getByText(pictures[0], { exact: true }).waitFor();
      await side.getByText(image, { exact: true }).waitFor();
    }
    await current.getByText('Current on the card · v2', { exact: true }).waitFor();
    await previous.getByText('kept v1', { exact: true }).waitFor();
    await page.screenshot({ path: join(evidence, 'compare-reopened.png') });
    const playOld = await play({ ...first, artifact: old.file }, true, previous.locator('video'));
    const exports = [];
    for (const [pane, version, expected] of [[previous, 'v1', cut], [current, 'v2', recut]]) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 5000 }),
        pane.getByRole('button', { name: `Download ${version}`, exact: true }).click({ timeout: 5000 })
      ]);
      const filename = download.suggestedFilename();
      assert.equal(filename, `film-${version}.mp4`);
      const exported = join(evidence, filename);
      await download.saveAs(exported);
      assert.equal(sha(exported), expected.sha256);
      exports.push({ filename, sha256: sha(exported) });
    }
    assert.equal((await node(film)).artifact, second.artifact, 'playing and downloading a kept cut does not switch the current film');
    await previous.getByRole('button', { name: 'Use v1 on canvas', exact: true }).click({ timeout: 5000 });
    await page.locator('.cmp').waitFor({ state: 'detached', timeout: 5000 });
    await card(film).locator('header').getByText(/v1/).waitFor({ timeout: 5000 });
    await card(film).locator('.sources-slot').getByText(pictures[1], { exact: true }).waitFor();
    await card(film).locator('.next-slot').getByText(pictures[2], { exact: true }).waitFor();
    reopened = { current: second.artifact, compared: first.artifact, playedPrevious: playOld, exports };
  } else {
    const diskNode = parseWorkspace(readFileSync(join(ws, 'workspace.yml'), 'utf8'))[film];
    assert.deepEqual(diskNode.versions.find(v => v.id === old.id).film, first.film);
    await page.reload();
    await card(film).locator(`[data-version="${old.id}"]`).click({ timeout: 5000 });
  }
  const restored = await until(async () => { const n = await node(film); return n.artifact === old.file && n; }, 'the canvas restores the old MP4');
  assert.deepEqual(restored.inputs, links);
  assert.deepEqual(restored.film, first.film);
  assert.deepEqual(restored.sources, first.sources);
  assert.equal(restored.script, first.script);
  assert.ok(existsSync(fileFor(film, restored.script)));
  assert.equal(sha(fileFor(film, restored.artifact)), cut.sha256);
  assert.ok(restored.versions.some(v => v.artifact === second.artifact));
  const restoredPlay = await play(restored);
  await page.screenshot({ path: join(evidence, 'canvas-restored.png') });
  if (restart) {
    const revised = 'The night ferry brings the last crew home.';
    await typeIn(text, [story[0], revised].join('\n'));
    await make(text);
    const continued = await make(film);
    assert.deepEqual(continued.inputs, links);
    assert.deepEqual(continued.film.scenes.map(s => s.caption), [story[0], revised]);
    assert.deepEqual(continued.film.scenes.map(s => s.from.artifact), [firstImage.artifact, replacement.artifact]);
    assert.ok([first.artifact, second.artifact].every(file => continued.versions.some(v => v.artifact === file)));
    const output = join(evidence, 'continued.mp4');
    copyFileSync(fileFor(film, continued.artifact), output);
    reopened.continued = { file: continued.artifact, sha256: sha(output), scenes: continued.film.scenes, links, play: await play(continued, true) };
    await page.screenshot({ path: join(evidence, 'canvas-continued.png') });

    // Three takes, including two with identical night-ferry pictures but different
    // second captions. Select by remembered content, not by an ordinal or a live card.
    const compareButton = card(film).getByRole('button', { name: 'compare', exact: true });
    await compareButton.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'film.mp4 — compare takes' });
    await dialog.waitFor();
    assert.equal(await dialog.locator('summary').evaluate(el => el === document.activeElement), true);
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      assert.equal(await dialog.evaluate(el => el.contains(document.activeElement) || document.activeElement === document.body), true,
        'Tab never reaches a canvas control behind Compare');
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await compareButton.evaluate(el => el === document.activeElement), true, 'Escape closes and returns to Compare');
    await compareButton.click();
    const finder = page.locator('.cmp .take-finder');
    await finder.getByText('Find a take by picture or caption', { exact: true }).waitFor();
    assert.equal(await finder.locator('.take-row').count(), 3);
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('.take-finder img')];
      return images.length === 6 && images.every(img => img.complete && img.naturalWidth > 0);
    }, null, { timeout: 5000 });
    const byCaption = finder.locator('.take-row').filter({ hasText: story[1] });
    assert.equal(await byCaption.count(), 2, 'remembering only the second caption still finds both old cuts');
    const byPicture = finder.locator('.take-row').filter({ hasText: pictures[2] });
    assert.equal(await byPicture.count(), 2, 'remembering only the night ferry still finds both night cuts');
    const target = byCaption.filter({ hasText: pictures[2] });
    assert.equal(await target.count(), 1, 'the frozen picture and old caption together identify the requested take');
    const sceneImages = await finder.locator('.take-scene img').evaluateAll(imgs => imgs.map(img => img.getAttribute('src')));
    assert.equal(new Set(sceneImages).size, 6, 'every picture comes from its own film version, not from the live picture card');
    // Read the same image responses the browser received, including the old dusk image
    // now absent from the live links. Six distinct URLs would not catch wrong pixels.
    const expectedImages = [pictures[0], pictures[2], pictures[0], pictures[2], pictures[0], pictures[1]];
    for (const [i, path] of sceneImages.entries()) {
      const response = await page.request.get(`${base}${path}`);
      assert.ok(response.ok());
      assert.equal(createHash('sha256').update(await response.body()).digest('hex'), sha(join(out, expectedImages[i])));
    }
    await page.screenshot({ path: join(evidence, 'find-three-takes.png') });
    await target.getByRole('button', { name: /Preview/ }).click();
    assert.equal(await target.getByRole('button').getAttribute('aria-pressed'), 'true');
    const right = page.locator('.cmp [data-side="right"]');
    const kept = continued.versions.find(v => v.artifact === second.artifact);
    const previewed = await play({ ...second, artifact: kept.file }, true, right.locator('video'));
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      right.getByRole('button', { name: /Download/ }).click(),
    ]);
    assert.equal(download.suggestedFilename(), 'film-v2.mp4');
    const delivered = join(evidence, 'delivery', download.suggestedFilename());
    await download.saveAs(delivered);
    assert.equal(sha(delivered), recut.sha256);
    assert.equal((await node(film)).artifact, continued.artifact, 'preview/export did not restore the kept cut');
    reopened.delivery = { previewed, file: delivered, sha256: recut.sha256 };
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(imports, localFiles ? ['/api/upload', '/api/upload', '/api/replace'] : []);
  assert.equal(existsSync(call), false, 'the model command never ran');
  if (reopened?.delivery) {
    await browser.close();
    const exited = once(app, 'exit', { signal: AbortSignal.timeout(5000) });
    assert.ok(app.kill('SIGTERM'), 'stop the application before opening the downloaded file');
    await exited;
    await assert.rejects(fetch(base, { signal: AbortSignal.timeout(2000) }), err => err.cause?.code === 'ECONNREFUSED');
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const viewer = await browser.newPage({viewport:{width:960, height:600}});
    const requests = [];
    await viewer.route(/^https?:/, route => { requests.push(route.request().url()); return route.abort(); });
    const file = pathToFileURL(resolve(reopened.delivery.file)).href;
    await viewer.goto(file);
    assert.equal(await viewer.locator('video').count(), 1, 'Chrome opens the MP4 without an application or HTML wrapper');
    const playback = await viewer.locator('video').evaluate(async video => {
      video.muted = true;
      await video.play();
      await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('Downloaded video did not end')), 12000);
        video.addEventListener('ended', () => { clearTimeout(timer); res(); }, { once:true });
      });
      return { ended:video.ended, seconds:video.duration, width:video.videoWidth, height:video.videoHeight };
    });
    assert.deepEqual(playback, {ended:true, seconds:6, width:1280, height:720});
    assert.deepEqual(requests, []);
    reopened.delivery.standalone = { ...playback, httpRequests: requests };
    await viewer.screenshot({ path:join(evidence, 'opened-delivered-file.png') });
  }
  const receipt = { story, workspace: ws, engineAvailable: false, modelCalls: 0, externalBrowserRequests: external, uploads: imports, cut, recut, reopened, restored: { file: restored.artifact, sha256: cut.sha256, play: restoredPlay, links, secondStillKept: second.artifact } };
  copyFileSync(fileFor(film, restored.artifact), join(evidence, 'first.mp4'));
  copyFileSync(fileFor(film, second.artifact), join(evidence, 'recut.mp4'));
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  console.error(app.log());
  throw error;
} finally {
  await browser?.close();
  stopServer(app);
}
