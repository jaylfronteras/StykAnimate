/**
 * Version 1 prop and head library. Segments are parent-relative: local_deg is
 * added to the anchor's absolute angle, which is what makes a sword stay in
 * the hand when the arm moves. Lengths are pixels at figure scale 1.
 *
 * "Left forearm" is the character's left hand. On the startup figure that hand
 * is on the right of the screen while the figure faces right.
 */

const skin = '#f2c9a0';
const ink = '#2b2b2b';
const wood = '#8a5a32';
const steel = '#c5ccd6';
const cloth = '#3d4f7c';
const red = '#c4382f';

function spoke(index, local, length) {
  return {parent: 0, local_deg: local, length, thickness: 0, kind: 'line'};
}

function ring(rx, ry, count = 8) {
  // The link to the head center points up (-90°). Spoke local_deg is added to
  // that, so local 90° points screen-right and local 180° points down.
  const segments = [{local_deg: 0, length: 22, thickness: 0, kind: 'line'}];
  for (let i = 0; i < count; i++) {
    const screen = (i / count) * 360;
    const theta = screen * Math.PI / 180;
    const length = Math.hypot(rx * Math.cos(theta), ry * Math.sin(theta));
    segments.push(spoke(i, screen + 90, Math.max(4, length)));
  }
  return {segments, polygons: [{points: Array.from({length: count}, (_, i) => i + 1), color: skin}]};
}

const oval = ring(20, 26);
const square = {
  segments: [
    {local_deg: 0, length: 22, thickness: 0, kind: 'line'},
    spoke(0, 135, 20), spoke(0, 225, 20), spoke(0, 315, 20), spoke(0, 405, 20),
  ],
  polygons: [{points: [1, 2, 3, 4], color: skin}],
};

export const PARTS = [
  {
    id: 'head-round', name: 'Round head', category: 'head', anchor: 'Torso',
    segments: [{local_deg: 0, length: 52, thickness: 0, kind: 'circleFill', color: skin}],
  },
  {
    id: 'head-oval', name: 'Oval head', category: 'head', anchor: 'Torso',
    segments: oval.segments, polygons: oval.polygons,
  },
  {
    id: 'head-square', name: 'Square head', category: 'head', anchor: 'Torso',
    segments: square.segments, polygons: square.polygons,
  },
  {
    id: 'hair-spikes', name: 'Spiky hair', category: 'hair', anchor: 'Head', color: ink,
    segments: [-42, -22, 0, 22, 42].map((local, i) => ({local_deg: local, length: 18 + (i % 2) * 8, thickness: 4, kind: 'line', color: ink})),
  },
  {
    id: 'hair-ponytail', name: 'Ponytail', category: 'hair', anchor: 'Head', color: ink,
    segments: [
      {local_deg: 150, length: 16, thickness: 5, kind: 'line', color: ink},
      {parent: 0, local_deg: 28, length: 34, thickness: 4, kind: 'line', color: ink},
    ],
  },
  {
    id: 'hair-bun', name: 'Bun', category: 'hair', anchor: 'Head',
    segments: [{local_deg: -20, length: 18, thickness: 0, kind: 'circleFill', color: ink}],
  },
  {
    id: 'hat-cap', name: 'Cap', category: 'hat', anchor: 'Head',
    segments: [
      {local_deg: -8, length: 20, thickness: 0, kind: 'circleFill', color: '#2f5d9f'},
      {local_deg: 78, length: 30, thickness: 4, kind: 'line', color: '#2f5d9f'},
    ],
  },
  {
    id: 'hat-wizard', name: 'Wizard hat', category: 'hat', anchor: 'Head',
    segments: [
      {local_deg: -16, length: 58, thickness: 4, kind: 'line', color: '#3c2f73'},
      {local_deg: 16, length: 58, thickness: 4, kind: 'line', color: '#3c2f73'},
      {local_deg: 90, length: 36, thickness: 3, kind: 'line', color: '#3c2f73'},
    ],
    polygons: [{points: [0, 1, 'anchor'], color: '#3c2f73'}],
  },
  {
    id: 'hat-top', name: 'Top hat', category: 'hat', anchor: 'Head',
    segments: [
      {local_deg: 0, length: 28, thickness: 14, kind: 'line', color: ink},
      {local_deg: 86, length: 34, thickness: 3, kind: 'line', color: ink},
    ],
  },
  {
    id: 'sword', name: 'Sword', category: 'prop', anchor: 'Left forearm',
    segments: [
      {local_deg: -78, length: 76, thickness: 3, kind: 'line', color: steel},
      {parent: 0, local_deg: 90, length: 16, thickness: 4, kind: 'line', color: wood},
      {parent: 0, local_deg: -90, length: 16, thickness: 4, kind: 'line', color: wood},
    ],
  },
  {
    id: 'staff', name: 'Staff', category: 'prop', anchor: 'Right forearm',
    segments: [{local_deg: -70, length: 150, thickness: 5, kind: 'line', color: wood}],
  },
  {
    id: 'shield', name: 'Shield', category: 'prop', anchor: 'Right forearm',
    segments: [{local_deg: 36, length: 40, thickness: 0, kind: 'circleFill', color: '#7d8ea3'}],
  },
  {
    id: 'cape', name: 'Cape', category: 'cloth', anchor: 'Torso',
    segments: [
      {local_deg: 158, length: 86, thickness: 5, kind: 'line', color: cloth},
      {local_deg: 202, length: 86, thickness: 5, kind: 'line', color: cloth},
    ],
    polygons: [{points: ['anchor', 0, 1], color: cloth, opacity: 0.92}],
  },
  {
    id: 'scarf', name: 'Scarf', category: 'cloth', anchor: 'Torso',
    segments: [
      {local_deg: 42, length: 30, thickness: 6, kind: 'line', color: red},
      {parent: 0, local_deg: 24, length: 26, thickness: 5, kind: 'line', color: red},
    ],
  },
  {
    id: 'belt', name: 'Belt', category: 'cloth', anchor: 'Torso',
    segments: [
      {local_deg: 180, length: 62, thickness: 0, kind: 'line'},
      {parent: 0, local_deg: 90, length: 20, thickness: 7, kind: 'line', color: '#6b4423'},
      {parent: 0, local_deg: -90, length: 20, thickness: 7, kind: 'line', color: '#6b4423'},
    ],
  },
];

export function partById(id) {
  const part = PARTS.find(item => item.id === id);
  return part ?? null;
}

export function listParts() {
  return PARTS.map(({id, name, category, anchor}) => ({id, name, category, anchor}));
}
