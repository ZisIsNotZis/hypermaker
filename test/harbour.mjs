// Two pictures with something IN them, drawn here rather than downloaded.
//
// Why this file exists: the first version of the story walk used flat colour blocks as the person's
// "own materials". They are enough to prove the person's bytes reach the film, and they are a bad
// test of the thing a viewer actually judges - whether a caption can be read over a *busy* picture.
// A flat colour is the easiest background text ever has.
//
// Nothing on this machine is a photograph, and this walk must not download one, so the pictures are
// drawn: sky gradients, a sun or a moon, layered water, a boat with a mast, scattered harbour lights
// and a gull. They are honest drawings, not photographs, and every receipt that uses them says so.
// What they give the check is the property that matters - detail under and around the caption band,
// a bright patch behind the words, and two clearly different compositions to tell the scenes apart.
import { deflateSync } from "node:zlib";

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = buf => { let c = 0xffffffff; for (const x of buf) c = TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};

const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
// A soft round light: bright in the middle, fading to nothing, so a harbour lamp looks like a lamp
// and a caption laid over it has a real bright patch to fight.
const glow = (px, w, h, cx, cy, radius, colour, strength = 1) => {
  const [r, g, b] = colour;
  for (let y = Math.max(0, Math.floor(cy - radius)); y < Math.min(h, Math.ceil(cy + radius)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x < Math.min(w, Math.ceil(cx + radius)); x++) {
      const d = Math.hypot(x - cx, y - cy) / radius;
      if (d >= 1) continue;
      const k = Math.pow(1 - d, 2.2) * strength, at = (y * w + x) * 3;
      px[at] = clamp(px[at] + r * k); px[at + 1] = clamp(px[at + 1] + g * k); px[at + 2] = clamp(px[at + 2] + b * k);
    }
  }
};

// A deterministic little generator: no Math.random, so the same picture is the same bytes and a
// re-render can be compared with the one a film was cut from.
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

function paint({ width = 1280, height = 720, sky, horizon, water, sun, night = false, seed = 7, boatX = 0.62, gullX = 0.43, gullY = 0.30, shore = true }) {
  const w = width, h = height, px = new Uint8Array(w * h * 3), rand = rng(seed);
  const horizonY = Math.round(h * horizon);
  // Sky: a vertical gradient, warmer near the horizon.
  for (let y = 0; y < horizonY; y++) {
    const t = y / Math.max(1, horizonY - 1);
    const c = mix(sky[0], sky[1], t);
    for (let x = 0; x < w; x++) { const at = (y * w + x) * 3; px[at] = clamp(c[0]); px[at + 1] = clamp(c[1]); px[at + 2] = clamp(c[2]); }
  }
  // Water: darker with depth, with a few horizontal bands and a reflected streak under the sun.
  for (let y = horizonY; y < h; y++) {
    const depth = (y - horizonY) / Math.max(1, h - horizonY);
    const base = mix(water[0], water[1], Math.pow(depth, 0.7));
    const band = Math.sin(y * 0.42 + seed) * 6;
    for (let x = 0; x < w; x++) {
      const streak = Math.exp(-Math.pow((x - sun.x) / (w * 0.10), 2)) * (1 - depth) * 34;
      const ripple = Math.sin(x * 0.03 + y * 0.11 + seed) * 5 * (1 - depth);
      const at = (y * w + x) * 3;
      px[at] = clamp(base[0] + band + streak + ripple);
      px[at + 1] = clamp(base[1] + band + streak + ripple);
      px[at + 2] = clamp(base[2] + band + streak + ripple);
    }
  }
  // The sun (or moon) and its halo.
  glow(px, w, h, sun.x, sun.y, night ? 70 : 120, night ? [190, 200, 235] : [255, 214, 140], night ? 0.9 : 1);
  glow(px, w, h, sun.x, sun.y, night ? 26 : 44, night ? [230, 236, 255] : [255, 246, 214], 1);
  // A headland on the left: a dark irregular mass against the sky. The evening picture has none, so
  // the two scenes differ in SHAPE across the whole upper band, not only in colour.
  if (shore) for (let x = 0; x < w * 0.32; x++) {
    const top = horizonY - Math.round(h * 0.10 * Math.pow(Math.cos((x / (w * 0.32)) * Math.PI / 2), 1.6) + rand() * 3);
    for (let y = Math.max(0, top); y < horizonY; y++) { const at = (y * w + x) * 3; px[at] = clamp(px[at] * 0.28); px[at + 1] = clamp(px[at + 1] * 0.30); px[at + 2] = clamp(px[at + 2] * 0.36); }
  }
  // Harbour lamps along the headland and the far shore: small glows, so there is detail high in the
  // frame as well as low.
  for (let i = 0; i < 14; i++) {
    const x = w * 0.03 + i * w * 0.022, y = horizonY - h * 0.015 - (i % 3) * 6;
    glow(px, w, h, x, y, night ? 9 : 6, night ? [255, 226, 150] : [255, 240, 200], night ? 1 : 0.55);
  }
  // THE BOAT: a dark hull, a mast, a boom, and a lantern at the masthead. Placed in the right third,
  // clear of where a caption band sits, so "is the subject visible" and "can the words be read" are
  // separate questions.
  const bx = Math.round(w * boatX), by = Math.round(horizonY + h * 0.055), bw = Math.round(w * 0.19), bh = Math.round(h * 0.045);
  for (let y = by; y < Math.min(h, by + bh); y++) {
    const t = (y - by) / bh, inset = Math.round(t * t * bw * 0.30);
    for (let x = bx + inset; x < Math.min(w, bx + bw - inset); x++) { const at = (y * w + x) * 3; px[at] = clamp(px[at] * 0.14); px[at + 1] = clamp(px[at + 1] * 0.15); px[at + 2] = clamp(px[at + 2] * 0.18); }
  }
  for (let y = by - Math.round(bh * 6.2); y < by; y++) {
    const x = bx + Math.round(bw * 0.46);
    for (let dx = 0; dx < 3; dx++) { const at = (y * w + x + dx) * 3; px[at] = 22; px[at + 1] = 24; px[at + 2] = 30; }
  }
  glow(px, w, h, bx + bw * 0.46, by - bh * 6.2, night ? 12 : 8, night ? [255, 232, 170] : [255, 250, 226], night ? 1 : 0.6);
  // A gull: two strokes of wing, above the water on the left of the boat.
  const gx = Math.round(w * gullX), gy = Math.round(h * gullY);
  for (let i = 0; i < 22; i++) {
    for (const [dx, dy] of [[i, -Math.round(Math.sin(i / 22 * Math.PI) * 9)], [i + 20, -Math.round(Math.sin((i + 20) / 22 * Math.PI) * 9)]]) {
      const at = ((gy + dy) * w + gx + dx) * 3;
      if (at >= 0 && at < px.length) { px[at] = 236; px[at + 1] = 238; px[at + 2] = 242; }
    }
  }
  return { width: w, height: h, pixels: px };
}

export function harbourPng(kind) {
  const looks = {
    // A cold early morning: pale sky, low sun just up, still water.
    dawn: { sky: [[92, 122, 162], [196, 186, 176]], water: [[46, 66, 92], [24, 36, 54]], sun: { x: 1280 * 0.30, y: 720 * 0.30 }, horizon: 0.52, night: false, seed: 11 },
    // Evening: deep sky, moon, lamps lit on the water, a darker boat.
    // Evening, composed differently on purpose: a lower horizon, the moon high on the RIGHT, and
    // the boat moved to the left with the lamps on the far bank. Two pictures separated only by hue
    // would make "which scene is which" easy for a pixel check and useless as a test of it.
    dusk: { sky: [[14, 18, 44], [148, 92, 66]], water: [[20, 22, 40], [8, 8, 18]], sun: { x: 1280 * 0.82, y: 720 * 0.13 }, horizon: 0.42, night: true, seed: 29, boatX: 0.18, gullX: 0.66, gullY: 0.46, shore: false },
    // A third picture, because a swap has to be told apart from what it replaced. This one is
    // composed to differ in the band a caption does NOT cover: the horizon is much lower, most of
    // the upper frame is empty night sky, there is no headland, and the boat and gull have moved to
    // the opposite ends from `dawn`. Two pictures that differ only in hue make "the film shows the
    // new one" a check of the encoder rather than of the product.
    nightferry: { sky: [[6, 8, 18], [30, 34, 60]], water: [[10, 12, 24], [4, 4, 10]], sun: { x: 1280 * 0.12, y: 720 * 0.09 }, horizon: 0.70, night: true, seed: 41, boatX: 0.80, gullX: 0.25, gullY: 0.40, shore: false },
  };
  const look = looks[kind];
  if (!look) throw new Error(`no such picture: ${kind}`);
  const { width, height, pixels } = paint(look);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(pixels.buffer, y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
