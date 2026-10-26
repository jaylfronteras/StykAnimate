import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deflateSync, crc32} from 'node:zlib';
import {buildGeometry, frameWithCameraTime, cameraMatrix} from './core.js';
import {ToolError, explain} from './errors.js';

const PRESETS = Object.freeze({
  youtube: {width: 1920, height: 1080, fps: null},
  shorts: {width: 1080, height: 1920, fps: null},
  tiktok: {width: 1080, height: 1920, fps: null},
  gif: {width: 480, height: null, fps: 12},
  canvas: {width: null, height: null, fps: null},
});

export function presetSize(name, canvas) {
  const preset = PRESETS[name ?? 'canvas'];
  if (!preset) throw new ToolError(`Unknown preset "${name}". Choose ${Object.keys(PRESETS).join(', ')}.`);
  const width = preset.width ?? canvas.width;
  const height = preset.height ?? (preset.width ? Math.max(2, Math.round(preset.width * canvas.height / canvas.width)) : canvas.height);
  return {width: even(width), height: even(height), fps: preset.fps};
}

const even = value => Math.max(2, value - (value % 2));

export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), at + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, {level: 1})), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

export async function renderFrame(editor, tick, options = {}) {
  const mode = process.env.STYK_RENDER === 'software' ? 'software' : 'browser';
  if (mode === 'browser') {
    try { return {...await browserFrame(editor, tick, options), renderer: 'browser'}; }
    catch (error) {
      if (process.env.STYK_RENDER === 'browser') throw new ToolError(`Headless Chrome could not render. ${explain(error)}`, {code: 'render'});
    }
  }
  return {...softwareFrame(editor, tick, options), renderer: 'software'};
}

export function softwareFrame(editor, tick, {width, height} = {}) {
  const report = editor.report;
  const canvasW = report.canvas_width;
  const canvasH = report.canvas_height;
  const outW = width ?? canvasW;
  const outH = height ?? canvasH;
  const fit = Math.min(outW / canvasW, outH / canvasH);
  const previous = editor.tick;
  editor.seek(Math.max(0, Math.min(Math.round(tick), Math.max(0, editor.totalTicks - 1))));
  try {
    const frame = frameWithCameraTime(report, editor.evaluatedFrame, editor.tick);
    const geometry = buildGeometry(report, frame);
    const matrix = cameraMatrix({report, frame, view: {scale: fit, x: (outW - canvasW * fit) / 2, y: (outH - canvasH * fit) / 2}});
    const pixels = new Uint8Array(outW * outH * 4);
    const [r, g, b, a] = backgroundOf(report, frame);
    fill(pixels, r, g, b, a);
    const map = point => ({
      x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
      y: matrix[1] * point.x + matrix[3] * point.y + matrix[5],
    });
    const scale = Math.hypot(matrix[0], matrix[1]) || 1;
    for (const drawable of geometry.drawables ?? []) paint(pixels, outW, outH, drawable, map, scale);
    return {png: encodePng(outW, outH, pixels), width: outW, height: outH, tick: editor.tick, pixels};
  } finally {
    if (editor.tick !== previous) editor.seek(previous);
  }
}

function backgroundOf(report, frame) {
  const found = report.backgrounds?.find(item => item.background_id === frame.background_id);
  if (!found || found.kind !== 2) return [244, 241, 234, 255];
  const color = Number(found.color) >>> 0;
  return [(color >>> 16) & 255, (color >>> 8) & 255, color & 255, ((color >>> 24) & 255) || 255];
}

function fill(pixels, r, g, b, a) {
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
  }
}

function paint(pixels, width, height, drawable, map, scale = 1) {
  if (drawable.alpha <= 0 || drawable.seg?.visible === false) return;
  const color = {
    r: drawable.rgb?.[0] ?? 0,
    g: drawable.rgb?.[1] ?? 0,
    b: drawable.rgb?.[2] ?? 0,
    a: Math.max(0, Math.min(1, (drawable.alpha ?? 1) * (drawable.opacity ?? 1))),
  };
  if (drawable.type === 'poly' && drawable.points?.length >= 3) {
    fillPolygon(pixels, width, height, drawable.points.map(map), color);
    return;
  }
  if (drawable.type === 'circle') {
    const start = map(drawable.start), end = map(drawable.end);
    const filled = drawable.seg?.segment_kind === 'circleFill' || (drawable.thickness ?? 0) >= Math.abs(drawable.length ?? 0);
    const radius = (Math.hypot(end.x - start.x, end.y - start.y) + (filled ? (drawable.thickness ?? 0) * scale : 0)) / 2;
    const center = {x: (start.x + end.x) / 2, y: (start.y + end.y) / 2};
    if (filled) fillCircle(pixels, width, height, center, radius, color);
    else strokeCircle(pixels, width, height, center, Math.max(0.5, radius), Math.max(1, (drawable.thickness || 2) * scale), color);
    return;
  }
  if (drawable.type === 'text') {
    paintText(pixels, width, height, drawable, map, color);
    return;
  }
  const points = (drawable.points?.length ? drawable.points : [drawable.start, drawable.end]).filter(Boolean).map(map);
  const radius = Math.max(0.6, ((drawable.thickness || 0) / 2) * scale);
  if (radius <= 0 || points.length < 2) return;
  for (let i = 1; i < points.length; i++) stroke(pixels, width, height, points[i - 1], points[i], radius, color);
}

function blend(pixels, index, color, coverage) {
  const alpha = color.a * coverage;
  if (alpha <= 0) return;
  const dest = pixels[index + 3] / 255;
  const out = alpha + dest * (1 - alpha);
  if (out <= 0) return;
  pixels[index] = (color.r * alpha + pixels[index] * dest * (1 - alpha)) / out;
  pixels[index + 1] = (color.g * alpha + pixels[index + 1] * dest * (1 - alpha)) / out;
  pixels[index + 2] = (color.b * alpha + pixels[index + 2] * dest * (1 - alpha)) / out;
  pixels[index + 3] = Math.max(0, Math.min(255, out * 255));
}

function stamp(pixels, width, height, x, y, color) {
  const ix = Math.floor(x), iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= width || iy >= height) return;
  blend(pixels, (iy * width + ix) * 4, color, 1);
}

function stroke(pixels, width, height, a, b, radius, color) {
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + radius));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + radius));
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      let t = len2 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const distance = Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
      const coverage = radius + 0.6 - distance;
      if (coverage > 0) blend(pixels, (y * width + x) * 4, color, Math.min(1, coverage));
    }
  }
}

function fillCircle(pixels, width, height, center, radius, color) {
  const minX = Math.max(0, Math.floor(center.x - radius - 1));
  const maxX = Math.min(width - 1, Math.ceil(center.x + radius + 1));
  const minY = Math.max(0, Math.floor(center.y - radius - 1));
  const maxY = Math.min(height - 1, Math.ceil(center.y + radius + 1));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const distance = Math.hypot(x + 0.5 - center.x, y + 0.5 - center.y);
      const coverage = radius + 0.6 - distance;
      if (coverage > 0) blend(pixels, (y * width + x) * 4, color, Math.min(1, coverage));
    }
  }
}

function strokeCircle(pixels, width, height, center, radius, thickness, color) {
  fillCircle(pixels, width, height, center, radius + thickness / 2, color);
  fillCircle(pixels, width, height, center, Math.max(0, radius - thickness / 2), {r: 255, g: 255, b: 255, a: color.a});
}

function fillPolygon(pixels, width, height, points, color) {
  let minY = Infinity, maxY = -Infinity;
  for (const point of points) { minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y); }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(height - 1, Math.ceil(maxY));
  for (let y = minY; y <= maxY; y++) {
    const scan = y + 0.5;
    const hits = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if ((a.y <= scan && b.y > scan) || (b.y <= scan && a.y > scan)) {
        const t = (scan - a.y) / (b.y - a.y);
        hits.push(a.x + (b.x - a.x) * t);
      }
    }
    hits.sort((p, q) => p - q);
    for (let i = 0; i + 1 < hits.length; i += 2) {
      const from = Math.max(0, Math.ceil(hits[i]));
      const to = Math.min(width - 1, Math.floor(hits[i + 1]));
      for (let x = from; x <= to; x++) stamp(pixels, width, height, x, y, color);
    }
  }
}

function paintText(pixels, width, height, drawable, map, color) {
  const asset = drawable.asset;
  if (!asset?.glyphs?.length || !asset.bounds?.width) return;
  const placed = glyphPoint(drawable);
  for (const placement of asset.placements ?? []) {
    if (!placement.visible) continue;
    const glyph = asset.glyphs[placement.glyph_index];
    const outline = flatten(glyph?.commands);
    if (outline.length < 3) continue;
    const dx = placement.x - asset.bounds.left;
    const dy = placement.y - asset.bounds.bottom;
    fillPolygon(pixels, width, height, outline.map(point => map(placed(point.x + dx, point.y + dy))), color);
  }
}

function glyphPoint(drawable) {
  const reverse = Boolean(drawable.seg?.extra_u8_a ?? drawable.seg?.extra?.[1]);
  const mirror = Boolean(drawable.seg?.extra_u8_b ?? drawable.seg?.extra?.[2]) !== Boolean(drawable.obj?.image_text_flags);
  const start = reverse ? drawable.end : drawable.start;
  const angle = drawable.angle + (reverse ? Math.PI : 0) - (mirror ? Math.PI : 0);
  const scaleX = (mirror ? -1 : 1) * Math.hypot(drawable.end.x - drawable.start.x, drawable.end.y - drawable.start.y) / drawable.asset.bounds.width;
  const scaleY = Number(drawable.obj?.scale ?? 1);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return (x, y) => {
    const sx = scaleX * x, sy = scaleY * y;
    return {x: start.x + sx * cos - sy * sin, y: start.y + sx * sin + sy * cos};
  };
}

function flatten(commands = []) {
  const points = [];
  for (const command of commands) {
    const values = command.values ?? [];
    if (command.op === 'M' || command.op === 'L') points.push({x: values[0], y: values[1]});
    else if (command.op === 'C' && points.length) {
      const from = points.at(-1);
      for (let step = 1; step <= 6; step++) points.push(cubic(from, values, step / 6));
    }
  }
  return points;
}

function cubic(from, values, t) {
  const [x1, y1, x2, y2, x, y] = values;
  const u = 1 - t;
  return {
    x: u ** 3 * from.x + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x,
    y: u ** 3 * from.y + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y,
  };
}

export function contactSheet(frames, {columns = 3, label = true} = {}) {
  const tileW = frames[0].width, tileH = frames[0].height;
  const cols = Math.max(1, Math.min(columns, frames.length));
  const rows = Math.ceil(frames.length / cols);
  const width = cols * tileW, height = rows * tileH;
  const pixels = new Uint8Array(width * height * 4);
  fill(pixels, 28, 32, 38, 255);
  frames.forEach((frame, index) => {
    const column = index % cols, row = Math.floor(index / cols);
    blit(pixels, width, frame.pixels, frame.width, frame.height, column * tileW, row * tileH);
    if (label) caption(pixels, width, height, column * tileW + 8, row * tileH + 16, `${frame.tick}`);
  });
  return {png: encodePng(width, height, pixels), width, height, pixels};
}

function blit(dest, destW, src, srcW, srcH, ox, oy) {
  for (let y = 0; y < srcH; y++) {
    const from = y * srcW * 4;
    dest.set(src.subarray(from, from + srcW * 4), ((oy + y) * destW + ox) * 4);
  }
}

function caption(pixels, width, height, x, y, text) {
  const glyph = {
    0: ['01110', '10001', '10001', '10001', '01110'],
    1: ['00100', '01100', '00100', '00100', '01110'],
    2: ['01110', '10001', '00110', '01000', '11111'],
    3: ['11110', '00001', '01110', '00001', '11110'],
    4: ['10010', '10010', '11111', '00010', '00010'],
    5: ['11111', '10000', '11110', '00001', '11110'],
    6: ['01110', '10000', '11110', '10001', '01110'],
    7: ['11111', '00010', '00100', '01000', '01000'],
    8: ['01110', '10001', '01110', '10001', '01110'],
    9: ['01110', '10001', '01111', '00001', '01110'],
  };
  let cursor = x;
  for (const char of text) {
    const rows = glyph[char];
    if (!rows) continue;
    rows.forEach((row, py) => [...row].forEach((bit, px) => {
      if (bit === '1') stamp(pixels, width, height, cursor + px, y + py, {r: 255, g: 255, b: 255, a: 1});
    }));
    cursor += 6;
  }
}

export async function renderSheet(editor, ticks, {columns = 3, width, height} = {}) {
  const frames = [];
  let renderer = 'software';
  for (const tick of ticks) {
    const frame = await renderFrame(editor, tick, {width, height});
    renderer = frame.renderer;
    frames.push(frame);
  }
  const sheet = contactSheet(frames, {columns});
  return {...sheet, renderer, frames: frames.map(frame => ({tick: frame.tick, png: frame.png, width: frame.width, height: frame.height}))};
}

let browserPromise = null;
async function browserFrame(editor, tick, options) {
  const model = frameModel(editor, tick, options);
  const page = await browserPage();
  const painted = await page.evaluate(paintInPage, model);
  const pixels = Buffer.from(painted.rgba, 'base64');
  return {png: Buffer.from(painted.png, 'base64'), width: model.width, height: model.height, tick: model.tick, pixels};
}

function frameModel(editor, tick, {width, height} = {}) {
  const report = editor.report;
  const canvasW = report.canvas_width;
  const canvasH = report.canvas_height;
  const outW = width ?? canvasW;
  const outH = height ?? canvasH;
  const fit = Math.min(outW / canvasW, outH / canvasH);
  const previous = editor.tick;
  editor.seek(Math.max(0, Math.min(Math.round(tick), Math.max(0, editor.totalTicks - 1))));
  try {
    const frame = frameWithCameraTime(report, editor.evaluatedFrame, editor.tick);
    const geometry = buildGeometry(report, frame);
    const matrix = cameraMatrix({report, frame, view: {scale: fit, x: (outW - canvasW * fit) / 2, y: (outH - canvasH * fit) / 2}});
    const map = point => ({
      x: round2(matrix[0] * point.x + matrix[2] * point.y + matrix[4]),
      y: round2(matrix[1] * point.x + matrix[3] * point.y + matrix[5]),
    });
    const scale = Math.hypot(matrix[0], matrix[1]) || 1;
    const items = [];
    for (const drawable of geometry.drawables ?? []) collectItem(items, drawable, map, scale);
    return {width: outW, height: outH, tick: editor.tick, background: backgroundOf(report, frame), items};
  } finally {
    if (editor.tick !== previous) editor.seek(previous);
  }
}

function collectItem(items, drawable, map, scale) {
  if (drawable.alpha <= 0 || drawable.seg?.visible === false) return;
  const color = [
    drawable.rgb?.[0] ?? 0,
    drawable.rgb?.[1] ?? 0,
    drawable.rgb?.[2] ?? 0,
    Math.max(0, Math.min(1, (drawable.alpha ?? 1) * (drawable.opacity ?? 1))),
  ];
  if (drawable.type === 'poly' && drawable.points?.length >= 3) {
    items.push({op: 'poly', points: drawable.points.map(map), color});
    return;
  }
  if (drawable.type === 'circle') {
    const start = map(drawable.start), end = map(drawable.end);
    const filled = drawable.seg?.segment_kind === 'circleFill' || (drawable.thickness ?? 0) >= Math.abs(drawable.length ?? 0);
    const radius = (Math.hypot(end.x - start.x, end.y - start.y) + (filled ? (drawable.thickness ?? 0) * scale : 0)) / 2;
    items.push({op: 'circle', x: round2((start.x + end.x) / 2), y: round2((start.y + end.y) / 2), radius: round2(radius), fill: filled, width: round2(Math.max(1, (drawable.thickness || 2) * scale)), color});
    return;
  }
  if (drawable.type === 'text') {
    collectText(items, drawable, map, color);
    return;
  }
  const points = (drawable.points?.length ? drawable.points : [drawable.start, drawable.end]).filter(Boolean).map(map);
  if (points.length < 2) return;
  items.push({op: 'line', points, width: round2(Math.max(1.2, (drawable.thickness || 0) * scale)), color});
}

function collectText(items, drawable, map, color) {
  const asset = drawable.asset;
  if (!asset?.glyphs?.length || !asset.bounds?.width) return;
  const placed = glyphPoint(drawable);
  for (const placement of asset.placements ?? []) {
    if (!placement.visible) continue;
    const glyph = asset.glyphs[placement.glyph_index];
    const outline = flatten(glyph?.commands);
    if (outline.length < 3) continue;
    const dx = placement.x - asset.bounds.left;
    const dy = placement.y - asset.bounds.bottom;
    items.push({op: 'poly', points: outline.map(point => map(placed(point.x + dx, point.y + dy))), color});
  }
}

const round2 = value => Math.round(value * 100) / 100;

function paintInPage(model) {
  const canvas = document.getElementById('c');
  canvas.width = model.width;
  canvas.height = model.height;
  const ctx = canvas.getContext('2d');
  const [r, g, b, a] = model.background;
  ctx.fillStyle = `rgba(${r},${g},${b},${(a || 255) / 255})`;
  ctx.fillRect(0, 0, model.width, model.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const css = color => `rgba(${color[0]},${color[1]},${color[2]},${color[3]})`;
  for (const item of model.items) {
    ctx.beginPath();
    if (item.op === 'poly' && item.points.length >= 3) {
      ctx.moveTo(item.points[0].x, item.points[0].y);
      for (let i = 1; i < item.points.length; i++) ctx.lineTo(item.points[i].x, item.points[i].y);
      ctx.closePath();
      ctx.fillStyle = css(item.color);
      ctx.fill('evenodd');
    } else if (item.op === 'circle') {
      ctx.arc(item.x, item.y, Math.max(0.5, item.radius), 0, Math.PI * 2);
      if (item.fill) { ctx.fillStyle = css(item.color); ctx.fill(); }
      else { ctx.strokeStyle = css(item.color); ctx.lineWidth = item.width; ctx.stroke(); }
    } else if (item.points?.length >= 2) {
      ctx.moveTo(item.points[0].x, item.points[0].y);
      for (let i = 1; i < item.points.length; i++) ctx.lineTo(item.points[i].x, item.points[i].y);
      ctx.strokeStyle = css(item.color);
      ctx.lineWidth = item.width;
      ctx.stroke();
    }
  }
  const data = ctx.getImageData(0, 0, model.width, model.height);
  const bytes = data.data;
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + chunk)));
  return {png: canvas.toDataURL('image/png').split(',')[1], rgba: btoa(binary)};
}

async function browserPage() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const {chromium} = await import('playwright');
      const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
      const page = await browser.newPage();
      await page.setContent('<!doctype html><canvas id="c"></canvas>');
      return page;
    })();
  }
  return browserPromise;
}

export async function closeRenderer() {
  if (!browserPromise) return;
  const page = await browserPromise.catch(() => null);
  browserPromise = null;
  await page?.context()?.browser()?.close().catch(() => {});
}

export async function encodeSequence(frames, destination, {fps = 24, format = 'mp4'} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'styk-frames-'));
  try {
    for (let i = 0; i < frames.length; i++) await writeFile(path.join(dir, `frame-${String(i).padStart(4, '0')}.png`), frames[i]);
    if (format === 'gif') {
      const palette = path.join(dir, 'palette.png');
      await ffmpeg(['-y', '-framerate', String(fps), '-i', path.join(dir, 'frame-%04d.png'), '-vf', `fps=${fps},palettegen`, palette]);
      await ffmpeg(['-y', '-framerate', String(fps), '-i', path.join(dir, 'frame-%04d.png'), '-i', palette, '-lavfi', `fps=${fps}[x];[x][1:v]paletteuse`, destination]);
    } else {
      await ffmpeg(['-y', '-framerate', String(fps), '-i', path.join(dir, 'frame-%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', destination]);
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, {stdio: ['ignore', 'ignore', 'pipe']});
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => reject(new ToolError(`ffmpeg is not available. ${explain(error)}`, {code: 'ffmpeg_missing'})));
    child.on('close', code => code === 0 ? resolve() : reject(new ToolError(`ffmpeg failed. ${stderr.slice(-500)}`, {code: 'ffmpeg'})));
  });
}

export {PRESETS};
