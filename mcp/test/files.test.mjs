import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {workspace, connect, call, fail} from './support.mjs';

test('save refuses to overwrite and keeps a backup when asked', async () => {
  const root = await workspace();
  const {client} = await connect();
  await call(client, 'project_new', {title: 'Save me'});
  await call(client, 'project_save', {path: 'scene.styk'});
  const refused = await fail(client, 'project_save', {path: 'scene.styk'});
  assert.match(refused, /overwrite/);
  await call(client, 'pose_set', {actor: 'Blue', pose: 'point'});
  await call(client, 'project_save', {path: 'scene.styk', overwrite: true});
  await access(`${root}/scene.styk.bak`);
});

test('a Pivot file round-trips when Python is available', async () => {
  await workspace();
  const {client} = await connect();
  await call(client, 'scenario_build', {spec: {
    title: 'Pivot', width: 320, height: 180, fps: 12, seconds: 1,
    cast: [{id: 'ada', color: '#1d9bf0', x: 40, ground: 140}],
    beats: [{at: 0, actor: 'ada', motion: 'wave', duration: 0.6}],
  }});
  try {
    await call(client, 'project_save', {path: 'wave.piv', overwrite: true});
  } catch (error) {
    if (/Python|codec/i.test(error.message)) return;
    throw error;
  }
  const opened = await call(client, 'project_open', {path: 'wave.piv'});
  assert.ok(opened.data.figures >= 1);
  const pose = await call(client, 'pose_get', {actor: 'ada', tick: 0});
  assert.equal(pose.data.name, 'ada');
});

test('a short wav can be added and removed', async () => {
  const root = await workspace();
  const {client} = await connect();
  await call(client, 'project_new', {title: 'Sound'});
  const {writeFile} = await import('node:fs/promises');
  const rate = 8000;
  const frames = 800;
  const data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + frames * 2, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(frames * 2, 40);
  await writeFile(`${root}/beep.wav`, data);
  const added = await call(client, 'audio_add', {path: 'beep.wav', start: 0.2});
  assert.ok(added.data.clip);
  const listed = await call(client, 'audio_list');
  assert.equal(listed.data.tracks[0].clips.length, 1);
  await call(client, 'audio_remove', {clip: added.data.clip});
  const empty = await call(client, 'audio_list');
  assert.equal(empty.data.tracks[0].clips.length, 0);
});
