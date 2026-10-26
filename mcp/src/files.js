import {readFile, access, mkdtemp, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodeDocument, buildContainerV2, normalizeDecodedDocument, nativeFigureDocument} from './core.js';
import {ToolError, explain} from './errors.js';
import {resolveInside, atomicWrite, writeReplacing} from './paths.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BRIDGE = path.join(ROOT, 'codecs', 'codec_bridge.py');

export function kindFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.styk' || ext === '.stkz' || ext === '.stykmov' || ext === '.json' || ext === '.piv' || ext === '.stk') return ext.slice(1);
  throw new ToolError('Use a .styk, .stkz, .json, .piv, or .stk file.');
}

export async function readProjectFile(file) {
  const abs = resolveInside(file);
  const kind = kindFor(abs);
  if (kind === 'piv' || kind === 'stk') {
    const response = await pythonCodec({operation: 'load', path: abs});
    return {document: response.document, kind, path: abs};
  }
  const bytes = await readFile(abs);
  if (kind === 'json') return {document: JSON.parse(bytes.toString('utf8')), kind, path: abs};
  const decoded = await decodeDocument(bytes, kind === 'stkz' || kind === 'stykmov' ? kind : 'styk');
  return {document: normalizeDecodedDocument(decoded.document, kind === 'stkz' || kind === 'stykmov' ? kind : 'styk'), kind, path: abs};
}

export async function writeProjectFile(document, file, {overwrite = false, kind} = {}) {
  const abs = resolveInside(file);
  const format = kind ?? kindFor(abs);
  let exists = true;
  try { await access(abs); }
  catch { exists = false; }
  if (exists && !overwrite) {
    throw new ToolError(`${path.basename(abs)} already exists. Pass overwrite: true to replace it. The previous file is kept beside it as a .bak.`, {code: 'exists'});
  }
  const payload = await bytesFor(document, format, abs);
  if (payload == null) return {path: abs, kind: format, bytes: (await readFile(abs)).byteLength, backup: exists ? `${abs}.bak` : null};
  if (exists) await writeReplacing(abs, payload);
  else await atomicWrite(abs, payload);
  return {path: abs, kind: format, bytes: payload.byteLength, backup: exists ? `${abs}.bak` : null};
}

async function bytesFor(document, format, abs) {
  if (format === 'json') return Buffer.from(JSON.stringify(document));
  if (format === 'styk' || format === 'stkz' || format === 'stykmov') return Buffer.from(await buildContainerV2(document, format));
  if (format === 'piv' || format === 'stk') {
    const plain = JSON.parse(JSON.stringify(document));
    await pythonCodec({operation: 'save', document: plain, destination: abs});
    return null;
  }
  throw new ToolError(`Cannot write format "${format}".`);
}

export async function writeFigureFile(report, file, {uid, tick = 0, overwrite = false} = {}) {
  const document = nativeFigureDocument(report, {figureUid: uid, tick});
  const target = file.endsWith('.stkz') || file.endsWith('.styk') ? file : `${file}.stkz`;
  return writeProjectFile(document, target, {overwrite, kind: path.extname(target).slice(1) === 'styk' ? 'styk' : 'stkz'});
}

export async function pythonCodec(request) {
  const dir = await mkdtemp(path.join(tmpdir(), 'styk-mcp-'));
  const requestPath = path.join(dir, 'request.json');
  const responsePath = path.join(dir, 'response.json');
  try {
    await atomicWrite(requestPath, JSON.stringify(request));
    const result = await runPython(['--request', requestPath, '--response', responsePath]);
    let response;
    try { response = JSON.parse(await readFile(responsePath, 'utf8')); }
    catch { throw new ToolError(`Pivot codec did not return JSON. ${result.stderr}`.trim(), {code: 'codec'}); }
    if (!response.ok) throw new ToolError(response.error || 'Pivot codec failed.', {code: 'codec'});
    return response;
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [BRIDGE, ...args], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => reject(new ToolError(`Python is not available, so .piv and .stk import/export is off. ${explain(error)}`, {code: 'python_missing'})));
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}
