import test from 'node:test';
import assert from 'node:assert/strict';
import {workspace, connect, call} from './support.mjs';
import {compileScenario} from '../src/compile.js';
import {createEditor} from '../src/session.js';
import {buildGeometry} from '../src/core.js';

test('a walk keeps its feet on the ground and faces the way it travels', async () => {
  const compiled = await compileScenario({
    title: 'Walk', width: 640, height: 360, fps: 12, seconds: 1.5, background: '#f7f4ee',
    cast: [
      {id: 'floor', kind: 'line', x: 20, y: 280, length: 600, thickness: 3, color: '#b7b1a4'},
      {id: 'ada', color: '#1d9bf0', x: 80, ground: 280},
    ],
    beats: [{at: 0, actor: 'ada', motion: 'walk', duration: 1.2, to: {x: 80 - 200}}],
  });
  const editor = createEditor();
  editor.load(compiled.document, 'Walk');
  editor.seek(0);
  const figure = editor.report.figure_types.find(item => item.name === 'ada');
  const early = editor.evaluatedFrame.objects.find(object => object.figure_type_id === figure.figure_type_id);
  assert.equal(early.root_x, 80);
  let left = false;
  let lowestGap = Infinity;
  for (let tick = 0; tick < editor.totalTicks; tick += 2) {
    editor.seek(tick);
    const object = editor.evaluatedFrame.objects.find(item => item.figure_type_id === figure.figure_type_id);
    const geometry = buildGeometry(editor.report, editor.evaluatedFrame);
    const slot = editor.evaluatedFrame.objects.findIndex(item => item.unique_id === object.unique_id);
    const low = Math.max(...[...geometry.objects.get(slot).joints.values()].map(point => point.y));
    lowestGap = Math.min(lowestGap, 280 - low);
    if (object.root_x < 80) left = true;
  }
  assert.ok(left, 'the figure should travel left');
  assert.ok(lowestGap > -2 && lowestGap < 24, `feet drifted from the floor (${lowestGap})`);
  const torso = figure.segments[0];
  editor.seek(4);
  const posed = editor.evaluatedFrame.objects.find(item => item.figure_type_id === figure.figure_type_id);
  assert.ok(posed.angles[figure.segments.indexOf(torso)] > 0, 'facing left tips the torso past vertical');
});

test('scenario_build loads a project that tweens and reopens', async () => {
  await workspace();
  const {client} = await connect();
  await call(client, 'project_new', {title: 'Empty'});
  const built = await call(client, 'scenario_build', {spec: {
    title: 'Meet', canvas: 'landscape', fps: 12, seconds: 2, background: '#f4f1ea',
    cast: [
      {id: 'ada', color: '#1d9bf0', x: 120, ground: 430},
      {id: 'ben', color: '#e07a2f', x: 760, ground: 430, flip: true},
    ],
    beats: [
      {at: 0, actor: 'ada', motion: 'walk', duration: 1, to: {x: 300}, ease: 'ease-in-out'},
      {at: 0, actor: 'ben', motion: 'idle', duration: 1},
    ],
  }});
  assert.ok(built.data.snapshot);
  assert.ok(built.data.ticks > 12);
  const early = await call(client, 'pose_get', {actor: 'ada', tick: 0});
  const mid = await call(client, 'pose_get', {actor: 'ada', tick: 6});
  assert.ok(mid.data.root.x > early.data.root.x);
  const saved = await call(client, 'project_save', {path: 'meet.styk'});
  const opened = await call(client, 'project_open', {path: 'meet.styk'});
  assert.equal(opened.data.figures, 2);
  const again = await call(client, 'pose_get', {actor: 'ada', tick: 6});
  assert.equal(again.data.root.x, mid.data.root.x);
});
