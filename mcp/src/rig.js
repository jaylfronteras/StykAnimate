/**
 * Stickman poses and joint names.
 *
 * The angle table and the screen-relative joint names are adapted, with credit,
 * from the pose library in upstream pull request #21 by mashhoorahdal
 * (filippocalippo/StykAnimate-App). Poses face screen-right. Angles are absolute
 * screen directions in degrees: 0 right, 90 down, -90 up, 180 left.
 *
 * Blue (the app's startup figure) uses the same segment order. Its segment
 * names are the character's own left and right, so the arm on the right of the
 * screen is "Left upper arm".
 */

export const JOINTS = Object.freeze([
  'torso', 'head',
  'rightUpperArm', 'rightForearm', 'leftUpperArm', 'leftForearm',
  'rightThigh', 'rightShin', 'leftThigh', 'leftShin',
]);

const UPPER = new Set(['torso', 'head', 'rightUpperArm', 'rightForearm', 'leftUpperArm', 'leftForearm']);

const pose = (torso, head, rua, rfa, lua, lfa, rth, rsh, lth, lsh) => Object.freeze({
  torso, head, rightUpperArm: rua, rightForearm: rfa, leftUpperArm: lua, leftForearm: lfa,
  rightThigh: rth, rightShin: rsh, leftThigh: lth, leftShin: lsh,
});

export const POSES = Object.freeze({
  rest: pose(-90, -90, 60, 76, 116, 95, 64, 87, 115, 96),
  stand: pose(-90, -90, 78, 86, 102, 94, 84, 90, 96, 90),
  hands_on_hips: pose(-90, -90, 40, 140, 140, 40, 80, 90, 100, 90),
  arms_crossed: pose(-90, -90, 120, -10, 60, 190, 84, 90, 96, 90),
  wave_a: pose(-90, -90, -25, -95, 102, 94, 84, 90, 96, 90),
  wave_b: pose(-90, -90, -25, -45, 102, 94, 84, 90, 96, 90),
  point: pose(-88, -88, 0, -5, 105, 95, 80, 90, 100, 90),
  arms_up: pose(-90, -90, -50, -65, 230, 245, 72, 82, 108, 98),
  shrug: pose(-90, -84, 35, -40, 145, 220, 84, 90, 96, 90),
  think: pose(-90, -82, 115, -75, 135, 45, 84, 90, 96, 90),
  facepalm: pose(-95, -110, 130, -105, 105, 95, 84, 90, 96, 90),
  sad: pose(-96, -55, 88, 90, 94, 92, 86, 90, 94, 90),
  surprised: pose(-92, -92, 20, -60, 160, 240, 75, 88, 105, 92),
  walk_contact_a: pose(-86, -88, 118, 108, 58, 40, 58, 74, 122, 108),
  walk_pass_a: pose(-87, -86, 98, 88, 82, 64, 74, 122, 92, 96),
  walk_contact_b: pose(-86, -88, 58, 40, 118, 108, 122, 108, 58, 74),
  walk_pass_b: pose(-87, -86, 82, 64, 98, 88, 92, 96, 74, 122),
  run_a: pose(-72, -74, 155, 95, 18, -58, 22, 78, 138, 178),
  run_b: pose(-74, -76, 22, -55, 152, 98, 140, 176, 20, 82),
  crouch: pose(-80, -80, 65, 25, 115, 155, 25, 110, 155, 70),
  jump: pose(-90, -92, -58, -78, 238, 255, 52, 118, 128, 62),
  sit: pose(-95, -90, 75, 15, 105, 20, 0, 90, 10, 95),
  punch: pose(-84, -84, -2, -4, 125, -48, 62, 84, 122, 102),
  kick: pose(-112, -108, 148, 96, 198, 118, -12, -8, 102, 96),
  fall_back: pose(-135, -150, 200, 230, 240, 260, 40, 70, 20, 50),
  lie: pose(180, 180, 170, 175, 185, 180, 0, 0, 5, 0),
});

/** Character-left/right names on Blue, plus the short limb names tools accept. */
const ALIASES = new Map([
  ['torso', 'torso'], ['head', 'head'],
  ['left upper arm', 'rightUpperArm'], ['left forearm', 'rightForearm'],
  ['left arm', 'rightUpperArm'], ['hand_l', 'rightForearm'], ['hand l', 'rightForearm'],
  ['right upper arm', 'leftUpperArm'], ['right forearm', 'leftForearm'],
  ['right arm', 'leftUpperArm'], ['hand_r', 'leftForearm'], ['hand r', 'leftForearm'],
  ['left thigh', 'rightThigh'], ['left lower leg', 'rightShin'], ['left shin', 'rightShin'],
  ['foot_l', 'rightShin'], ['foot l', 'rightShin'],
  ['right thigh', 'leftThigh'], ['right lower leg', 'leftShin'], ['right shin', 'leftShin'],
  ['foot_r', 'leftShin'], ['foot r', 'leftShin'],
]);

export function canonicalJoint(name) {
  if (JOINTS.includes(name)) return name;
  const key = String(name ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  const alias = ALIASES.get(key) ?? ALIASES.get(String(name ?? '').trim().toLowerCase());
  if (!alias) {
    throw new Error(`Unknown joint "${name}". Use ${JOINTS.join(', ')}, or a figure segment name such as "Left forearm".`);
  }
  return alias;
}

export function resolveAngles({pose: name = 'stand', joints = {}, lean = 0, flip = false} = {}, previous = null) {
  let base;
  if (name == null) base = previous ?? {...POSES.stand};
  else {
    base = POSES[name];
    if (!base) throw new Error(`Unknown pose "${name}". Known poses: ${Object.keys(POSES).join(', ')}.`);
    base = {...base};
  }
  for (const [joint, value] of Object.entries(joints ?? {})) {
    const key = canonicalJoint(joint);
    if (!Number.isFinite(value)) throw new Error(`Joint "${joint}" needs a number of degrees.`);
    base[key] = value;
  }
  if (lean) for (const joint of UPPER) base[joint] += lean;
  if (flip) for (const joint of JOINTS) base[joint] = 180 - base[joint];
  return base;
}

const radians = degrees => degrees * Math.PI / 180;

/** Radians in segment order. Extra segments (props) keep their own angles. */
export function segmentAngles(figure, degreesByJoint) {
  return figure.segments.map((segment, index) => {
    const joint = JOINTS[index];
    return joint && degreesByJoint[joint] != null ? radians(degreesByJoint[joint]) : segment.angle_rad;
  });
}

export function jointPositions(figure, angles, scale = 1) {
  const at = new Map([[0, {x: 0, y: 0}]]);
  return figure.segments.map((segment, index) => {
    const start = at.get(segment.parent_id) ?? {x: 0, y: 0};
    const angle = angles?.[index] ?? segment.angle_rad;
    const length = Number(segment.length) * scale;
    const end = {x: start.x + length * Math.cos(angle), y: start.y + length * Math.sin(angle)};
    at.set(segment.segment_id, end);
    return {id: segment.segment_id, name: segment.name ?? JOINTS[index] ?? `segment-${segment.segment_id}`, index, start, end, angle, length};
  });
}

/** How far the figure hangs below its root, in pixels, including line thickness. */
export function lowestPoint(figure, angles, scale = 1) {
  let lowest = 0;
  for (const joint of jointPositions(figure, angles, scale)) {
    const segment = figure.segments[joint.index];
    const pad = segment.segment_kind?.startsWith('circle') ? joint.length / 2 : (Number(segment.thickness) * scale) / 2;
    lowest = Math.max(lowest, joint.end.y + pad, joint.start.y + pad);
  }
  return lowest;
}

export function applyFollowers(figure, angles) {
  const index = new Map(figure.segments.map((segment, i) => [segment.segment_id, i]));
  for (const part of figure._styk?.mcpParts ?? []) {
    for (const link of part.follow ?? []) {
      const parent = index.get(link.parentId);
      const child = index.get(link.segmentId);
      if (parent == null || child == null) continue;
      angles[child] = angles[parent] + link.offset;
    }
  }
  return angles;
}

export function syncIkTargets(figure, object) {
  if (!object._stykIK) return object;
  const points = new Map(jointPositions(figure, object.angles, object.scale ?? 1).map(joint => [joint.id, joint.end]));
  const next = {};
  for (const [id, controller] of Object.entries(object._stykIK)) {
    const end = points.get(Number(id));
    next[id] = end && controller.target
      ? {...controller, target: {...controller.target, x: object.root_x + end.x, y: object.root_y + end.y}}
      : controller;
  }
  object._stykIK = next;
  return object;
}

export const poseNames = () => Object.keys(POSES);
