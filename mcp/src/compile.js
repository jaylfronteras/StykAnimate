/**
 * Turn a scene spec into a native document using the app's own factories.
 *
 * The spec shape, ground placement and easing names follow upstream PR #21
 * (mashhoorahdal), adapted here so the document is opened through Editor.load
 * with the same layer sheet the desktop app creates. Beats ("walk to x=800
 * in 1.5s") expand into that keyframe spec via the motion library.
 */
import {
  emptyDocument, createObject, createFrame, createBlueStartupPose, ensureLayerState, validateScene, createTextFigure,
} from './core.js';
import {ToolError} from './errors.js';
import {resolveAngles, segmentAngles, lowestPoint, syncIkTargets} from './rig.js';
import {motionSamples, parseAction} from './motions.js';
import {parseHex} from './actors.js';

const EASINGS = Object.freeze({
  auto: {interpolation: 'auto'},
  linear: {interpolation: 'linear'},
  'ease-in': {interpolation: 'ease-in'},
  'ease-out': {interpolation: 'ease-out'},
  'ease-in-out': {interpolation: 'bezier', bezier: [0.42, 0, 0.58, 1]},
  constant: {interpolation: 'constant'},
  hold: {interpolation: 'constant'},
});

const CANVAS = Object.freeze({
  landscape: {width: 960, height: 540},
  portrait: {width: 540, height: 960},
  square: {width: 720, height: 720},
});

function canvasOf(spec) {
  if (spec.canvas && typeof spec.canvas === 'string') {
    const known = CANVAS[spec.canvas];
    if (!known) throw new ToolError(`canvas must be landscape, portrait, square, or {width, height}.`);
    return known;
  }
  if (spec.canvas && typeof spec.canvas === 'object') return {width: spec.canvas.width, height: spec.canvas.height};
  return {width: spec.width ?? 960, height: spec.height ?? 540};
}

export async function compileScenario(spec) {
  if (!spec || typeof spec !== 'object') throw new ToolError('scenario_build needs a spec object. Call scenario_guide for the shape.');
  const expanded = spec.keyframes ? spec : expandBeats(spec);
  const text = await prepareText(expanded);
  return compileKeyframes(expanded, text);
}

function expandBeats(spec) {
  const fps = spec.fps ?? 24;
  const {width, height} = canvasOf(spec);
  const cast = (spec.cast ?? []).map(member => ({...member}));
  if (!cast.length) throw new ToolError('The cast is empty. Add at least one figure.');
  const total = Math.max(1, Math.round((spec.duration ?? spec.seconds ?? 4) * fps));
  const initial = new Map(cast.map(member => [member.id, {
    x: member.x ?? width / 2,
    ground: member.ground ?? member.y ?? Math.round(height * 0.78),
    y: member.y,
    pose: member.pose ?? 'stand',
    flip: Boolean(member.flip),
    scale: member.scale ?? 1,
  }]));
  const tracks = new Map(cast.map(member => [member.id, []]));
  const stateAt = (id, frame) => {
    let state = initial.get(id);
    for (const sample of tracks.get(id) ?? []) if (sample.frame <= frame) state = sample.state;
    return state;
  };
  const keys = new Map();
  const touch = frame => {
    if (!keys.has(frame)) keys.set(frame, {figures: {}, ease: 'linear'});
    return keys.get(frame);
  };
  for (const member of cast) {
    const state = initial.get(member.id);
    if (member.kind === 'stickman' || member.kind == null) {
      touch(0).figures[member.id] = {x: state.x, ground: state.ground, pose: state.pose, flip: state.flip, scale: state.scale};
    } else {
      touch(0).figures[member.id] = {x: member.x ?? 0, y: member.y ?? state.ground, scale: member.scale, rotate: member.rotate};
    }
  }
  const beats = [...(spec.beats ?? [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  let background = spec.background ?? '#f4f1ea';
  let camera = spec.camera ?? null;
  for (const beat of beats) {
    const frame = Math.max(0, Math.round((beat.at ?? 0) * fps));
    if (beat.background) background = beat.background;
    if (beat.camera) camera = {...camera, ...beat.camera};
    const slot = touch(frame);
    if (beat.background) slot.background = beat.background;
    if (beat.camera) slot.camera = {...beat.camera};
    if (beat.ease) slot.ease = beat.ease;
    if (beat.say) addCaption(cast, slot, beat, frame, fps, keys, width);
    if (!beat.actor) continue;
    if (!initial.has(beat.actor)) throw new ToolError(`Beat names "${beat.actor}", which is not in the cast.`);
    const member = cast.find(item => item.id === beat.actor);
    if (member.kind && member.kind !== 'stickman') {
      const parsed = beat.action ? parseAction(beat.action) : beat;
      if (parsed.to?.x != null) slot.figures[beat.actor] = {x: parsed.to.x, y: parsed.to.y ?? member.y};
      continue;
    }
    const parsed = normalizeBeat(beat);
    const samples = motionSamples(stateAt(beat.actor, frame), {...parsed, at: beat.at ?? frame / fps}, fps);
    for (const sample of samples) {
      const key = touch(sample.frame);
      key.figures[beat.actor] = {...key.figures[beat.actor], ...sample.change};
      if (sample.ease) key.ease = mergeEase(key.ease, sample.ease);
      tracks.get(beat.actor).push(sample);
    }
  }
  const frames = [...keys.keys()].sort((a, b) => a - b);
  if (frames[0] !== 0) frames.unshift(0);
  const end = Math.max(total, (frames.at(-1) ?? 0) + 1);
  const keyframes = frames.map((frame, index) => {
    const next = frames[index + 1] ?? end;
    const key = keys.get(frame) ?? {figures: {}, ease: 'linear'};
    return {hold: Math.max(1, next - frame), ease: key.ease ?? 'linear', figures: key.figures, camera: key.camera, background: key.background};
  });
  return {...spec, width, height, fps, background, keyframes, cast: cast.map(member => ({kind: 'stickman', ...member}))};
}

function normalizeBeat(beat) {
  const parsed = beat.action ? parseAction(beat.action) : {};
  return {
    motion: beat.motion ?? parsed.motion,
    duration: beat.duration ?? parsed.duration ?? 1,
    to: beat.to ?? parsed.to,
    ground: beat.ground ?? beat.to?.y,
    height: beat.height ?? parsed.height,
    flip: beat.flip,
  };
}

function mergeEase(current, next) {
  if (current === 'linear' || next === 'linear') return 'linear';
  return next || current;
}

function addCaption(cast, slot, beat, frame, fps, keys, width) {
  const id = `${beat.actor || 'caption'}-line-${frame}`;
  cast.push({id, kind: 'text', text: String(beat.say), fontSize: beat.fontSize ?? 36, color: beat.color ?? '#1c2430', x: width / 2, y: 80});
  slot.figures[id] = {x: beat.x ?? width / 2, y: beat.y ?? 72};
  const hideAt = frame + Math.round((beat.duration ?? 1.6) * fps);
  const later = keys.get(hideAt) ?? {figures: {}, ease: 'linear'};
  later.figures[id] = {hide: true};
  keys.set(hideAt, later);
}

async function prepareText(spec) {
  const out = new Map();
  for (const member of spec.cast ?? []) {
    if (member.kind !== 'text') continue;
    const figure = await createTextFigure({
      text: String(member.text ?? member.say ?? ' '),
      fontSize: member.fontSize ?? 42,
      color: parseHex(member.color ?? '#1c2430', `${member.id}.color`),
      alignment: member.align ?? 'center',
      bold: Boolean(member.bold),
      name: member.id,
    });
    out.set(member.id, {figure});
  }
  return out;
}

function compileKeyframes(spec, external) {
  const {width, height} = canvasOf(spec);
  const fps = spec.fps ?? 24;
  if (!Number.isInteger(fps) || fps < 1 || fps > 1000) throw new ToolError('fps must be an integer from 1 to 1000.');
  if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 100000)) throw new ToolError('Canvas width and height must be integers from 1 to 100000.');
  const cast = spec.cast ?? [];
  const keyframes = spec.keyframes ?? [];
  if (!cast.length) throw new ToolError('The cast is empty.');
  if (!keyframes.length) throw new ToolError('The spec has no keyframes or beats.');
  const ids = new Set();
  for (const member of cast) {
    if (!member.id || ids.has(member.id)) throw new ToolError(`Cast ids must be unique and non-empty (problem: "${member.id}").`);
    ids.add(member.id);
  }
  const document = emptyDocument();
  Object.assign(document, {canvas_width: width, canvas_height: height, fps});
  document._styk.name = spec.title ?? 'Untitled animation';
  document.figure_types = cast.map((member, index) => castDefinition(member, index + 1, external));
  const figures = new Map(cast.map((member, index) => [member.id, document.figure_types[index]]));
  const uids = new Map(cast.map((member, index) => [member.id, index + 1]));
  assignLayers(document, cast, uids);

  const backgrounds = new Map();
  const backgroundId = color => {
    const [r, g, b] = parseHex(color, 'background');
    const argb = (0xff000000 | r << 16 | g << 8 | b) >>> 0;
    if (!backgrounds.has(argb)) backgrounds.set(argb, {background_id: backgrounds.size + 1, kind: 2, color: argb, name: `Color ${color}`});
    return backgrounds.get(argb).background_id;
  };

  const states = new Map();
  const visible = new Set();
  let background = spec.background ?? '#f4f1ea';
  let camera = null;
  let ticks = 0;
  const frames = keyframes.map((key, index) => {
    const hold = key.hold ?? 12;
    if (!Number.isInteger(hold) || hold < 1 || hold > 65535) throw new ToolError(`keyframes[${index}].hold must be a whole number of frames from 1 to 65535.`);
    for (const [id, change] of Object.entries(key.figures ?? {})) {
      const member = cast.find(entry => entry.id === id);
      if (!member) throw new ToolError(`keyframes[${index}] names "${id}", which is not in the cast.`);
      if (change.hide) { visible.delete(id); continue; }
      states.set(id, nextState(member, states.get(id) ?? {}, change));
      visible.add(id);
    }
    if (key.background) background = key.background;
    if (key.camera) camera = {...(camera ?? {}), ...key.camera};
    const objects = cast.filter(member => visible.has(member.id)).map(member => placeObject(member, figures.get(member.id), uids.get(member.id), states.get(member.id)));
    const frame = createFrame(objects, hold);
    const easing = EASINGS[key.ease ?? spec.ease ?? 'linear'];
    if (!easing) throw new ToolError(`Unknown ease "${key.ease}". Use ${Object.keys(EASINGS).join(', ')}.`);
    frame._styk = {easing: structuredClone(easing)};
    frame.background_id = backgroundId(background);
    if (camera) {
      const zoom = camera.zoom ?? 1;
      frame.camera = {
        is_default: false,
        x: (camera.x ?? width / 2) - width / 2,
        y: (camera.y ?? height / 2) - height / 2,
        scale: 1 / zoom,
        angle_rad: ((camera.rotate ?? camera.rotation ?? 0) * Math.PI) / 180,
      };
    }
    ticks += hold;
    return frame;
  });
  for (const figure of figures.values()) delete figure._mcpRest;
  const closing = structuredClone(frames.at(-1));
  closing.duration_raw = 1;
  closing._styk = {easing: {interpolation: 'constant'}};
  frames.push(closing);
  document.keyframes = frames;
  document.backgrounds = [...backgrounds.values()];
  validateScene(document);
  return {document, ticks, seconds: ticks / fps, cast: cast.map(member => member.id)};
}

function assignLayers(document, cast, uids) {
  const state = ensureLayerState(document);
  state.order = [];
  state.byId = {};
  state.assignments = {};
  state.nextId = 1;
  for (const member of cast) {
    const id = `layer-${state.nextId++}`;
    state.order.push(id);
    state.byId[id] = {name: String(member.id).slice(0, 160), visible: true, locked: false};
    state.assignments[String(uids.get(member.id))] = id;
  }
  state.defaultLayerId = state.order[0];
  state.activeId = state.order[0];
}

function castDefinition(member, typeId, external) {
  const kind = member.kind ?? 'stickman';
  const color = parseHex(member.color ?? '#2b2b2b', `${member.id}.color`);
  if (kind === 'stickman') return blueFigure(typeId, member, color);
  if (kind === 'line') {
    return definition(typeId, member.id, [segment(member.length ?? 400, 0, member.thickness ?? 4, {color_rgb: color, ...staticSegment})]);
  }
  if (kind === 'circle') {
    const filled = member.filled !== false;
    const diameter = 2 * (member.radius ?? 28);
    return definition(typeId, member.id, [segment(diameter, -Math.PI / 2, filled ? 0 : member.thickness ?? 4, {
      color_rgb: color, ...staticSegment,
      primitive_code: filled ? 3 : 1, flags: filled ? 259 : 257,
      segment_type: 'circle', segment_kind: filled ? 'circleFill' : 'circle',
    })]);
  }
  if (kind === 'text' || kind === 'file') {
    const figure = external.get(member.id)?.figure ?? member.figure;
    if (!figure) throw new ToolError(`${member.id}: its ${kind} figure was not prepared.`);
    return {...structuredClone(figure), figure_type_id: typeId, name: member.id};
  }
  throw new ToolError(`${member.id}: unknown kind "${kind}". Use stickman, line, circle, or text.`);
}

function blueFigure(typeId, member, color) {
  const {figure, object} = createBlueStartupPose();
  const next = structuredClone(figure);
  next.figure_type_id = typeId;
  next.name = member.id;
  const head = member.headColor ? parseHex(member.headColor, `${member.id}.headColor`) : color;
  const weight = member.thickness ?? 1;
  for (const segment of next.segments) {
    segment.color_rgb = segment.segment_id === 2 ? [...head] : [...color];
    if (segment.segment_kind === 'line') segment.thickness = Math.max(1, Math.round(segment.thickness * weight));
  }
  if (member.headFilled === false) Object.assign(next.segments[1], {primitive_code: 1, flags: 1, segment_kind: 'circle', thickness: Math.max(2, Math.round(4 * weight))});
  next._mcpRest = {ik: structuredClone(object._stykIK), root: {x: object.root_x, y: object.root_y}};
  return next;
}

const staticSegment = {aux_code: 1, flags: 256, is_static: true};
function segment(length, angle, thickness, extra = {}) {
  return {
    segment_id: 1, parent_id: 0, length, angle_rad: angle, thickness, bend_rad: 0, primitive_code: 0, aux_code: 0,
    flags: 0, segment_type: 'line', segment_kind: 'line', color_rgb: [43, 43, 43], transparency: 0, visible: true, z_order: 1, ...extra,
  };
}
function definition(id, name, segments) {
  segments.forEach((item, index) => { item.segment_id = index + 1; item.z_order = index + 1; if (index === 0) item.parent_id = 0; });
  return {figure_type_id: id, name, segment_count: segments.length, segments, polyfills: [], image_assets: [], text_assets: []};
}

function placeObject(member, figure, uid, state) {
  const scale = state.scale ?? 1;
  const kind = member.kind ?? 'stickman';
  let x = state.x ?? 0;
  let y = state.y ?? 0;
  let angles = figure.segments.map(item => item.angle_rad);
  if (kind === 'stickman') {
    const degrees = resolveAngles({pose: state.pose ?? 'stand', joints: state.joints, lean: state.lean ?? 0, flip: state.flip ?? false});
    angles = segmentAngles(figure, degrees);
    x = state.x ?? 0;
    y = state.ground != null ? state.ground - lowestPoint(figure, angles, scale) : (state.y ?? 0);
  } else {
    const turn = ((state.rotate ?? 0) * Math.PI) / 180;
    angles = figure.segments.map(item => (state.flip ? Math.PI - item.angle_rad : item.angle_rad) + turn);
    if (kind === 'circle') y += figure.segments[0].length / 2 * scale;
  }
  const extra = {};
  if (figure._mcpRest?.ik) {
    const ik = structuredClone(figure._mcpRest.ik);
    const dx = x - figure._mcpRest.root.x;
    const dy = y - figure._mcpRest.root.y;
    for (const controller of Object.values(ik)) if (controller.target) { controller.target.x += dx; controller.target.y += dy; }
    extra._stykIK = ik;
  }
  const object = createObject(figure, uid, x, y, extra);
  object.scale = scale;
  object.angles = angles;
  if (state.opacity != null) object.field28 = Math.round((1 - Math.min(1, Math.max(0, state.opacity))) * 255);
  syncIkTargets(figure, object);
  return object;
}

const PLACEMENT = ['x', 'y', 'ground', 'scale', 'rotate', 'flip', 'opacity'];
function nextState(member, previous, change) {
  const state = {...previous};
  for (const key of PLACEMENT) if (change[key] !== undefined) state[key] = change[key];
  if (change.y !== undefined && change.ground === undefined) delete state.ground;
  if (change.ground !== undefined && change.y === undefined) delete state.y;
  if ((member.kind ?? 'stickman') === 'stickman' && (change.pose !== undefined || change.joints || change.lean || change.flip !== undefined || !previous.pose)) {
    state.pose = change.pose ?? previous.pose ?? 'stand';
    state.joints = change.joints ?? (change.pose != null ? undefined : previous.joints);
    state.lean = change.lean ?? (change.pose != null ? 0 : previous.lean ?? 0);
    state.flip = change.flip ?? previous.flip ?? false;
  }
  return state;
}

export {CANVAS, EASINGS};
