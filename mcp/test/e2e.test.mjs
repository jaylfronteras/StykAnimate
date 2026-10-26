import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {workspace, connect, call} from './support.mjs';
import {decodeDocument, normalizeDecodedDocument} from '../src/core.js';
import {createEditor} from '../src/session.js';
import {softwareFrame} from '../src/render.js';

const SCENE = {
  title: 'Ada and Ben',
  canvas: 'landscape',
  fps: 24,
  seconds: 10,
  background: '#f4f1ea',
  cast: [
    {id: 'floor', kind: 'line', x: 40, y: 430, length: 880, thickness: 4, color: '#c8c2b4'},
    {id: 'ada', color: '#1d9bf0', x: 160, ground: 430},
    {id: 'ben', color: '#e07a2f', x: 760, ground: 430, flip: true},
  ],
  beats: [
    {at: 0, actor: 'ada', motion: 'idle', duration: 1.2},
    {at: 1.2, actor: 'ada', motion: 'walk', duration: 2.2, to: {x: 400}},
    {at: 3.5, actor: 'ada', motion: 'wave', duration: 1.2, say: 'Hey'},
    {at: 5, actor: 'ada', motion: 'punch', duration: 0.8},
    {at: 0.4, actor: 'ben', motion: 'idle', duration: 1},
    {at: 1.4, actor: 'ben', motion: 'walk', duration: 2, to: {x: 560}},
    {at: 3.6, actor: 'ben', motion: 'kick', duration: 0.8},
    {at: 4.8, actor: 'ben', motion: 'jump', duration: 1},
    {at: 6.4, actor: 'ada', motion: 'wave', duration: 1.4},
    {at: 6.4, actor: 'ben', motion: 'idle', duration: 1.6},
    {at: 6.2, camera: {x: 480, y: 320, zoom: 1.25}},
  ],
};

test('a ten second scene can be built, edited, designed, previewed, exported and reopened', {timeout: 180000}, async () => {
  const root = await workspace();
  const {client} = await connect();
  const built = await call(client, 'scenario_build', {spec: SCENE});
  assert.ok(built.data.seconds >= 10 && built.data.seconds < 11, `scene length ${built.data.seconds}`);
  const saved = await call(client, 'project_save', {path: 'ada-ben.styk'});

  await call(client, 'project_close');
  await call(client, 'project_open', {path: 'ada-ben.styk'});
  const before = await call(client, 'pose_get', {actor: 'ada', tick: 48});
  await call(client, 'figure_transform', {actor: 'ada', tick: 48, x: before.data.root.x + 36});
  await call(client, 'pose_set', {actor: 'ben', tick: 90, pose: 'point', ease: 'ease-out'});
  const keys = await call(client, 'keyframe_list', {actor: 'ada'});
  const movable = keys.data.tracks[0].keys.find(key => key.tick > 140);
  assert.ok(movable, 'expected a later key to retime');
  await call(client, 'keyframe_retime', {actor: 'ada', start: movable.tick, by: 4});
  const moved = await call(client, 'keyframe_list', {actor: 'ada'});
  assert.ok(moved.data.tracks[0].keys.some(key => key.tick === movable.tick + 4));

  const designed = await call(client, 'figure_design', {spec: {
    name: 'Guide', base: 'tall', color: '#243044', headColor: '#f2c9a0', head: 'oval',
    parts: ['hat-wizard', 'staff', 'scarf'], x: 700, y: 400,
  }});
  assert.ok(designed.data.parts.includes('staff'));
  const sheet = await call(client, 'figure_preview', {actor: 'Guide', poses: ['stand', 'walk_contact_a', 'wave_a']});
  assert.equal(sheet.images.length, 1);
  assert.equal(Buffer.from(sheet.images[0].data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  const preview = await call(client, 'preview_frames', {ticks: [0, 48, 96, 144, 200], columns: 5, width: 320, height: 180});
  assert.equal(preview.images.length, 1);
  assert.equal(preview.data.renderer, 'software');
  const contact = Buffer.from(preview.images[0].data, 'base64');
  assert.ok(contact.length > 1000);

  const exported = await call(client, 'export_video', {path: 'exports/ada-ben.mp4', preset: 'canvas', fps: 12});
  assert.ok(exported.data.frames > 100);
  const mp4 = await readFile(exported.data.path);
  assert.equal(mp4.subarray(4, 8).toString('ascii'), 'ftyp');

  await call(client, 'project_save', {path: 'ada-ben.styk', overwrite: true});
  const bytes = await readFile(path.join(root, 'ada-ben.styk'));
  const decoded = normalizeDecodedDocument((await decodeDocument(bytes, 'styk')).document, 'styk');
  const editor = createEditor();
  editor.load(decoded, 'Ada and Ben');
  const names = editor.report.figure_types.map(figure => figure.name);
  assert.ok(names.includes('ada') && names.includes('ben') && names.includes('Guide'));
  editor.seek(48);
  const ada = editor.evaluatedFrame.objects.find(object => editor.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id)?.name === 'ada');
  assert.ok(Math.abs(ada.root_x - (before.data.root.x + 36)) < 1);

  const frame = softwareFrame(editor, 48, {width: 960, height: 540});
  let colored = 0;
  for (let i = 0; i < frame.pixels.length; i += 16) {
    const distance = Math.abs(frame.pixels[i] - 244) + Math.abs(frame.pixels[i + 1] - 241) + Math.abs(frame.pixels[i + 2] - 234);
    if (distance > 40) colored++;
  }
  assert.ok(colored > 50, 'preview frame is blank');

  const artifacts = '/opt/cursor/artifacts/stykanimate-mcp';
  await mkdir(artifacts, {recursive: true});
  await writeFile(path.join(artifacts, 'scene-contact.png'), contact);
  await writeFile(path.join(artifacts, 'figure-preview.png'), Buffer.from(sheet.images[0].data, 'base64'));
  await writeFile(path.join(artifacts, 'frame-walk.png'), frame.png);
  await writeFile(path.join(artifacts, 'ada-ben.mp4'), mp4);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', exported.data.path], {encoding: 'utf8'});
  if (probe.status === 0) assert.ok(Number(probe.stdout) > 8);
});
