import {Editor, EDITOR_OPTIONS, validateScene} from './core.js';
import {ToolError, explain} from './errors.js';

const projects = new Map();
let activeId = null;
let sequence = 0;
let gate = Promise.resolve();

export function resetStore() {
  projects.clear();
  activeId = null;
  sequence = 0;
  gate = Promise.resolve();
}

export function listProjects() {
  return [...projects.values()];
}

export function activeProject() {
  return activeId ? projects.get(activeId) ?? null : null;
}

export function requireProject(id) {
  if (id == null || id === '') {
    const current = activeProject();
    if (!current) throw new ToolError('No project is open. Call project_new or project_open first.', {code: 'no_project'});
    return current;
  }
  const project = projects.get(String(id));
  if (!project) {
    const open = [...projects.keys()];
    throw new ToolError(`No open project "${id}".${open.length ? ` Open: ${open.join(', ')}.` : ''}`, {code: 'unknown_project'});
  }
  return project;
}

export function adopt(editor, {path = null, kind = 'styk'} = {}) {
  const id = `p${++sequence}`;
  const project = new Project(editor, {id, path, kind});
  projects.set(id, project);
  activeId = id;
  return project;
}

export function closeProject(id) {
  const project = requireProject(id);
  projects.delete(project.id);
  if (activeId === project.id) activeId = [...projects.keys()].at(-1) ?? null;
  return project;
}

export function createEditor() {
  return new Editor(EDITOR_OPTIONS);
}

export class Project {
  constructor(editor, {id, path, kind}) {
    this.id = id;
    this.editor = editor;
    this.path = path;
    this.kind = kind;
    this.snapshots = [];
    this.nextSnap = 1;
    this.chain = Promise.resolve();
  }
  get revision() { return this.editor.revision; }
  get name() { return this.editor.name || 'Untitled animation'; }

  snapshot(label = 'snapshot') {
    const entry = {
      id: `s${this.nextSnap++}`,
      label: String(label).slice(0, 80),
      revision: this.revision,
      tick: this.editor.tick,
      created: new Date().toISOString(),
      document: this.editor.serialize(),
    };
    this.snapshots.push(entry);
    while (this.snapshots.length > 8) this.snapshots.shift();
    return entry;
  }

  restore(id) {
    const entry = this.snapshots.find(item => item.id === id);
    if (!entry) throw new ToolError(`No snapshot "${id}".`, {code: 'unknown_snapshot'});
    this.editor.load(structuredClone(entry.document), this.name);
    this.editor.seek(Math.min(entry.tick, Math.max(0, this.editor.totalTicks - 1)));
    return entry;
  }
}

/** Serialize every tool on this process, then on the project, so undo stays ordered. */
export function enqueue(project, fn) {
  const previous = project?.chain ?? Promise.resolve();
  const run = gate.then(() => previous.then(fn, fn));
  const settled = run.then(() => {}, () => {});
  gate = settled;
  if (project) project.chain = settled;
  return run;
}

async function revertTo(editor, undoLength, revision) {
  let guard = 0;
  while (editor.canUndo && editor._undo.length > undoLength && guard++ < 400) {
    await editor.undo();
    if (editor.revision === revision && editor._undo.length <= undoLength) break;
  }
}

/**
 * Run editor commands. On failure, undo back to the entry point and surface the error.
 * `snapshot` keeps a full document the caller can restore after a large op.
 */
export async function change(project, fn, {snapshot = false, label = 'edit', expectRevision = null} = {}) {
  if (expectRevision != null && expectRevision !== project.revision) {
    throw new ToolError(`Project ${project.id} is at revision ${project.revision}, not ${expectRevision}. Read it again with project_info, then retry.`, {code: 'stale_revision'});
  }
  const shot = snapshot ? project.snapshot(label) : null;
  const undoLength = project.editor._undo.length;
  const revision = project.revision;
  try {
    const value = await fn(project.editor);
    validateScene(project.editor.report);
    return {value, snapshot: shot?.id ?? null};
  } catch (error) {
    try { await revertTo(project.editor, undoLength, revision); }
    catch (undoError) {
      if (shot) {
        try { project.restore(shot.id); } catch { /* the original error is the one to report */ }
      }
      throw new ToolError(`${explain(error)} Undo also failed: ${explain(undoError)}`, {code: 'rollback_failed'});
    }
    if (project.revision !== revision && shot) {
      try { project.restore(shot.id); } catch { /* still report the edit error */ }
    }
    throw error instanceof ToolError ? error : new ToolError(explain(error), {code: error.code || 'edit_failed'});
  }
}

export function result(project, extra = {}) {
  return {
    project: project.id,
    name: project.name,
    revision: project.revision,
    dirty: project.editor.dirty,
    tick: project.editor.tick,
    total_ticks: project.editor.totalTicks,
    seconds: Math.round((project.editor.totalTicks / (project.editor.report.fps || 24)) * 1000) / 1000,
    ...extra,
  };
}
