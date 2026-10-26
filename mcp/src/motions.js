import {ToolError} from './errors.js';
import {POSES} from './rig.js';

export const MOTIONS = Object.freeze({
  idle: 'A slow weight shift so the figure is not frozen. Stays on the spot.',
  walk: 'Four-pose walk (contact, passing, contact, passing) with bent knees and opposite arms. Feet stay on the ground line.',
  run: 'Leaning two-pose run with a longer stride. Faces the direction of travel.',
  jump: 'Crouch, rise, land, stand. The ground line lifts while the figure is in the air.',
  punch: 'A short wind-up into an extended punch, then back to standing.',
  kick: 'A reach and a kick, then standing. Stays at the same x.',
  wave: 'The near arm waves twice, with the forearm leading the upper arm.',
  sit: 'Sits down and holds.',
  fall: 'Tips backward onto the ground.',
  nod: 'A small head nod while the body stays put.',
});

const smooth = t => t * t * (3 - 2 * t);

function framesOf(beat, fps) {
  const seconds = beat.duration ?? 1;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120) throw new ToolError('Motion duration must be between 0 and 120 seconds.');
  return Math.max(4, Math.round(seconds * fps));
}

function startFrame(beat, fps) {
  const at = beat.at ?? 0;
  if (!Number.isFinite(at) || at < 0) throw new ToolError('Beat time "at" must be zero or a positive number of seconds.');
  return Math.round(at * fps);
}

/**
 * Samples are absolute frames. `change` is merged into the spec keyframe for
 * that actor; `state` is the pose carried forward after the sample.
 */
export function motionSamples(state, beat, fps) {
  const motion = beat.motion;
  if (!MOTIONS[motion]) throw new ToolError(`Unknown motion "${motion}". Choose ${Object.keys(MOTIONS).join(', ')}.`);
  const start = startFrame(beat, fps);
  const span = framesOf(beat, fps);
  const scale = state.scale ?? 1;
  const ground = beat.ground ?? beat.to?.y ?? state.ground;
  const flip = beat.flip ?? state.flip ?? false;
  const base = {ground, flip, scale};
  const finish = (extra = {}) => ({...state, ...base, pose: 'stand', ...extra});

  if (motion === 'walk' || motion === 'run') return locomotion(state, beat, {start, span, fps, scale, ground, motion});
  if (motion === 'jump') return jump(state, {start, span, scale, ground, base, finish});
  if (motion === 'wave') return cycle(state, {start, span, poses: ['wave_a', 'wave_b'], base, finish, ease: 'ease-in-out'});
  if (motion === 'punch') return gesture(state, {start, span, pose: 'punch', base, finish});
  if (motion === 'kick') return gesture(state, {start, span, pose: 'kick', windup: 'crouch', base, finish});
  if (motion === 'idle') return idle(state, {start, span, base, finish, fps});
  if (motion === 'nod') return nod(state, {start, span, base, finish});
  if (motion === 'sit') return hold(state, {start, span, pose: 'sit', base, finish: () => finish({pose: 'sit'})});
  if (motion === 'fall') return hold(state, {start, span, pose: 'fall_back', base, finish: () => finish({pose: 'lie', ground: ground + 8 * scale})});
  throw new ToolError(`Motion "${motion}" is not implemented.`);
}

function locomotion(state, beat, {start, span, scale, ground, motion}) {
  const destination = beat.to?.x;
  if (!Number.isFinite(destination)) throw new ToolError(`${motion} needs to.x, the hip x to travel to.`);
  const distance = destination - state.x;
  const ideal = (motion === 'run' ? 58 : 34) * scale;
  const minSteps = motion === 'run' ? 2 : 4;
  const gapFloor = motion === 'run' ? 4 : 5;
  let steps = Math.max(minSteps, Math.round(Math.abs(distance) / Math.max(ideal, 1)));
  while (steps > minSteps && Math.floor(span / steps) < gapFloor) steps -= motion === 'run' ? 1 : 2;
  steps = Math.max(minSteps, steps);
  // Stay inside the beat. A very short action gets a quicker cycle instead of
  // spilling keys into the next one.
  const gap = Math.max(1, Math.floor(span / steps));
  const used = Math.min(span, gap * steps);
  const poses = motion === 'run' ? ['run_a', 'run_b'] : ['walk_contact_a', 'walk_pass_a', 'walk_contact_b', 'walk_pass_b'];
  const facingLeft = distance < 0;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const last = i === steps;
    const pose = last ? 'stand' : poses[i % poses.length];
    const x = state.x + distance * (last ? 1 : u);
    out.push({
      frame: start + Math.round(u * used),
      ease: last ? 'ease-out' : 'linear',
      change: {pose, x, ground, flip: facingLeft, lean: motion === 'run' ? 4 : 0},
      state: {...state, x: last ? destination : x, ground, flip: facingLeft, pose: last ? 'stand' : pose, scale: state.scale},
    });
  }
  return out;
}

function jump(state, {start, span, scale, ground, base, finish}) {
  const height = 100 * scale;
  const marks = [0, 0.28, 0.62, 1];
  const poses = ['crouch', 'jump', 'crouch', 'stand'];
  const grounds = [ground, ground - height, ground, ground];
  return marks.map((u, i) => ({
    frame: start + Math.round(span * u),
    ease: i === 1 ? 'ease-out' : 'ease-in-out',
    change: {pose: poses[i], x: state.x, ground: grounds[i], ...base, ground: grounds[i]},
    state: finish({x: state.x, ground, pose: i === marks.length - 1 ? 'stand' : poses[i]}),
  }));
}

function cycle(state, {start, span, poses, base, finish, ease}) {
  const keys = Math.max(poses.length, Math.round(span / 6));
  const out = [];
  for (let i = 0; i <= keys; i++) {
    const last = i === keys;
    out.push({
      frame: start + Math.round(span * (i / keys)),
      ease,
      change: {pose: last ? 'stand' : poses[i % poses.length], x: state.x, ...base},
      state: finish({x: state.x}),
    });
  }
  return out;
}

function gesture(state, {start, span, pose, windup = 'stand', base, finish}) {
  const marks = windup === 'stand' ? [0, 0.35, 1] : [0, 0.3, 0.55, 1];
  const poses = windup === 'stand' ? ['stand', pose, 'stand'] : [windup, pose, windup, 'stand'];
  return marks.map((u, i) => ({
    frame: start + Math.round(span * u),
    ease: i === 1 ? 'ease-out' : 'ease-in-out',
    change: {pose: poses[i], x: state.x, ...base},
    state: finish({x: state.x, pose: poses[i] === 'stand' ? 'stand' : poses[i]}),
  }));
}

function idle(state, {start, span, base, finish, fps}) {
  const period = Math.max(8, Math.round(0.7 * fps));
  const keys = Math.max(2, Math.round(span / period));
  const out = [];
  for (let i = 0; i <= keys; i++) {
    const last = i === keys;
    const side = i % 2 === 0 ? 1 : -1;
    out.push({
      frame: start + Math.round(span * (i / keys)),
      ease: 'ease-in-out',
      change: last ? {pose: 'stand', x: state.x, ...base} : {
        pose: 'stand',
        x: state.x + side * 2 * (state.scale ?? 1),
        joints: {torso: -90 + side * 1.5, head: -90 - side * 2, rightUpperArm: 80 + side * 5, leftUpperArm: 100 - side * 4},
        ...base,
      },
      state: finish({x: state.x}),
    });
  }
  return out;
}

function nod(state, {start, span, base, finish}) {
  const heads = [-90, -62, -98, -90];
  return heads.map((head, i) => ({
    frame: start + Math.round(span * (i / (heads.length - 1))),
    ease: 'ease-in-out',
    change: {pose: 'stand', joints: {head}, x: state.x, ...base},
    state: finish({x: state.x}),
  }));
}

function hold(state, {start, span, pose, base, finish}) {
  return [
    {frame: start, ease: 'ease-in-out', change: {pose, x: state.x, ...base}, state: finish()},
    {frame: start + span, ease: 'constant', change: {pose: pose === 'fall_back' ? 'lie' : pose, x: state.x, ...base}, state: finish()},
  ];
}

export function parseAction(text) {
  const source = String(text ?? '').trim();
  const motion = /^(walk|run|jump|punch|kick|wave|sit|fall|idle|nod)\b/i.exec(source);
  if (!motion) throw new ToolError(`Could not read action "${text}". Start with a motion name, for example "walk to x=640 in 1.5s".`);
  const duration = /(?:in|for)\s+([\d.]+)\s*s/i.exec(source);
  const x = /x\s*=\s*(-?[\d.]+)/i.exec(source);
  const y = /y\s*=\s*(-?[\d.]+)/i.exec(source);
  const height = /height\s*=\s*(-?[\d.]+)/i.exec(source);
  return {
    motion: motion[1].toLowerCase(),
    duration: duration ? Number(duration[1]) : undefined,
    to: x ? {x: Number(x[1]), y: y ? Number(y[1]) : undefined} : undefined,
    height: height ? Number(height[1]) : undefined,
  };
}

export function knownPoses() {
  return Object.keys(POSES);
}

export {smooth};
