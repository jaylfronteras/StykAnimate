import {ToolError} from './errors.js';
import {jointPositions, applyFollowers, syncIkTargets, canonicalJoint, JOINTS} from './rig.js';

export function figuresOn(editor, tick = editor.tick) {
  const previous = editor.tick;
  if (tick !== previous) editor.seek(tick);
  const objects = editor.evaluatedFrame.objects.map(object => ({object, figure: editor.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id)}));
  if (tick !== previous) editor.seek(previous);
  return objects;
}

export function findActor(editor, name) {
  if (name == null || name === '') throw new ToolError('Name the figure by its name or unique_id.');
  const text = String(name).trim();
  const asNumber = /^\d+$/.test(text) ? Number(text) : null;
  const objects = editor.evaluatedFrame.objects;
  const matches = objects.filter(object => {
    const figure = editor.report.figure_types.find(item => item.figure_type_id === object.figure_type_id);
    return object.unique_id === asNumber || figure?.name === text || String(object.unique_id) === text;
  });
  if (matches.length === 1) return matches[0];
  if (!matches.length) {
    const names = objects.map(object => {
      const figure = editor.report.figure_types.find(item => item.figure_type_id === object.figure_type_id);
      return `${figure?.name ?? 'figure'}#${object.unique_id}`;
    });
    throw new ToolError(`No figure "${text}". On screen: ${names.join(', ') || 'none'}.`);
  }
  throw new ToolError(`"${text}" matches more than one figure. Use its unique_id.`);
}

export function figureOf(editor, object) {
  return editor.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id);
}

export function jointByName(figure, name) {
  if (name == null) return null;
  const text = String(name).trim();
  const byId = figure.segments.findIndex(segment => String(segment.segment_id) === text);
  if (byId >= 0) return byId;
  const bySegmentName = figure.segments.findIndex(segment => segment.name?.toLowerCase() === text.toLowerCase());
  if (bySegmentName >= 0) return bySegmentName;
  try {
    const canonical = canonicalJoint(text);
    const index = JOINTS.indexOf(canonical);
    if (index >= 0 && figure.segments[index]) return index;
  } catch { /* fall through */ }
  throw new ToolError(`Figure "${figure.name}" has no joint "${text}". Joints: ${figure.segments.map(segment => segment.name || segment.segment_id).join(', ')}.`);
}

export function extendTo(editor, ticks) {
  const sheet = editor.report._styk?.layerSheet;
  if (!sheet) return;
  const need = Math.max(1, Math.round(ticks));
  if (sheet.duration >= need) return;
  const ids = ['scene', 'camera', ...editor.report._styk.layers.order];
  editor.sheetInsertFrames(ids, sheet.duration, need - sheet.duration);
}

export function ensureLayerSpan(editor, id) {
  const sheet = editor.report._styk?.layerSheet;
  if (!sheet) return;
  const track = sheet.tracks[id];
  if (!track) return;
  if (track.end < sheet.duration) editor.sheetInsertFrames([id], Math.max(0, track.end), sheet.duration - track.end);
  if (!track.keys?.some(key => key.tick === 0)) editor.sheetInsertKey([id], 0);
}

/** Write one pose as its own undoable key on the figure's layer. */
export function poseAt(editor, uid, tick, patch = {}) {
  const time = Math.max(0, Math.round(tick));
  extendTo(editor, time + 1);
  const layer = editor.layerForUid(uid);
  ensureLayerSpan(editor, layer);
  editor.seek(time);
  const hasKey = editor.layerFrameKeys(layer).some(key => key.tick === time);
  if (!hasKey) editor.sheetInsertKey([layer], time);
  editor.seek(time);
  editor.select(uid);
  const figure = editor.figure;
  editor.transaction(patch.label ?? 'Pose', frame => {
    const object = frame.objects.find(item => item.unique_id === uid);
    if (!object) throw new ToolError('That figure is not on this frame.');
    if (patch.x != null) object.root_x = patch.x;
    if (patch.y != null) object.root_y = patch.y;
    if (patch.scale != null) object.scale = patch.scale;
    if (patch.angles) {
      const angles = object.angles.slice();
      patch.angles.forEach((angle, index) => { if (index < angles.length && angle != null) angles[index] = angle; });
      while (angles.length < figure.segments.length) angles.push(figure.segments[angles.length].angle_rad);
      applyFollowers(figure, angles);
      object.angles = angles;
    } else applyFollowers(figure, object.angles);
    syncIkTargets(figure, object);
    delete object.runtime_segments;
  });
}

export function worldPose(editor, uid, tick = editor.tick) {
  const time = Math.max(0, Math.min(Math.round(tick), Math.max(0, editor.totalTicks - 1)));
  editor.seek(time);
  editor.select(uid);
  const object = editor.object;
  const figure = editor.figure;
  const slot = editor.selectedSlot;
  const geometry = editor.geometry.objects.get(slot);
  const joints = figure.segments.map(segment => {
    const point = geometry?.joints?.get(segment.segment_id);
    return {
      name: segment.name ?? `segment ${segment.segment_id}`,
      id: segment.segment_id,
      x: round(point?.x),
      y: round(point?.y),
      angle_deg: round(radiansToDegrees(object.angles[figure.segments.indexOf(segment)] ?? segment.angle_rad), 2),
      length: round(segment.length, 2),
    };
  });
  return {
    tick: editor.tick,
    unique_id: uid,
    name: figure.name,
    root: {x: round(object.root_x), y: round(object.root_y)},
    scale: object.scale ?? 1,
    joints,
    ik: Object.entries(object._stykIK ?? {}).map(([id, controller]) => ({
      joint_id: Number(id),
      enabled: controller.enabled,
      pinned: controller.pinned,
      target: controller.target ? {x: round(controller.target.x), y: round(controller.target.y)} : null,
    })),
  };
}

export function describeActor(editor, uid) {
  editor.select(uid);
  const figure = editor.figure;
  const object = editor.object;
  const pose = worldPose(editor, uid, editor.tick);
  return {
    name: figure.name,
    unique_id: uid,
    figure_type_id: figure.figure_type_id,
    layer: editor.layerForUid(uid),
    root: pose.root,
    scale: object.scale ?? 1,
    segments: figure.segments.map((segment, index) => ({
      name: segment.name ?? null,
      id: segment.segment_id,
      parent_id: segment.parent_id,
      kind: segment.segment_kind,
      length: round(segment.length, 2),
      thickness: round(segment.thickness, 2),
      angle_deg: round(radiansToDegrees(segment.angle_rad), 2),
      color: rgbHex(segment.color_rgb),
      visible: segment.visible !== false,
      world: pose.joints[index],
    })),
    polygons: (figure.polyfills ?? []).map((polygon, index) => ({index, id: polygon.polyfill_id ?? index, handles: polygon.segment_ids ?? polygon.handle_ids ?? []})),
    parts: figure._styk?.mcpParts ?? [],
    ik: pose.ik,
  };
}

export const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
export const radiansToDegrees = radians => radians * 180 / Math.PI;
export const degreesToRadians = degrees => degrees * Math.PI / 180;
export function rgbHex(rgb = [0, 0, 0]) {
  return `#${rgb.map(channel => Number(channel).toString(16).padStart(2, '0')).join('')}`;
}
export function parseHex(value, label = 'color') {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? ''));
  if (!match) throw new ToolError(`${label} must be a hex color such as "#1d9bf0".`);
  const hex = match[1].length === 3 ? [...match[1]].map(digit => digit + digit).join('') : match[1];
  const rgb = Number.parseInt(hex, 16);
  return [rgb >> 16 & 255, rgb >> 8 & 255, rgb & 255];
}
export function argb(hex) {
  const [r, g, b] = parseHex(hex);
  return (0xff000000 | r << 16 | g << 8 | b) >>> 0;
}
