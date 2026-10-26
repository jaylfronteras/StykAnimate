import {createBlueStartupPose, createObject, createFrame} from './core.js';
import {ToolError} from './errors.js';
import {parseHex, jointByName, round} from './actors.js';
import {partById} from './parts.js';
import {syncIkTargets} from './rig.js';

const BASES = Object.freeze({
  stickman: {head: 1, torso: 1, arms: 1, legs: 1, thickness: 1},
  chibi: {head: 1.65, torso: 0.7, arms: 0.75, legs: 0.62, thickness: 0.85},
  tall: {head: 0.92, torso: 1.28, arms: 1.12, legs: 1.38, thickness: 0.9},
  bulky: {head: 1.15, torso: 0.92, arms: 0.95, legs: 0.88, thickness: 1.85},
});

const GROUPS = [
  ['torso', 0],
  ['head', 1],
  ['arms', 2], ['arms', 3], ['arms', 4], ['arms', 5],
  ['legs', 6], ['legs', 7], ['legs', 8], ['legs', 9],
];

export function baseNames() {
  return Object.keys(BASES);
}

/** A Blue-derived definition. Proportions scale limb lengths; thickness scales lines. */
export function buildFigureDefinition(spec = {}) {
  const base = spec.base ?? 'stickman';
  const preset = BASES[base];
  if (!preset) throw new ToolError(`Unknown base "${base}". Choose ${baseNames().join(', ')}.`);
  const proportions = {...preset, ...spec.proportions};
  const weight = (spec.thickness ?? 1) * (proportions.thickness ?? 1);
  const color = parseHex(spec.color ?? '#2b2b2b', 'color');
  const head = parseHex(spec.headColor ?? spec.color ?? '#2b2b2b', 'headColor');
  const {figure, object} = createBlueStartupPose();
  const next = structuredClone(figure);
  next.name = String(spec.name ?? 'Figure').slice(0, 255);
  next.figure_type_id = 1;
  for (const [group, index] of GROUPS) {
    const segment = next.segments[index];
    const factor = proportions[group] ?? 1;
    if (!Number.isFinite(factor) || factor <= 0 || factor > 8) throw new ToolError(`Proportion "${group}" must be between 0 and 8.`);
    segment.length = Math.max(1, segment.length * factor);
    if (segment.segment_kind === 'line') segment.thickness = Math.max(1, Math.round(segment.thickness * weight));
    segment.color_rgb = index === 1 ? [...head] : [...color];
  }
  const placed = structuredClone(object);
  placed.figure_type_id = 1;
  syncIkTargets(next, placed);
  return {figure: next, object: placed};
}

export function figureDocument(figure, object, {width = 960, height = 540} = {}) {
  const extra = {angles: object.angles?.slice() ?? figure.segments.map(segment => segment.angle_rad), scale: object.scale ?? 1};
  if (object._stykIK) extra._stykIK = structuredClone(object._stykIK);
  const pose = createObject(figure, 1, object.root_x ?? width / 2, object.root_y ?? height / 2, extra);
  return {
    version: 5,
    canvas_width: width,
    canvas_height: height,
    fps: 24,
    auto_easing: false,
    auto_easing_disabled_raw: 1,
    backgrounds: [],
    figure_types: [structuredClone(figure)],
    keyframes: [createFrame([pose], 1)],
    _styk: {format: 'StykAnimate', format_version: 1, name: figure.name},
  };
}

/**
 * Import a designed figure and attach parts. Every step is an editor command.
 * Props remember the angle offset from their parent so later poses keep them put.
 */
export function designFigure(editor, spec = {}) {
  const {figure, object} = buildFigureDefinition(spec);
  const x = spec.x ?? editor.report.canvas_width / 2;
  const y = spec.y ?? Math.round(editor.report.canvas_height * 0.62);
  const imported = editor.importFigure(figureDocument(figure, object, {
    width: editor.report.canvas_width,
    height: editor.report.canvas_height,
  }), {position: {x, y}});
  const uid = imported.unique_id;
  editor.select(uid);
  if (spec.scale && spec.scale !== 1) editor.scaleSelection(spec.scale);
  const head = spec.head ?? null;
  if (head && head !== 'default') {
    const index = jointByName(editor.figure, 'Head');
    editor.select(uid, index);
    editor.updateSegment({primitive_code: 0, thickness: 0});
  }
  const attached = [];
  const wanted = [...(head && head !== 'default' ? [`head-${head}`] : []), ...(spec.parts ?? [])];
  for (const id of wanted) attached.push(attachPart(editor, uid, id));
  editor.select(uid);
  return {unique_id: uid, name: editor.figure?.name, parts: attached.map(part => part.id)};
}

export function attachPart(editor, uid, partId) {
  const part = partById(partId);
  if (!part) throw new ToolError(`Unknown part "${partId}". Call parts_list.`);
  editor.select(uid);
  const figure = editor.figure;
  const anchorIndex = jointByName(figure, part.anchor);
  const anchorId = figure.segments[anchorIndex].segment_id;
  const created = [];
  const follow = [];
  part.segments.forEach((spec, index) => {
    editor.select(uid);
    const parentId = spec.parent == null ? anchorId : created[spec.parent]?.segment_id;
    if (parentId == null) throw new ToolError(`${part.id} segment ${index} has no parent.`);
    const parent = editor.figure.segments.findIndex(segment => segment.segment_id === parentId);
    const offset = (spec.local_deg * Math.PI) / 180;
    const angle = editor.object.angles[parent] + offset;
    const segment = editor.addSegment({
      parentId,
      type: spec.kind ?? 'line',
      length: spec.length,
      angle,
      thickness: spec.thickness ?? 4,
    });
    if (!segment?.segment_id) throw new ToolError(`Could not add a segment for ${part.id}.`);
    created.push(segment);
    if (spec.color || spec.thickness != null) {
      const at = editor.figure.segments.findIndex(item => item.segment_id === segment.segment_id);
      editor.select(uid, at);
      const patch = {};
      if (spec.color) patch.color_rgb = parseHex(spec.color, `${part.id} color`);
      if (spec.thickness != null) patch.thickness = spec.thickness;
      editor.updateSegment(patch);
    }
    follow.push({parentId, segmentId: segment.segment_id, offset});
  });
  const polygons = [];
  for (const polygon of part.polygons ?? []) {
    const handleIds = polygon.points.map(point => point === 'anchor' ? anchorId : created[point]?.segment_id);
    if (handleIds.some(id => id == null)) throw new ToolError(`${part.id} has a polygon point that was not created.`);
    editor.select(uid);
    const added = editor.addPolygon(handleIds, {color: polygon.color ?? '#2b2b2b', opacity: polygon.opacity ?? 1});
    polygons.push(added.polyfill_id);
  }
  rememberPart(editor, uid, {id: part.id, name: part.name, anchorId, segmentIds: created.map(segment => segment.segment_id), follow, polygons});
  return {id: part.id, name: part.name, segments: created.map(segment => segment.segment_id)};
}

export function detachPart(editor, uid, partId) {
  editor.select(uid);
  const figure = editor.figure;
  const parts = figure._styk?.mcpParts ?? [];
  const part = parts.find(item => item.id === partId);
  if (!part) throw new ToolError(`Figure "${figure.name}" has no attached part "${partId}".`);
  const ids = new Set(part.segmentIds);
  const polygonIndexes = (figure.polyfills ?? [])
    .map((polygon, index) => (part.polygons?.includes(polygon.polyfill_id) || (polygon.segment_ids ?? []).some(id => ids.has(id)) ? index : -1))
    .filter(index => index >= 0)
    .sort((a, b) => b - a);
  for (const index of polygonIndexes) {
    editor.select(uid);
    editor.removePolygon(index);
  }
  editor.select(uid, Math.max(0, editor.figure.segments.findIndex(segment => ids.has(segment.segment_id))));
  editor.deleteSegment({handleIds: [...ids], branch: true});
  const definition = structuredClone(editor.figure);
  definition._styk = {...definition._styk, mcpParts: (definition._styk?.mcpParts ?? []).filter(item => item.id !== partId)};
  editor.replaceFigureDefinition(definition.figure_type_id, definition, {label: `Detach ${part.name}`});
  return {id: partId, removed_segments: part.segmentIds.length};
}

function rememberPart(editor, uid, part) {
  editor.select(uid);
  const definition = structuredClone(editor.figure);
  const parts = [...(definition._styk?.mcpParts ?? []).filter(item => item.id !== part.id), part];
  definition._styk = {...definition._styk, mcpParts: parts};
  editor.replaceFigureDefinition(definition.figure_type_id, definition, {label: `Attach ${part.name}`});
}

export function describeDesign(editor, uid) {
  editor.select(uid);
  const figure = editor.figure;
  return {
    name: figure.name,
    unique_id: uid,
    parts: (figure._styk?.mcpParts ?? []).map(part => ({id: part.id, name: part.name, segments: part.segmentIds})),
    segments: figure.segments.length,
    polygons: figure.polyfills?.length ?? 0,
    height: round(Math.max(...figure.segments.map(segment => segment.length))),
  };
}
