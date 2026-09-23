import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fail, isCode } from '../core/errors.js';
import { sameFileIdentity } from './file-identity.js';

const oldNames = new Set(['.story2libtv', '.story2libtv-runtime', '.story2libtv-work', '.libtv',
  'story-to-libtv', 'video-prompt-to-libtv', 'seedance-segment-prompt-engine', 'story-reference-image-builder']);
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
/** Identity for validated paths: Windows casing is immaterial; other platforms stay case-sensitive. */
export const pathIdentity = (value: string) => key(path.resolve(value));
export const samePath = (left: string, right: string) => pathIdentity(left) === pathIdentity(right);
export function contains(root: string, value: string): boolean {
  const rel = path.relative(key(path.resolve(root)), key(path.resolve(value)));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (e) { if (isCode(e, 'ENOENT')) return false; throw e; }
}
/** Fail closed for links, old story/source ancestors, Windows aliases and hardlinked files. */
export async function safePath(input: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try { return await inspectPath(input); }
    catch (error) {
      if (!isCode(error, 'PATH_CHANGED') || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}
async function inspectPath(input: string): Promise<string> {
  const full = path.resolve(input);
  if (process.platform === 'win32' && (full.startsWith('\\\\') || full.slice(3).includes(':') || /[. ](?:\\|$)/u.test(full))) {
    fail('UNSAFE_PATH', 'UNC paths, alternate streams and ambiguous Windows paths are not supported.');
  }
  if (contains('E:\\libcli', full)) fail('LEGACY_ROOT', 'The old source tree is read-only.');
  let current = path.parse(full).root;
  for (const part of full.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (oldNames.has(part.toLowerCase())) fail('LEGACY_ROOT', 'Old runtime and story directories cannot be managed.');
    let info;
    try { info = await lstat(current, { bigint: true }); } catch (e) { if (isCode(e, 'ENOENT')) continue; throw e; }
    if (info.isSymbolicLink()) fail('LINK_PATH', 'Symbolic links and directory junctions are not writable project paths.');
    let real: string;
    try { real = await realpath(current); }
    catch (error) { if (isCode(error, 'ENOENT')) fail('PATH_CHANGED', 'Path disappeared during validation; revalidate its current identity.'); throw error; }
    if (key(real) !== key(current)) {
      const after = await lstat(current, { bigint: true }).catch(error => { if (isCode(error, 'ENOENT')) return undefined; throw error; });
      // An unlinked/replaced Windows file may report its former path while the
      // lookup is in flight. Retry only when its exact identity actually changed.
      if (!after || !sameFileIdentity(info, after)) fail('PATH_CHANGED', 'Path identity changed during validation.');
      fail('LINK_PATH', 'Canonical path differs from the requested path.');
    }
    if (info.isFile() && info.nlink !== 1n) fail('LINK_PATH', 'Managed files must not be hardlinked.');
    if (!info.isDirectory()) continue;
    if (await exists(path.join(current, 'story2libtv.yaml')) || await exists(path.join(current, '.story2libtv'))) {
      fail('LEGACY_ROOT', 'Initialize a separate story directory; old stories are read-only.');
    }
    // A copied old source root is protected too, regardless of its directory name.
    const manifest = path.join(current, 'package.json');
    if (await exists(manifest)) {
      const meta = await lstat(manifest);
      if (meta.isFile() && !meta.isSymbolicLink() && meta.size < 64 * 1024) {
        let pkg: unknown;
        try { pkg = JSON.parse(await readFile(manifest, 'utf8')); } catch { continue; }
        if (pkg && typeof pkg === 'object' && 'name' in pkg && pkg.name === 'story-to-libtv') {
          fail('LEGACY_ROOT', 'Old package source and installation directories are read-only.');
        }
      }
    }
  }
  return full;
}
export async function projectPath(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => p === '..' || p === '.')) {
    fail('UNSAFE_PATH', 'Expected a portable project-relative path.');
  }
  const target = path.resolve(root, relative);
  if (!contains(root, target) || key(target) === key(path.resolve(root))) fail('UNSAFE_PATH', 'Path escapes project root.');
  return safePath(target);
}
export async function initializationPath(input: string): Promise<string> {
  const root = await safePath(input);
  if (key(root) === key(path.parse(root).root) || key(root) === key(homedir())) fail('UNSAFE_ROOT', 'Choose a dedicated story directory.');
  for (let current = root; current !== path.dirname(current); current = path.dirname(current)) {
    if (await exists(path.join(current, 'metasocli.yaml'))) fail('EXISTING_PROJECT', 'A story already exists at this root or an ancestor.');
  }
  return root;
}
