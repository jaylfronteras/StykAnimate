import test from 'node:test';
import assert from 'node:assert/strict';
import {workspace, connect, call, fail} from './support.mjs';

test('the server advertises the editing, design and export tools', async () => {
  await workspace();
  const {client} = await connect();
  const listed = await client.listTools();
  const names = new Set(listed.tools.map(tool => tool.name));
  for (const name of ['project_new', 'project_open', 'scenario_build', 'scenario_guide', 'motion_apply', 'figure_design', 'parts_list', 'preview_frames', 'export_video', 'pose_ik_set', 'history_undo', 'snapshot_restore']) {
    assert.ok(names.has(name), name);
  }
  assert.ok(listed.tools.length >= 60);
  const pose = listed.tools.find(tool => tool.name === 'pose_set');
  assert.match(pose.description, /absolute degrees/);
  const guide = await call(client, 'scenario_guide');
  assert.match(guide.data.guide, /ease-in-out/);
  assert.ok(guide.data.parts.length >= 15);
});

test('a rejected pose does not move the revision', async () => {
  await workspace();
  const {client} = await connect();
  const created = await call(client, 'project_new', {title: 'Rollback', canvas: 'square'});
  const message = await fail(client, 'pose_set', {actor: 'Blue', pose: 'not-a-pose'});
  assert.match(message, /Unknown pose/);
  const info = await call(client, 'project_info');
  assert.equal(info.data.revision, created.data.revision);
  const stale = await fail(client, 'pose_set', {actor: 'Blue', pose: 'stand', expect_revision: created.data.revision + 50});
  assert.match(stale, /revision/);
});

test('paths outside the workspace are refused', async () => {
  await workspace();
  const {client} = await connect();
  const message = await fail(client, 'project_open', {path: '../package.json'});
  assert.match(message, /STYK_WORKSPACE/);
});
