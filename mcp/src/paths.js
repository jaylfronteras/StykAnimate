import {mkdir, copyFile, rename, writeFile, unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {ToolError} from './errors.js';

export function workspaceDir() {
  return path.resolve(process.env.STYK_WORKSPACE || path.join(process.cwd(), 'stykanimate-workspace'));
}

export async function ensureWorkspace() {
  const root = workspaceDir();
  await mkdir(root, {recursive: true});
  await mkdir(path.join(root, 'figures'), {recursive: true});
  await mkdir(path.join(root, 'exports'), {recursive: true});
  return root;
}

/** Absolute path inside the workspace. Relative paths resolve from the workspace root. */
export function resolveInside(file) {
  if (file == null || String(file).trim() === '') throw new ToolError('A file path is required.');
  const root = workspaceDir();
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolError(`"${file}" is outside STYK_WORKSPACE (${root}). Set STYK_WORKSPACE to the folder the AI is allowed to read and write.`);
  }
  return abs;
}

export async function atomicWrite(file, data) {
  await mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/** Replace a file and keep the previous bytes beside it as path.bak. */
export async function writeReplacing(file, data) {
  try { await copyFile(file, `${file}.bak`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await atomicWrite(file, data);
}
