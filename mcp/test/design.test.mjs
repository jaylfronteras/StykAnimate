import test from 'node:test';
import assert from 'node:assert/strict';
import {workspace, connect, call} from './support.mjs';

test('figure design attaches parts that follow the arm', async () => {
  await workspace();
  const {client} = await connect();
  await call(client, 'project_new', {title: 'Design', canvas: 'landscape'});
  const made = await call(client, 'figure_design', {spec: {
    name: 'Guard', base: 'chibi', color: '#355c3a', headColor: '#f2c9a0', head: 'round',
    parts: ['hair-spikes', 'cape', 'sword'], x: 480, y: 360,
  }});
  assert.deepEqual(made.data.parts, ['head-round', 'hair-spikes', 'cape', 'sword']);
  const before = await call(client, 'figure_describe', {actor: 'Guard'});
  const sword = before.data.parts.find(part => part.id === 'sword');
  const link = sword.follow[0];
  await call(client, 'pose_set', {actor: 'Guard', pose: 'wave_a', tick: 0});
  const after = await call(client, 'figure_describe', {actor: 'Guard'});
  const parent = after.data.segments.find(segment => segment.id === link.parentId);
  const blade = after.data.segments.find(segment => segment.id === link.segmentId);
  const delta = (blade.angle_deg - parent.angle_deg) * Math.PI / 180;
  assert.ok(Math.abs(delta - link.offset) < 0.05, `sword offset ${delta} wanted ${link.offset}`);
  await call(client, 'figure_part_detach', {actor: 'Guard', part: 'sword'});
  const left = await call(client, 'figure_describe', {actor: 'Guard'});
  assert.equal(left.data.parts.some(part => part.id === 'sword'), false);
  const saved = await call(client, 'figure_library_save', {actor: 'Guard', name: 'guard'});
  assert.match(saved.data.path, /guard\.stkz$/);
  const loaded = await call(client, 'figure_library_load', {path: 'figures/guard.stkz', x: 200, y: 360});
  assert.equal(loaded.data.name, 'Guard');
});

test('layers have no opacity control', async () => {
  await workspace();
  const {client} = await connect();
  await call(client, 'project_new', {title: 'Layers'});
  const message = await client.callTool({name: 'layer_edit', arguments: {id: 'layer-1', opacity: 0.5}});
  assert.equal(message.isError, true);
  assert.match(message.content[0].text, /figure_style/);
});
