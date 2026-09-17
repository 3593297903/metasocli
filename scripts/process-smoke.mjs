import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, parse, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { initializeStory, importStory } from '../dist/core/project.js';
import { createPlan } from '../dist/core/planning.js';
import { listJobs } from '../dist/jobs/store.js';
import { submit } from '../dist/jobs/submit.js';
import { resume } from '../dist/jobs/resume.js';
import { sha256Hex } from '../dist/storage/canonical.js';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = await mkdtemp(join(tmpdir(), 'metasocli-process-'));
try {
  await mkdir(join(base, 'home'));
  for (const mode of ['unknown', 'receipt']) {
    const root = join(base, mode), source = join(base, `${mode}.txt`), text = '林舟：完整台词。\n';
    await writeFile(source, text); await initializeStory(root, mode);
    await importStory(root, { episodeId: 'ep-1', kind: 'video-prompts', source, segments: [{ id: 's1', start: 0, end: text.length, duration: 6 }] });
    const plan = await createPlan(root, 'ep-1');
    const permissions = process.platform === 'win32' && parse(packageRoot).root.toLowerCase() !== parse(base).root.toLowerCase()
      ? ['--permission', `--allow-fs-read=${packageRoot}`, `--allow-fs-read=${parse(base).root}`, `--allow-fs-write=${base}`] : [];
    const env = { ...process.env, PATH: dirname(process.execPath), USERPROFILE: join(base, 'home'), HOME: join(base, 'home') };
    delete env.METASO_API_KEY;
    const child = spawn(process.execPath, [...permissions, join(packageRoot, 'scripts/process-worker.mjs'), root, plan.planId, mode], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let diagnostics = ''; child.stderr.on('data', data => { diagnostics += String(data); });
    const exit = new Promise(resolveExit => child.once('exit', resolveExit));
    try {
      await new Promise((ready, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Worker checkpoint timed out: ${diagnostics}`)), 20000);
        child.once('message', message => { clearTimeout(timeout); assert.equal(message.checkpoint, mode); ready(); });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Worker exited before checkpoint: ${diagnostics}`)); });
      });
    } finally { child.kill('SIGKILL'); await exit; }
    const job = (await listJobs(root))[0]; assert.ok(job);
    let creates = 0;
    const client = { async create() { creates++; throw new Error('Must never create during recovery'); }, async query(taskId) { assert.equal(taskId, 'process-task'); return { taskId, status: 'running', rawStatus: 'running', evidence: { sha256: sha256Hex('{}'), response: {} } }; } };
    if (mode === 'unknown') {
      assert.equal(job.status, 'submit_unknown');
      assert.equal((await submit(root, plan.planId, 's1', true, { client })).status, 'submit_unknown');
    } else {
      assert.equal(job.taskId, 'process-task');
      assert.equal((await resume(root, job.operationId, { client }, { maxPolls: 1, download: false, observeOnly: true })).status, 'running');
    }
    assert.equal(creates, 0);
    console.log(`PASS process termination at ${mode}; no duplicate creation; PATH excludes old CLI${permissions.length ? '; old source blocked by Node permissions' : ''}`);
  }
} finally {
  const actual = await realpath(base), parent = await realpath(tmpdir()), rel = relative(parent, actual);
  if (!rel.startsWith('metasocli-process-') || rel.includes('..') || isAbsolute(rel)) throw new Error('Unsafe test cleanup target');
  await rm(actual, { recursive: true, force: true });
}
