import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {
  validateScene, createStartupDocument, createTextFigure, inspectWave, wavePeaks, AUDIO_CHUNK_BYTES,
  audioState, LAYER_COLORS, nativeFigureDocument, EDITOR_OPTIONS,
} from './core.js';
import {ToolError, explain} from './errors.js';
import {
  requireProject, activeProject, listProjects, adopt, closeProject, createEditor, enqueue, change, result,
} from './session.js';
import {ensureWorkspace, resolveInside, workspaceDir} from './paths.js';
import {readProjectFile, writeProjectFile, writeFigureFile, kindFor} from './files.js';
import {
  findActor, figureOf, describeActor, worldPose, poseAt, extendTo, ensureLayerSpan, degreesToRadians, round, argb, parseHex,
} from './actors.js';
import {poseNames, resolveAngles, segmentAngles, JOINTS, canonicalJoint} from './rig.js';
import {MOTIONS, motionSamples, knownPoses} from './motions.js';
import {compileScenario, EASINGS, CANVAS} from './compile.js';
import {actorState, performSamples} from './perform.js';
import {designFigure, attachPart, detachPart, describeDesign, baseNames} from './design.js';
import {listParts} from './parts.js';
import {renderFrame, renderSheet, encodeSequence, presetSize, closeRenderer} from './render.js';
import {SCENARIO_GUIDE} from './guide.js';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';

const projectField = z.string().optional().describe('Open project id, such as "p1". Omit to use the active project.');
const revisionField = z.number().int().optional().describe('Reject the edit if the project revision is no longer this number. Read project_info first when several edits might race.');
const actorField = z.string().describe('Figure name or unique_id. Names that match more than one figure need the unique_id.');
const tickField = z.number().int().nonnegative().optional().describe('Frame number on the timeline. Omit to use the playhead.');

function answer(work) {
  return Promise.resolve().then(work).then(value => {
    const images = value?.images ?? (value?.image ? [value.image] : []);
    const data = value && typeof value === 'object' ? {...value} : {result: value};
    delete data.images;
    delete data.image;
    return {
      content: [
        {type: 'text', text: JSON.stringify(data, null, 2)},
        ...images.map(png => ({type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png'})),
      ],
    };
  }).catch(error => ({isError: true, content: [{type: 'text', text: explain(error)}]}));
}

async function edit(args, fn, options = {}) {
  const project = requireProject(args.project);
  const {value, snapshot} = await enqueue(project, () => change(project, editor => fn(project, editor, args), {
    snapshot: options.snapshot,
    label: options.label ?? 'Edit',
    expectRevision: args.expect_revision,
  }));
  return result(project, {...(value ?? {}), ...(snapshot ? {snapshot} : {})});
}

async function view(args, fn) {
  const project = requireProject(args.project);
  return enqueue(project, () => fn(project, project.editor, args));
}

function canvasFrom(args) {
  if (typeof args.canvas === 'string') {
    const known = CANVAS[args.canvas];
    if (!known) throw new ToolError('canvas must be landscape, portrait, square, or omitted.');
    return known;
  }
  if (args.width || args.height) return {width: args.width ?? 960, height: args.height ?? 540};
  return undefined;
}

function actorObject(editor, name) {
  const object = findActor(editor, name);
  return {object, figure: figureOf(editor, object), uid: object.unique_id};
}

function easingOf(name) {
  const easing = EASINGS[name];
  if (!easing) throw new ToolError(`Unknown ease "${name}". Use ${Object.keys(EASINGS).join(', ')}.`);
  return easing;
}

function lookCamera(editor, args) {
  const width = editor.report.canvas_width;
  const height = editor.report.canvas_height;
  const zoom = args.zoom ?? 1;
  if (!(zoom > 0)) throw new ToolError('zoom must be greater than 0. 1 shows the canvas, 2 moves closer.');
  return {
    x: (args.x ?? width / 2) - width / 2,
    y: (args.y ?? height / 2) - height / 2,
    scale: 1 / zoom,
    angle_rad: ((args.rotate ?? 0) * Math.PI) / 180,
  };
}

function putCamera(editor, tick, patch) {
  const time = Math.max(0, Math.round(tick));
  extendTo(editor, time + 1);
  ensureLayerSpan(editor, 'camera');
  editor.seek(time);
  if (!editor.layerFrameKeys('camera').some(key => key.tick === time)) editor.sheetInsertKey(['camera'], time);
  editor.seek(time);
  editor.setCameraValues(patch);
  return time;
}

function keysOf(editor, id) {
  return editor.layerFrameKeys(id).map(key => ({
    tick: key.tick,
    ease: key.interpolation ?? 'linear',
    ...(key.bezier ? {bezier: key.bezier} : {}),
    empty: Boolean(key.empty),
  }));
}

function sampleTicks(editor, count) {
  const total = Math.max(1, editor.totalTicks);
  const n = Math.max(1, Math.min(12, count ?? 6));
  if (n === 1) return [0];
  return Array.from({length: n}, (_, index) => Math.min(total - 1, Math.round(index * (total - 1) / (n - 1))));
}

async function transcodeWav(file) {
  const dir = await mkdtemp(path.join(tmpdir(), 'styk-wav-'));
  const output = path.join(dir, 'audio.wav');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ['-y', '-i', file, '-ac', '1', '-ar', '44100', output], {stdio: ['ignore', 'ignore', 'pipe']});
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => reject(new ToolError(`ffmpeg is required for audio that is not already a wav. ${explain(error)}`)));
      child.on('close', code => code === 0 ? resolve() : reject(new ToolError(`Could not read that audio. ${stderr.slice(-400)}`)));
    });
    return readFile(output);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

export function registerTools(server) {
  const read = (name, description, shape, fn) => server.registerTool(name, {description, inputSchema: shape}, args => answer(() => fn(args)));
  const write = (name, description, shape, fn, options) => server.registerTool(name, {
    description, inputSchema: {project: projectField, expect_revision: revisionField, ...shape},
  }, args => answer(() => edit(args, fn, options)));

  read('project_new',
    'Create a project the same way File → New does: the Blue stickman on a layer sheet, 24 fps. landscape is 960×540, portrait 540×960, square 720×720. The new project becomes the active one. Pass actor false to delete Blue and start with an empty stage.',
    {
      title: z.string().optional().describe('Project name stored in the file.'),
      canvas: z.enum(['landscape', 'portrait', 'square']).optional(),
      width: z.number().int().min(1).max(100000).optional(),
      height: z.number().int().min(1).max(100000).optional(),
      fps: z.number().int().min(1).max(1000).optional(),
      background: z.string().optional().describe('Hex color for the stage.'),
      actor: z.boolean().optional().describe('Keep the startup stickman. Default true.'),
    },
    async args => {
      await ensureWorkspace();
      const editor = createEditor();
      const canvas = canvasFrom(args);
      editor.load(createStartupDocument(canvas ? {canvas} : {}), args.title ?? 'Untitled animation');
      if (args.fps && args.fps !== editor.report.fps) editor.setFPS(args.fps);
      if (args.background) editor.importBackground({kind: 2, color: argb(args.background), name: 'Color'});
      if (args.actor === false && editor.object) editor.deleteFigure();
      editor.dirty = true;
      const project = adopt(editor, {kind: 'styk'});
      return result(project, {canvas: {width: editor.report.canvas_width, height: editor.report.canvas_height}, fps: editor.report.fps});
    });

  read('project_open',
    'Open a project from STYK_WORKSPACE and make it active. .styk, .stkz and .json use the app loader. .piv and .stk use the Python Pivot codec and fail clearly when Python or the codec is unavailable. The opened path is remembered and will not be overwritten unless a later save passes overwrite true.',
    {path: z.string().describe('File inside the workspace. Relative paths start at the workspace root.')},
    async args => {
      await ensureWorkspace();
      const loaded = await readProjectFile(args.path);
      const editor = createEditor();
      const name = loaded.document?._styk?.name || path.basename(loaded.path).replace(/\.[^.]+$/, '');
      editor.load(loaded.document, name);
      const project = adopt(editor, {path: loaded.path, kind: loaded.kind});
      return result(project, {path: loaded.path, kind: loaded.kind, figures: editor.report.figure_types.length});
    });

  read('project_list', 'List projects open in this server, and which one is active.', {}, () => ({
    active: activeProject()?.id ?? null,
    projects: listProjects().map(project => ({
      project: project.id, name: project.name, path: project.path, kind: project.kind, revision: project.revision, dirty: project.editor.dirty,
    })),
  }));

  read('project_files', 'List animation and figure files currently in the workspace.', {}, async () => {
    const root = await ensureWorkspace();
    const entries = await readdir(root, {withFileTypes: true});
    const files = [];
    for (const entry of entries) {
      if (entry.isFile() && /\.(styk|stkz|stykmov|json|piv|stk)$/i.test(entry.name)) files.push(entry.name);
      if (entry.isDirectory() && entry.name === 'figures') {
        const figures = await readdir(path.join(root, 'figures'));
        files.push(...figures.filter(name => /\.(stkz|styk)$/i.test(name)).map(name => path.join('figures', name)));
      }
    }
    return {workspace: root, files};
  });

  read('project_info',
    'Describe the active project: canvas, fps, length, figures, layers, playhead and revision. Pass expect_revision on a later edit to make sure nobody changed it in between.',
    {project: projectField},
    args => view(args, (project, editor) => result(project, {
      path: project.path,
      kind: project.kind,
      canvas: {width: editor.report.canvas_width, height: editor.report.canvas_height},
      fps: editor.report.fps,
      background: editor.evaluatedFrame.background_id,
      figures: editor.evaluatedFrame.objects.map(object => {
        const figure = figureOf(editor, object);
        return {name: figure?.name, unique_id: object.unique_id, layer: editor.layerForUid(object.unique_id), x: round(object.root_x), y: round(object.root_y), scale: object.scale ?? 1};
      }),
      layers: layerSummary(editor),
      can_undo: editor.canUndo,
      can_redo: editor.canRedo,
    })));

  read('project_timeline',
    'List keyframe ticks and easing for each layer, including scene and camera. Use this before retime, tween or inbetween edits.',
    {project: projectField},
    args => view(args, (project, editor) => {
      const sheet = editor.report._styk?.layerSheet;
      const ids = ['scene', 'camera', ...(editor.report._styk?.layers?.order ?? [])];
      return result(project, {
        duration: sheet?.duration ?? editor.totalTicks,
        tracks: ids.map(id => ({id, name: editor.getLayer(id)?.name ?? id, keys: keysOf(editor, id)})),
      });
    }));

  read('project_validate',
    'Run the app\'s scene validator on the open project. A valid result means the document matches what the editor can save and reopen.',
    {project: projectField},
    args => view(args, (project, editor) => {
      validateScene(editor.report);
      return result(project, {valid: true});
    }));

  write('project_save',
    'Save the project. The default format is .styk (the app\'s container). .json is the same document as plain JSON, which the loader also reads. .stkz saves one figure. .piv and .stk go through the Python Pivot codec. Existing files are left untouched unless overwrite is true, in which case the previous bytes are copied to path.bak first. Saving to a new path becomes the project\'s path.',
    {
      path: z.string().optional().describe('Destination inside the workspace. Default: the opened path, or the project name plus .styk.'),
      format: z.enum(['styk', 'stkz', 'json', 'piv', 'stk']).optional(),
      overwrite: z.boolean().optional().describe('Replace an existing file and keep a .bak. Default false.'),
      figure: z.string().optional().describe('Figure name or unique_id. Required for .stk, and used by .stkz when you want one figure rather than the whole set.'),
    },
    async (project, editor, args) => {
      await ensureWorkspace();
      const format = args.format ?? (args.path ? kindFor(args.path) : project.kind === 'json' ? 'json' : 'styk');
      const fallback = `${slug(project.name)}.${format === 'stkz' || format === 'stk' ? 'stkz' : format}`;
      const file = args.path ?? project.path ?? fallback;
      if (format === 'stk' || format === 'stkz') {
        const {uid} = args.figure ? actorObject(editor, args.figure) : {uid: editor.object?.unique_id};
        if (uid == null) throw new ToolError('Name the figure to export.');
        if (format === 'stk') {
          const document = editor.serialize();
          document._exportFigureTypeId = figureOf(editor, findActor(editor, String(uid))).figure_type_id;
          const written = await writeProjectFile(document, file.endsWith('.stk') ? file : file.replace(/\.[^.]+$/, '.stk'), {overwrite: args.overwrite, kind: 'stk'});
          return written;
        }
        const written = await writeFigureFile(editor.report, file, {uid, overwrite: args.overwrite});
        project.path = written.path;
        project.kind = written.kind;
        editor.markSaved();
        return written;
      }
      const written = await writeProjectFile(editor.serialize(), file, {overwrite: Boolean(args.overwrite), kind: format});
      project.path = written.path;
      project.kind = written.kind;
      editor.markSaved();
      return written;
    });

  read('project_close', 'Close an open project and free it. Unsaved changes are discarded here; save first.', {project: projectField}, args => {
    const project = closeProject(args.project);
    return {closed: project.id, active: activeProject()?.id ?? null};
  });

  read('seek', 'Move the playhead without changing the animation. Later edits land on this frame when they omit a tick.', {project: projectField, tick: z.number().int().nonnegative()}, args => view(args, (project, editor) => {
    editor.seek(Math.min(args.tick, Math.max(0, editor.totalTicks - 1)));
    return result(project);
  }));

  read('figure_list', 'List figures visible at the playhead, with root, scale, layer and unique_id.', {project: projectField, tick: tickField}, args => view(args, (project, editor) => {
    if (args.tick != null) editor.seek(Math.min(args.tick, Math.max(0, editor.totalTicks - 1)));
    return result(project, {figures: editor.evaluatedFrame.objects.map(object => describeActor(editor, object.unique_id))});
  }));

  read('figure_describe',
    'Describe one figure: segment names, lengths, colors, world joint positions, attached parts and IK. Use the joint names from this call in pose_set, figure_edit and figure_part_attach.',
    {project: projectField, actor: actorField, tick: tickField},
    args => view(args, (project, editor) => {
      if (args.tick != null) editor.seek(args.tick);
      const {uid} = actorObject(editor, args.actor);
      return {...describeActor(editor, uid), design: describeDesign(editor, uid)};
    }));

  write('figure_add',
    'Add another stickman with its own definition, so later parts and colors do not change the others. It stands on the default layer. Use figure_move_to_layer when it needs its own track.',
    {
      name: z.string().optional(),
      color: z.string().optional(),
      head_color: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      ground: z.number().optional().describe('Floor line. The feet are placed on it.'),
      scale: z.number().positive().optional(),
      pose: z.string().optional(),
      flip: z.boolean().optional(),
      layer: z.string().optional().describe('Existing layer id to move the new figure onto.'),
    },
    (project, editor, args) => {
      const spec = {name: args.name ?? 'Figure', color: args.color, headColor: args.head_color, scale: args.scale, x: args.x, y: args.y};
      const made = designFigure(editor, spec);
      const {uid, figure} = {uid: made.unique_id, figure: editor.figure};
      if (args.pose || args.flip || args.ground != null) {
        const degrees = resolveAngles({pose: args.pose ?? 'stand', flip: Boolean(args.flip)});
        const angles = segmentAngles(figure, degrees);
        const y = args.ground != null ? args.ground - (args.y == null ? 0 : 0) : args.y;
        poseAt(editor, uid, editor.tick, {x: args.x, y: args.ground != null ? args.ground - footDrop(figure, angles, args.scale ?? 1) : y, angles});
      }
      if (args.layer) {
        editor.assignFiguresToLayer([uid], args.layer);
        ensureLayerSpan(editor, args.layer);
      }
      return {unique_id: uid, name: figure.name};
    });

  write('figure_duplicate', 'Duplicate the selected figure, or the named one. The copy shares the definition, so use figure_add when the copy needs its own parts.', {actor: actorField.optional()}, (project, editor, args) => {
    if (args.actor) editor.select(actorObject(editor, args.actor).uid);
    editor.duplicateFigure();
    return {unique_id: editor.object?.unique_id, name: editor.figure?.name};
  });

  write('figure_delete', 'Delete a figure from the animation.', {actor: actorField}, (project, editor, args) => {
    const {uid, figure} = actorObject(editor, args.actor);
    editor.select(uid);
    editor.deleteFigure();
    return {deleted: uid, name: figure.name};
  });

  write('figure_transform',
    'Move, scale, rotate or mirror a figure with the editor\'s selection commands. x and y are the new hip position. rotate is degrees clockwise-positive in screen space (90 turns the figure toward screen-down). mirror horizontal flips left and right.',
    {
      actor: actorField,
      tick: tickField,
      x: z.number().optional(),
      y: z.number().optional(),
      scale: z.number().positive().optional().describe('Multiplier applied to the current scale.'),
      rotate: z.number().optional().describe('Degrees added to every joint angle.'),
      mirror: z.enum(['horizontal', 'vertical']).optional(),
    },
    (project, editor, args) => {
      const {uid, object} = actorObject(editor, args.actor);
      const tick = args.tick ?? editor.tick;
      if (args.x != null || args.y != null) {
        poseAt(editor, uid, tick, {x: args.x, y: args.y, label: 'Move figure'});
      } else editor.seek(tick);
      editor.select(uid);
      if (args.mirror) editor.mirrorSelection(args.mirror);
      if (args.rotate) editor.rotateSelection(degreesToRadians(args.rotate));
      if (args.scale) editor.scaleSelection(args.scale);
      return {unique_id: uid, root: {x: round(editor.object.root_x), y: round(editor.object.root_y)}, scale: editor.object.scale, from: {x: round(object.root_x), y: round(object.root_y)}};
    });

  write('figure_style',
    'Set a figure\'s color, opacity (0 to 1) or outline. Opacity lives on the figure. Layers do not have opacity.',
    {
      actor: actorField,
      color: z.string().optional().describe('Hex color applied to the whole figure.'),
      opacity: z.number().min(0).max(1).optional(),
      name: z.string().optional(),
      outline_width: z.number().min(0).optional(),
      outline_color: z.string().optional(),
    },
    (project, editor, args) => {
      const {uid} = actorObject(editor, args.actor);
      editor.select(uid);
      if (args.color || args.opacity != null) editor.setFigureColor(args.color, {opacity: args.opacity});
      if (args.name) editor.updateFigureStyle({name: args.name});
      if (args.outline_width != null || args.outline_color) editor.updateFigureStyle({
        ...(args.outline_width != null ? {outlineWidth: args.outline_width} : {}),
        ...(args.outline_color ? {outlineColor: args.outline_color} : {}),
      });
      return {unique_id: uid, name: editor.figure.name};
    });

  write('figure_rename', 'Rename a figure definition.', {actor: actorField, name: z.string()}, (project, editor, args) => {
    editor.select(actorObject(editor, args.actor).uid);
    editor.updateFigureStyle({name: args.name});
    return {name: editor.figure.name, unique_id: editor.object.unique_id};
  });

  read('pose_get', 'Read the posed figure at a frame: root, joint angles in degrees, and world positions.', {project: projectField, actor: actorField, tick: tickField}, args => view(args, (project, editor) => worldPose(editor, actorObject(editor, args.actor).uid, args.tick ?? editor.tick)));

  write('pose_set',
    'Pose a figure on its own key, then set the easing into the next key. Joint angles are absolute degrees and override the named pose. Inserting the key first is required: writing a pose into a held span would otherwise change the earlier key too.',
    {
      actor: actorField,
      tick: tickField,
      pose: z.string().optional().describe('A name from pose_list. Default stand when joints are omitted.'),
      joints: z.record(z.number()).optional().describe('Degree overrides. Keys are pose names (rightUpperArm) or segment names (Left forearm).'),
      lean: z.number().optional().describe('Degrees added to the torso, head and arms.'),
      flip: z.boolean().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      ground: z.number().optional().describe('Put the feet on this y. Overrides y.'),
      ease: z.string().optional().describe('Easing from this key forward. Default linear. ease-in-out becomes a smooth bezier.'),
    },
    (project, editor, args) => {
      const {uid, figure, object} = actorObject(editor, args.actor);
      const degrees = resolveAngles({pose: args.pose ?? (args.joints ? null : 'stand'), joints: args.joints, lean: args.lean ?? 0, flip: Boolean(args.flip)});
      const angles = segmentAngles(figure, degrees);
      const scale = object.scale ?? 1;
      const y = args.ground != null ? args.ground - footDrop(figure, angles, scale) : args.y;
      const tick = args.tick ?? editor.tick;
      poseAt(editor, uid, tick, {x: args.x, y, angles, label: args.pose ? `Pose ${args.pose}` : 'Pose'});
      editor.sheetSetEasing([editor.layerForUid(uid)], Math.round(tick), Math.round(tick), easingOf(args.ease ?? 'linear'));
      return {unique_id: uid, tick: Math.round(tick), pose: args.pose ?? 'custom'};
    });

  write('pose_ik_set',
    'Move a hand or foot to a world point. The solver bakes the result into joint angles and leaves the target unpinned, so a later tween will not fight it. Pass pin true to keep the target pinned. The joint is the end of the chain, usually a forearm or lower leg.',
    {
      actor: actorField,
      joint: z.string().describe('Segment name or id at the end of the chain, such as "Left forearm".'),
      x: z.number(),
      y: z.number(),
      tick: tickField,
      pin: z.boolean().optional(),
      chain_length: z.number().int().min(1).max(8).optional(),
    },
    (project, editor, args) => {
      const {uid, figure} = actorObject(editor, args.actor);
      const tick = args.tick ?? editor.tick;
      poseAt(editor, uid, tick, {label: 'IK key'});
      const index = figure.segments.findIndex(segment => segment.name === args.joint || String(segment.segment_id) === args.joint);
      const joint = index >= 0 ? index : editor.figure.segments.findIndex((_, i) => {
        try { return canonicalJoint(args.joint) === JOINTS[i]; } catch { return false; }
      });
      if (joint < 0) throw new ToolError(`No joint "${args.joint}".`);
      editor.select(uid, joint);
      editor.setNodeIK({enabled: true, pinned: false, ...(args.chain_length ? {chainLength: args.chain_length} : {})});
      editor.poseIKTarget(args.x, args.y);
      if (args.pin) editor.setNodeIK({pinned: true});
      return worldPose(editor, uid, tick);
    });

  write('pose_apply', 'Apply a named pose from the library at a frame. Same key rules as pose_set.', {
    actor: actorField, pose: z.string(), tick: tickField, flip: z.boolean().optional(), ease: z.string().optional(),
  }, (project, editor, args) => {
    const {uid, figure} = actorObject(editor, args.actor);
    const angles = segmentAngles(figure, resolveAngles({pose: args.pose, flip: Boolean(args.flip)}));
    const tick = args.tick ?? editor.tick;
    poseAt(editor, uid, tick, {angles, label: `Pose ${args.pose}`});
    editor.sheetSetEasing([editor.layerForUid(uid)], Math.round(tick), Math.round(tick), easingOf(args.ease ?? 'linear'));
    return {unique_id: uid, pose: args.pose, tick: Math.round(tick)};
  });

  write('pose_mirror', 'Mirror the figure left to right, or up and down, on its current key.', {
    actor: actorField, axis: z.enum(['horizontal', 'vertical']).optional(), tick: tickField,
  }, (project, editor, args) => {
    const {uid} = actorObject(editor, args.actor);
    const tick = args.tick ?? editor.tick;
    poseAt(editor, uid, tick, {label: 'Mirror'});
    editor.select(uid);
    editor.mirrorSelection(args.axis ?? 'horizontal');
    return {unique_id: uid, tick};
  });

  write('pose_reset', 'Stand the figure upright on a new key.', {actor: actorField, tick: tickField}, (project, editor, args) => {
    const {uid, figure} = actorObject(editor, args.actor);
    const tick = args.tick ?? editor.tick;
    poseAt(editor, uid, tick, {angles: segmentAngles(figure, resolveAngles({pose: 'stand'})), label: 'Stand'});
    return {unique_id: uid, pose: 'stand', tick};
  });

  read('pose_list', 'Names of the built-in poses. Angles face screen-right. flip in pose_set turns them around.', {}, () => ({
    poses: poseNames(),
    joints: JOINTS,
    note: 'Character left on the Blue figure is screen-right while it faces right. "Left forearm" and rightForearm mean that same arm.',
  }));

  read('keyframe_list', 'Keyframe ticks on one figure\'s layer, or on every layer when actor is omitted.', {project: projectField, actor: z.string().optional()}, args => view(args, (project, editor) => {
    const ids = args.actor ? [editor.layerForUid(actorObject(editor, args.actor).uid)] : ['scene', 'camera', ...editor.report._styk.layers.order];
    return {tracks: ids.map(id => ({id, name: editor.getLayer(id)?.name ?? id, keys: keysOf(editor, id)}))};
  }));

  write('keyframe_add',
    'Insert a key at a frame. With a pose or position, the key stores that pose. Without them, the key stores whatever is already on screen at that frame, which is how you pin an inbetween.',
    {actor: actorField, tick: z.number().int().nonnegative(), pose: z.string().optional(), x: z.number().optional(), y: z.number().optional(), ease: z.string().optional()},
    (project, editor, args) => {
      const {uid, figure} = actorObject(editor, args.actor);
      const angles = args.pose ? segmentAngles(figure, resolveAngles({pose: args.pose})) : undefined;
      poseAt(editor, uid, args.tick, {x: args.x, y: args.y, angles, label: 'Add key'});
      if (args.ease) editor.sheetSetEasing([editor.layerForUid(uid)], args.tick, args.tick, easingOf(args.ease));
      return {unique_id: uid, tick: args.tick};
    });

  write('keyframe_delete', 'Remove keys in a tick range on a figure\'s layer. The first key of a layer is kept by the sheet if deleting it would leave the track empty.', {
    actor: actorField, start: z.number().int().nonnegative(), end: z.number().int().nonnegative().optional(),
  }, (project, editor, args) => {
    const layer = editor.layerForUid(actorObject(editor, args.actor).uid);
    editor.sheetClearKeys([layer], args.start, args.end ?? args.start);
    return {layer, start: args.start, end: args.end ?? args.start};
  });

  write('keyframe_duplicate', 'Duplicate the key at a tick onto the next frame.', {actor: actorField, tick: tickField}, (project, editor, args) => {
    const layer = editor.layerForUid(actorObject(editor, args.actor).uid);
    const tick = args.tick ?? editor.tick;
    editor.sheetDuplicateFrameAfter([layer], tick);
    return {layer, tick};
  });

  write('keyframe_retime',
    'Move one key, or a range of keys, by a number of frames, or to an absolute tick. Positive by is later. The destination key is replaced.',
    {actor: actorField, start: z.number().int().nonnegative(), end: z.number().int().nonnegative().optional(), by: z.number().int().optional(), to: z.number().int().nonnegative().optional()},
    (project, editor, args) => {
      const layer = editor.layerForUid(actorObject(editor, args.actor).uid);
      const end = args.end ?? args.start;
      const delta = args.to != null ? args.to - args.start : args.by;
      if (!Number.isInteger(delta)) throw new ToolError('Pass by (a frame delta) or to (the new tick of start).');
      extendTo(editor, Math.max(editor.report._styk.layerSheet.duration, end + delta + 1));
      editor.sheetMoveFrames([layer], args.start, end, delta);
      return {layer, start: args.start + delta, end: end + delta};
    });

  write('tween_set',
    'Set easing on the keys from start through end, on one figure or on every figure layer. ease-in-out is saved as bezier [0.42, 0, 0.58, 1]. constant and hold freeze the pose until the next key.',
    {actor: z.string().optional(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative().optional(), ease: z.string()},
    (project, editor, args) => {
      const ids = args.actor ? [editor.layerForUid(actorObject(editor, args.actor).uid)] : [...editor.report._styk.layers.order];
      editor.sheetSetEasing(ids, args.start, args.end ?? args.start, easingOf(args.ease));
      return {layers: ids, ease: args.ease};
    });

  write('inbetween_insert',
    'Insert a key at a frame that does not have one, using the interpolated pose already on screen. The later keys stay where they are.',
    {actor: actorField, tick: z.number().int().positive()},
    (project, editor, args) => {
      const layer = editor.layerForUid(actorObject(editor, args.actor).uid);
      extendTo(editor, args.tick + 1);
      ensureLayerSpan(editor, layer);
      editor.seek(args.tick);
      editor.sheetInsertKey([layer], args.tick);
      return {layer, tick: args.tick};
    });

  read('layer_list', 'List user layers plus the permanent scene and camera tracks. Layers have no opacity.', {project: projectField}, args => view(args, (project, editor) => ({layers: layerSummary(editor)})));

  write('layer_add', 'Add a user layer and stretch it to the current scene length so new keys are not clipped.', {name: z.string().optional(), color: z.string().optional().describe('One of blue, violet, rose, orange, green, teal.')}, (project, editor, args) => {
    const layer = editor.createLayer(args.name);
    ensureLayerSpan(editor, layer.id);
    if (args.color) editor.setLayerColor([layer.id], layerColor(args.color));
    return {id: layer.id, name: layer.name};
  });

  write('layer_edit',
    'Rename, show, lock, color, reorder or set parallax on a layer. opacity is rejected: set it on the figure with figure_style. color is blue, violet, rose, orange, green, teal, or null to clear it. order is every user layer id.',
    {
      id: z.string().optional(),
      name: z.string().optional(),
      visible: z.boolean().optional(),
      locked: z.boolean().optional(),
      color: z.string().nullable().optional(),
      opacity: z.number().optional(),
      order: z.array(z.string()).optional(),
      parallax: z.object({enabled: z.boolean().optional(), x: z.number().optional(), y: z.number().optional(), linked: z.boolean().optional()}).optional(),
    },
    (project, editor, args) => {
      if (args.opacity != null) throw new ToolError('Layers do not have opacity. Use figure_style with opacity on the figure.');
      const id = args.id ?? editor.report._styk.layers.activeId;
      if (args.name) editor.renameLayer(id, args.name);
      if (args.visible != null) editor.setLayerVisible(id, args.visible);
      if (args.locked != null) editor.setLayerLocked(id, args.locked);
      if (args.color !== undefined) editor.setLayerColor([id], args.color == null ? null : layerColor(args.color));
      if (args.order) editor.reorderLayers(args.order);
      if (args.parallax) editor.setLayerParallax(id, args.parallax);
      return {id, layer: editor.getLayer(id)};
    });

  write('figure_move_to_layer', 'Move one or more figures onto a layer. The layer is extended to the scene length.', {
    actor: z.string().optional(), actors: z.array(z.string()).optional(), layer: z.string().describe('Layer id, such as layer-2.'),
  }, (project, editor, args) => {
    const names = args.actors ?? (args.actor ? [args.actor] : []);
    if (!names.length) throw new ToolError('Name the figures to move.');
    const uids = names.map(name => actorObject(editor, name).uid);
    editor.assignFiguresToLayer(uids, args.layer);
    ensureLayerSpan(editor, args.layer);
    return {layer: args.layer, figures: uids};
  });

  write('camera_key',
    'Key the camera so that x, y is the world point in the middle of the screen. zoom 1 fits the canvas and zoom 2 moves in. rotate is degrees. The values are converted into the file\'s pan and scale for you.',
    {tick: tickField, x: z.number().optional(), y: z.number().optional(), zoom: z.number().positive().optional(), rotate: z.number().optional(), ease: z.string().optional()},
    (project, editor, args) => {
      const tick = putCamera(editor, args.tick ?? editor.tick, lookCamera(editor, args));
      if (args.ease) editor.sheetSetEasing(['camera'], tick, tick, easingOf(args.ease));
      return {tick, zoom: args.zoom ?? 1};
    });

  write('camera_follow',
    'Follow one or more figures for a span of frames. The camera eases toward them; it does not glue itself to the hip on the first frame.',
    {actor: actorField, start: tickField, duration: z.number().int().positive().optional(), weight: z.number().min(0).max(1).optional().describe('How strongly this figure pulls the camera, from 0 to 1.')},
    (project, editor, args) => {
      const {uid} = actorObject(editor, args.actor);
      const start = Math.round(args.start ?? editor.tick);
      const id = editor.addCameraMotion('follow', {start, duration: args.duration, targets: [{uid, weight: args.weight ?? 1}]});
      return {id, start, follows: uid};
    });

  write('camera_shake',
    'Add a shake (or handheld, wobble, impact, pulse) on the camera. strength is 0 to 2. move_x and move_y are pixels.',
    {
      type: z.enum(['shake', 'handheld', 'wobble', 'impact', 'pulse']).optional(),
      start: tickField,
      duration: z.number().int().positive().optional(),
      strength: z.number().min(0).max(2).optional(),
      move_x: z.number().min(0).max(2000).optional(),
      move_y: z.number().min(0).max(2000).optional(),
    },
    (project, editor, args) => {
      const start = Math.round(args.start ?? editor.tick);
      const id = editor.addCameraMotion(args.type ?? 'shake', {start, duration: args.duration});
      const params = {};
      if (args.strength != null) params.strength = args.strength;
      if (args.move_x != null) params.moveX = args.move_x;
      if (args.move_y != null) params.moveY = args.move_y;
      if (Object.keys(params).length) editor.setCameraMotion(id, {params});
      return {id, type: args.type ?? 'shake', start};
    });

  write('text_add',
    'Add a text figure using the app\'s bundled Noto Sans. alignment is left, center or right. The text is outlined as curves, so it scales with the camera.',
    {
      text: z.string(), x: z.number().optional(), y: z.number().optional(), font_size: z.number().positive().optional(),
      color: z.string().optional(), align: z.enum(['left', 'center', 'right']).optional(), bold: z.boolean().optional(), name: z.string().optional(),
    },
    async (project, editor, args) => {
      const figure = await createTextFigure({
        text: args.text, fontSize: args.font_size ?? 42, color: parseHex(args.color ?? '#1c2430', 'color'),
        alignment: args.align ?? 'center', bold: Boolean(args.bold), name: args.name ?? 'Text',
      });
      const object = editor.importFigure(figure, {position: {x: args.x ?? editor.report.canvas_width / 2, y: args.y ?? 80}});
      return {unique_id: object.unique_id, name: editor.figure.name};
    });

  write('text_edit', 'Replace the wording or style of an existing text figure.', {
    actor: actorField, text: z.string(), font_size: z.number().positive().optional(), color: z.string().optional(), align: z.enum(['left', 'center', 'right']).optional(), bold: z.boolean().optional(),
  }, async (project, editor, args) => {
    const {uid, figure} = actorObject(editor, args.actor);
    const next = await createTextFigure({
      text: args.text, fontSize: args.font_size ?? 42, color: parseHex(args.color ?? '#1c2430', 'color'),
      alignment: args.align ?? 'center', bold: Boolean(args.bold), name: figure.name,
    });
    editor.select(uid);
    editor.replaceFigureDefinition(figure.figure_type_id, next, {label: 'Edit text'});
    return {unique_id: uid, text: args.text};
  });

  write('audio_add',
    'Import a wav from the workspace onto a new audio clip at a given time in seconds. Other formats are converted with ffmpeg when it is installed. The recording is stored in the project.',
    {path: z.string(), start: z.number().min(0).optional(), name: z.string().optional()},
    async (project, editor, args) => {
      const file = resolveInside(args.path);
      let bytes = await readFile(file);
      if (!(bytes[0] === 0x52 && bytes.toString('ascii', 8, 12) === 'WAVE')) bytes = await transcodeWav(file);
      const blob = new Blob([bytes]);
      const info = await inspectWave(blob);
      const peaks = await wavePeaks(info);
      const chunks = [];
      for (let offset = 0; offset < bytes.length; offset += AUDIO_CHUNK_BYTES) chunks.push({data_base64: Buffer.from(bytes.subarray(offset, offset + AUDIO_CHUNK_BYTES)).toString('base64')});
      const id = editor.importAudio({
        id: `sound-${randomBytes(8).toString('hex')}`,
        name: args.name ?? path.basename(file),
        size: bytes.length,
        duration: info.duration,
        chunks,
        peaks,
      }, {start: args.start ?? 0});
      return {clip: id, duration: info.duration};
    });

  read('audio_list', 'List audio tracks and clips in the project.', {project: projectField}, args => view(args, (project, editor) => {
    const state = audioState(editor.report);
    return {tracks: (state.tracks ?? []).map(track => ({id: track.id, name: track.name, mute: track.mute, clips: track.clips}))};
  }));

  write('audio_remove', 'Remove an audio clip by id.', {clip: z.string()}, (project, editor, args) => {
    editor.deleteAudioClip(args.clip);
    return {removed: args.clip};
  });

  write('background_set', 'Set the stage color from this frame forward. Hex, such as #f4f1ea.', {color: z.string(), tick: tickField}, (project, editor, args) => {
    if (args.tick != null) editor.seek(args.tick);
    editor.importBackground({kind: 2, color: argb(args.color), name: 'Color'});
    return {color: args.color, tick: editor.tick};
  });

  read('scenario_guide',
    'Explain the scene spec, the motion names, camera coordinates, and the limits of the file format. Call this before scenario_build when you are unsure of a field.',
    {}, () => ({guide: SCENARIO_GUIDE, motions: MOTIONS, poses: knownPoses(), canvases: CANVAS, bases: baseNames(), parts: listParts()}));

  server.registerTool('scenario_build', {
    description: 'Build a whole animation from one spec and load it, replacing the open project. When nothing is open, a project is created first. A snapshot of the previous project is kept. Call scenario_guide for the spec. Text captions use the bundled font. The result is a normal layer-sheet project: later tools can keep editing it.',
    inputSchema: {project: projectField, expect_revision: revisionField, spec: z.record(z.any()).describe('Scene spec. See scenario_guide.')},
  }, args => answer(async () => {
    if (!args.project && !activeProject()) {
      const editor = createEditor();
      editor.load(createStartupDocument(), args.spec?.title ?? 'Untitled animation');
      adopt(editor, {kind: 'styk'});
    }
    return edit(args, async (project, editor) => {
      const compiled = await compileScenario(args.spec);
      const name = compiled.document._styk?.name || project.name;
      editor.load(compiled.document, name);
      editor.dirty = true;
      return {cast: compiled.cast, seconds: round(editor.totalTicks / editor.report.fps, 3), ticks: editor.totalTicks, title: name};
    }, {snapshot: true, label: 'Before scenario'});
  }));

  write('scenario_append',
    'Add beats onto the open project without replacing it. Each beat uses the same motions as scenario_build. at is seconds; omit it to start at the playhead.',
    {beats: z.array(z.record(z.any())).describe('Beats with actor, motion, duration, to, at.')},
    (project, editor, args) => {
      const fps = editor.report.fps || 24;
      const applied = [];
      for (const beat of args.beats ?? []) {
        if (!beat.actor) continue;
        const state = actorState(editor, beat.actor);
        const parsed = {
          motion: beat.motion,
          duration: beat.duration ?? 1,
          to: beat.to,
          at: beat.at ?? editor.tick / fps,
          ground: beat.ground ?? beat.to?.y,
          flip: beat.flip,
        };
        const samples = motionSamples(state, parsed, fps);
        performSamples(editor, state.uid, samples);
        applied.push({actor: beat.actor, motion: beat.motion, frames: samples.length});
      }
      return {applied};
    });

  write('motion_apply',
    `Animate one figure in place. Motions: ${Object.keys(MOTIONS).join(', ')}. walk and run need to_x. Feet stay on the figure's current ground line. The cycle eases out into a stand and turns around when traveling left.`,
    {
      actor: actorField,
      motion: z.string(),
      duration: z.number().positive().optional(),
      at: z.number().min(0).optional().describe('Start time in seconds. Default: the playhead.'),
      to_x: z.number().optional(),
      to_y: z.number().optional(),
      ground: z.number().optional(),
    },
    (project, editor, args) => {
      const state = actorState(editor, args.actor);
      const fps = editor.report.fps || 24;
      const samples = motionSamples(state, {
        motion: args.motion,
        duration: args.duration ?? 1,
        at: args.at ?? editor.tick / fps,
        to: args.to_x == null ? undefined : {x: args.to_x, y: args.to_y},
        ground: args.ground,
      }, fps);
      performSamples(editor, state.uid, samples);
      return {unique_id: state.uid, motion: args.motion, keys: samples.map(sample => sample.frame)};
    });

  read('motion_list', 'Describe the built-in motions and the poses they use.', {}, () => ({motions: MOTIONS, poses: knownPoses()}));

  read('preview_frames',
    'Render a contact sheet of the project and return it as an image. ticks chooses frames; otherwise a handful of frames spread across the whole scene are used. width and height scale the canvas, letterboxed. The reply names the renderer: browser when headless Chrome painted the geometry, otherwise the built-in rasterizer. Set STYK_RENDER=software to force the rasterizer.',
    {
      project: projectField,
      ticks: z.array(z.number().int().nonnegative()).max(12).optional(),
      count: z.number().int().min(1).max(12).optional(),
      columns: z.number().int().min(1).max(6).optional(),
      width: z.number().int().min(2).max(1920).optional(),
      height: z.number().int().min(2).max(1920).optional(),
    },
    args => view(args, async (project, editor) => {
      const ticks = args.ticks ?? sampleTicks(editor, args.count ?? 6);
      const sheet = await renderSheet(editor, ticks, {columns: args.columns ?? Math.min(3, ticks.length), width: args.width, height: args.height});
      return result(project, {ticks, renderer: sheet.renderer, width: sheet.width, height: sheet.height, image: sheet.png});
    }));

  read('preview_gif',
    'Write a short GIF of the project into the workspace exports folder and return its path. The GIF is not inlined; use preview_frames for an image you can look at directly.',
    {project: projectField, fps: z.number().int().min(1).max(30).optional(), width: z.number().int().optional()},
    args => view(args, async (project, editor) => {
      const root = await ensureWorkspace();
      const width = evenDown(args.width ?? 480);
      const height = evenDown(Math.round(width * editor.report.canvas_height / editor.report.canvas_width));
      const fps = args.fps ?? 12;
      const step = Math.max(1, Math.round((editor.report.fps || 24) / fps));
      const pngs = [];
      let renderer = 'software';
      for (let tick = 0; tick < editor.totalTicks; tick += step) {
        const frame = await renderFrame(editor, tick, {width, height});
        renderer = frame.renderer;
        pngs.push(frame.png);
      }
      const file = path.join(root, 'exports', `${slug(project.name)}.gif`);
      await encodeSequence(pngs, file, {fps, format: 'gif'});
      return {path: file, frames: pngs.length, fps, renderer};
    }));

  read('export_video',
    'Export the project to an H.264 mp4 or a GIF. preset youtube is 1920×1080, shorts and tiktok are 1080×1920, gif is about 480px wide, canvas keeps the project size. Dimensions are made even for the encoder. The file is written under the workspace.',
    {
      project: projectField,
      path: z.string().optional(),
      format: z.enum(['mp4', 'gif']).optional(),
      preset: z.enum(['youtube', 'shorts', 'tiktok', 'gif', 'canvas']).optional(),
      fps: z.number().int().min(1).max(60).optional(),
    },
    args => view(args, async (project, editor) => {
      await ensureWorkspace();
      const format = args.format ?? (args.preset === 'gif' ? 'gif' : 'mp4');
      const size = presetSize(args.preset ?? (format === 'gif' ? 'gif' : 'canvas'), {width: editor.report.canvas_width, height: editor.report.canvas_height});
      const fps = args.fps ?? size.fps ?? editor.report.fps ?? 24;
      const step = Math.max(1, Math.round((editor.report.fps || 24) / fps));
      const pngs = [];
      let renderer = 'software';
      for (let tick = 0; tick < editor.totalTicks; tick += step) {
        const frame = await renderFrame(editor, tick, {width: size.width, height: size.height});
        renderer = frame.renderer;
        pngs.push(frame.png);
      }
      const file = resolveInside(args.path ?? path.join('exports', `${slug(project.name)}.${format}`));
      await encodeSequence(pngs, file, {fps, format});
      return {path: file, frames: pngs.length, fps, width: size.width, height: size.height, renderer, seconds: round(pngs.length / fps, 3)};
    }));

  write('history_undo', 'Undo the last editor command. A failed edit has already been undone for you.', {steps: z.number().int().min(1).max(50).optional()}, async (project, editor, args) => {
    const steps = args.steps ?? 1;
    for (let i = 0; i < steps && editor.canUndo; i++) await editor.undo();
    return {can_undo: editor.canUndo};
  });

  write('history_redo', 'Redo editor commands that were undone.', {steps: z.number().int().min(1).max(50).optional()}, async (project, editor, args) => {
    const steps = args.steps ?? 1;
    for (let i = 0; i < steps && editor.canRedo; i++) await editor.redo();
    return {can_redo: editor.canRedo};
  });

  read('history_list', 'List undo and redo labels with their revisions.', {project: projectField}, args => view(args, (project, editor) => ({
    undo: editor._undo.map((command, index) => ({index, label: command.label ?? command.kind, revision: command.afterRevision})),
    redo: editor._redo.map((command, index) => ({index, label: command.label ?? command.kind, revision: command.afterRevision})),
  })));

  write('snapshot_create', 'Remember the whole project. Up to eight snapshots are kept. scenario_build takes one automatically.', {label: z.string().optional()}, (project, editor, args) => {
    const shot = project.snapshot(args.label ?? 'snapshot');
    return {snapshot: shot.id, label: shot.label, revision: shot.revision};
  });

  read('snapshot_list', 'List snapshots for this project.', {project: projectField}, args => view(args, project => ({
    snapshots: project.snapshots.map(({id, label, revision, tick, created}) => ({id, label, revision, tick, created})),
  })));

  write('snapshot_restore',
    'Replace the open project with a snapshot. Loading clears the ordinary undo stack; take another snapshot first if you might want to come back.',
    {snapshot: z.string()},
    (project, editor, args) => {
      const shot = project.restore(args.snapshot);
      editor.dirty = true;
      return {restored: shot.id, label: shot.label};
    });

  read('diff_since',
    'Compare figure positions and joint angles at the playhead with a snapshot, without changing the open project.',
    {project: projectField, snapshot: z.string()},
    args => view(args, (project, editor) => {
      const shot = project.snapshots.find(item => item.id === args.snapshot);
      if (!shot) throw new ToolError(`No snapshot "${args.snapshot}".`);
      const other = createEditor();
      other.load(structuredClone(shot.document), 'snapshot');
      other.seek(Math.min(editor.tick, Math.max(0, other.totalTicks - 1)));
      const after = new Map(editor.evaluatedFrame.objects.map(object => [object.unique_id, object]));
      const changes = [];
      for (const before of other.evaluatedFrame.objects) {
        const next = after.get(before.unique_id);
        if (!next) { changes.push({unique_id: before.unique_id, change: 'removed'}); continue; }
        const moved = Math.hypot(next.root_x - before.root_x, next.root_y - before.root_y) > 0.5;
        const posed = (before.angles ?? []).some((angle, index) => Math.abs(angle - (next.angles?.[index] ?? angle)) > 0.01);
        if (moved || posed) changes.push({unique_id: before.unique_id, moved, posed, from: {x: round(before.root_x), y: round(before.root_y)}, to: {x: round(next.root_x), y: round(next.root_y)}});
      }
      return {snapshot: shot.id, changes};
    }));

  write('figure_design',
    'Design a figure from a short description and add it to the project. base is stickman, chibi, tall or bulky. head is default, round, oval or square. parts are ids from parts_list. Proportions are multipliers for head, torso, arms and legs. The figure gets its own definition.',
    {spec: z.record(z.any()).describe('Criteria: name, base, color, headColor, thickness, proportions, head, parts, x, y, scale.')},
    (project, editor, args) => designFigure(editor, args.spec ?? {}));

  read('figure_preview',
    'Render a contact sheet of one figure in a few poses, without changing the project. Returned as an image.',
    {project: projectField, actor: actorField, poses: z.array(z.string()).max(6).optional()},
    args => view(args, async (project, editor) => {
      const {uid, figure} = actorObject(editor, args.actor);
      const copy = createEditor();
      copy.load(nativeFigureDocument(editor.report, {figureUid: uid, tick: editor.tick}), figure.name);
      const poses = args.poses ?? ['stand', 'walk_contact_a', 'wave_a'];
      const ticks = [];
      poses.forEach((pose, index) => {
        const angles = segmentAngles(copy.figure, resolveAngles({pose}));
        poseAt(copy, copy.object.unique_id, index * 8, {angles, label: pose});
        ticks.push(index * 8);
      });
      const sheet = await renderSheet(copy, ticks, {columns: Math.min(3, ticks.length), width: 320, height: 320});
      return {poses, renderer: sheet.renderer, image: sheet.png};
    }));

  write('figure_edit',
    'Change one segment\'s length, thickness, color or absolute angle in degrees. angle writes a pose key at tick. length and thickness change the shared definition.',
    {
      actor: actorField, segment: z.string(), length: z.number().min(0).optional(), thickness: z.number().min(0).optional(),
      color: z.string().optional(), angle: z.number().optional(), tick: tickField,
    },
    (project, editor, args) => {
      const {uid, figure} = actorObject(editor, args.actor);
      const index = segmentIndex(figure, args.segment);
      if (args.angle != null) {
        const angles = editor.object.angles.slice();
        angles[index] = degreesToRadians(args.angle);
        poseAt(editor, uid, args.tick ?? editor.tick, {angles, label: 'Edit joint'});
      }
      editor.select(uid, index);
      const patch = {};
      if (args.length != null) patch.length = args.length;
      if (args.thickness != null) patch.thickness = args.thickness;
      if (args.color) patch.color_rgb = parseHex(args.color, 'color');
      if (Object.keys(patch).length) editor.updateSegment(patch);
      return {unique_id: uid, segment: figure.segments[index].name ?? args.segment};
    });

  write('figure_part_attach', 'Attach a library part to a figure. It follows the anchor joint. Call parts_list for ids.', {actor: actorField, part: z.string()}, (project, editor, args) => {
    const {uid} = actorObject(editor, args.actor);
    return attachPart(editor, uid, args.part);
  });

  write('figure_part_detach', 'Remove an attached part, including the segments and fills it added.', {actor: actorField, part: z.string()}, (project, editor, args) => {
    const {uid} = actorObject(editor, args.actor);
    return detachPart(editor, uid, args.part);
  });

  write('figure_ik_setup',
    'Turn IK on or off for a joint. chain_length is how many bones the solver may move (2 reaches a hand from the upper arm). pin keeps the target locked while the body moves. bend is -1, 0 or 1.',
    {
      actor: actorField, joint: z.string(), enabled: z.boolean().optional(), pinned: z.boolean().optional(),
      chain_length: z.number().int().min(1).max(8).optional(), stretch: z.boolean().optional(), bend: z.number().int().min(-1).max(1).optional(),
    },
    (project, editor, args) => {
      const {uid, figure} = actorObject(editor, args.actor);
      editor.select(uid, segmentIndex(figure, args.joint));
      const patch = {};
      if (args.enabled != null) patch.enabled = args.enabled;
      if (args.pinned != null) patch.pinned = args.pinned;
      if (args.chain_length != null) patch.chainLength = args.chain_length;
      if (args.stretch != null) patch.allowStretch = args.stretch;
      if (args.bend != null) patch.bendDirection = args.bend;
      if (!Object.keys(patch).length) patch.enabled = true;
      editor.setNodeIK(patch);
      return {unique_id: uid, joint: args.joint, ...patch};
    });

  write('figure_library_save',
    'Save one figure as a reusable .stkz in the workspace figures folder. The file is a single-frame figure the app can import.',
    {actor: actorField, name: z.string().optional(), overwrite: z.boolean().optional()},
    async (project, editor, args) => {
      await ensureWorkspace();
      const {uid, figure} = actorObject(editor, args.actor);
      const file = path.join('figures', `${slug(args.name ?? figure.name)}.stkz`);
      return writeFigureFile(editor.report, file, {uid, tick: editor.tick, overwrite: Boolean(args.overwrite)});
    });

  read('figure_library_list', 'List reusable figures saved in the workspace figures folder.', {}, async () => {
    const root = await ensureWorkspace();
    const dir = path.join(root, 'figures');
    const names = await readdir(dir).catch(() => []);
    return {files: names.filter(name => /\.(stkz|styk)$/i.test(name)).map(name => path.join('figures', name))};
  });

  write('figure_library_load', 'Load a saved figure file into the project at a position.', {
    path: z.string(), x: z.number().optional(), y: z.number().optional(),
  }, async (project, editor, args) => {
    const loaded = await readProjectFile(args.path);
    const object = editor.importFigure(loaded.document, {position: {x: args.x ?? editor.report.canvas_width / 2, y: args.y ?? editor.report.canvas_height / 2}});
    return {unique_id: object.unique_id, name: editor.figure?.name, path: loaded.path};
  });

  read('parts_list',
    'List parts that figure_design and figure_part_attach can add. Bases are stickman, chibi, tall and bulky. Heads, hair, hats and props are anchored to a joint and follow it.',
    {}, () => ({bases: baseNames(), parts: listParts(), anchor_note: 'Left forearm is the character\'s left hand, on the right of the screen when the figure faces right.'}));
}

function layerSummary(editor) {
  const state = editor.report._styk?.layers;
  if (!state) return [];
  const fixed = ['scene', 'camera'].map(id => ({id, ...(state.fixed?.[id] ?? {visible: true, locked: false}), kind: id}));
  const users = state.order.map(id => ({id, ...state.byId[id], kind: 'layer', color: state.byId[id].color ? LAYER_COLORS[state.byId[id].color] ?? state.byId[id].color : null}));
  return [...fixed, ...users];
}

function layerColor(name) {
  const key = String(name).toLowerCase();
  if (Object.hasOwn(LAYER_COLORS, key)) return key;
  const match = Object.entries(LAYER_COLORS).find(([, hex]) => hex.toLowerCase() === key);
  if (match) return match[0];
  throw new ToolError(`Layer color must be one of ${Object.keys(LAYER_COLORS).join(', ')}.`);
}

function segmentIndex(figure, name) {
  const text = String(name).trim();
  const byId = figure.segments.findIndex(segment => String(segment.segment_id) === text || segment.name?.toLowerCase() === text.toLowerCase());
  if (byId >= 0) return byId;
  try {
    const index = JOINTS.indexOf(canonicalJoint(text));
    if (index >= 0 && figure.segments[index]) return index;
  } catch { /* named segment */ }
  throw new ToolError(`No segment "${name}".`);
}

function footDrop(figure, angles, scale) {
  let lowest = 0;
  const at = new Map([[0, {x: 0, y: 0}]]);
  figure.segments.forEach((segment, index) => {
    const start = at.get(segment.parent_id) ?? {x: 0, y: 0};
    const angle = angles[index] ?? segment.angle_rad;
    const length = segment.length * scale;
    const end = {x: start.x + length * Math.cos(angle), y: start.y + length * Math.sin(angle)};
    at.set(segment.segment_id, end);
    const pad = segment.segment_kind?.startsWith('circle') ? length / 2 : (segment.thickness * scale) / 2;
    lowest = Math.max(lowest, end.y + pad, start.y + pad);
  });
  return lowest;
}

function slug(name) {
  const clean = String(name ?? 'animation').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return clean.slice(0, 60) || 'animation';
}

const evenDown = value => Math.max(2, value - (value % 2));

export async function shutdown() {
  await closeRenderer();
}

export {EDITOR_OPTIONS};
