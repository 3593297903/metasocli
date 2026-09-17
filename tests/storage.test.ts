import { mkdtemp, mkdir, writeFile, symlink, link, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { projectPath, safePath } from '../src/storage/paths.js';
import { atomicWrite, readStable } from '../src/storage/io.js';
const roots: string[] = [];
async function temp() { const p = await mkdtemp(join(tmpdir(), 'metasocli-test-')); roots.push(p); return p; }
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
it('rejects old roots, old source copies and path traversal before writes', async () => {
  const root = await temp();
  await expect(safePath('E:\\libcli\\anything')).rejects.toMatchObject({ code: 'LEGACY_ROOT' });
  await expect(projectPath(root, '../escape')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  await writeFile(join(root, 'story2libtv.yaml'), 'old');
  await expect(safePath(join(root, 'new/child'))).rejects.toMatchObject({ code: 'LEGACY_ROOT' });
  const source = await temp();
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'story-to-libtv' }));
  await expect(safePath(join(source, 'story'))).rejects.toMatchObject({ code: 'LEGACY_ROOT' });
});
it('rejects junctions and hardlinks; source copy remains independent', async () => {
  const root = await temp(), outside = await temp();
  await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(projectPath(root, 'linked/file')).rejects.toMatchObject({ code: 'LINK_PATH' });
  await writeFile(join(outside, 'file'), 'original');
  await link(join(outside, 'file'), join(root, 'alias'));
  await expect(atomicWrite(join(root, 'alias'), 'changed')).rejects.toMatchObject({ code: 'LINK_PATH' });
  expect(await readFile(join(outside, 'file'), 'utf8')).toBe('original');
});
it('atomically replaces and bounds file reads', async () => {
  const root = await temp();
  await mkdir(join(root, 'safe'));
  const file = join(root, 'safe/data');
  await atomicWrite(file, 'one'); await atomicWrite(file, 'two');
  expect((await readStable(file)).toString()).toBe('two');
  await expect(readStable(file, 2)).rejects.toMatchObject({ code: 'FILE_LIMIT' });
});
