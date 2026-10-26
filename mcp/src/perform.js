import {EASINGS} from './compile.js';
import {findActor, figureOf, poseAt, worldPose} from './actors.js';
import {resolveAngles, segmentAngles, lowestPoint} from './rig.js';

/** Where a figure is standing right now, in the shape motionSamples expects. */
export function actorState(editor, name) {
  const object = findActor(editor, name);
  const pose = worldPose(editor, object.unique_id);
  const feet = pose.joints.reduce((lowest, joint) => Math.max(lowest, joint.y ?? 0), pose.root.y);
  return {
    uid: object.unique_id,
    x: pose.root.x,
    ground: feet,
    y: pose.root.y,
    scale: pose.scale,
    pose: 'stand',
    flip: false,
  };
}

/** Write motion samples as undoable keys. Feet stay on `ground`. */
export function performSamples(editor, uid, samples) {
  const figure = figureOf(editor, findActor(editor, String(uid)));
  const layer = editor.layerForUid(uid);
  const scale0 = findActor(editor, String(uid)).scale ?? 1;
  for (const sample of samples) {
    const change = sample.change ?? {};
    const scale = change.scale ?? scale0;
    const degrees = resolveAngles({
      pose: change.pose ?? 'stand',
      joints: change.joints,
      lean: change.lean ?? 0,
      flip: Boolean(change.flip),
    });
    const angles = segmentAngles(figure, degrees);
    const y = change.ground != null ? change.ground - lowestPoint(figure, angles, scale) : change.y;
    const tick = Math.max(0, Math.round(sample.frame));
    poseAt(editor, uid, tick, {
      x: change.x,
      y,
      scale: change.scale == null ? undefined : change.scale,
      angles,
      label: change.pose ? `Pose ${change.pose}` : 'Pose',
    });
    editor.sheetSetEasing([layer], tick, tick, EASINGS[sample.ease] ?? EASINGS.linear);
  }
}
