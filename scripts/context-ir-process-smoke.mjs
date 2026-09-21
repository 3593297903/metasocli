import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, parse, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { initializeStory, importStory } from '../dist/core/project.js';
import { createPlan, createPlanFromContextIr, validatePlan } from '../dist/core/planning.js';
import { submitContextIr, resumeContextIr } from '../dist/jobs/context-ir.js';
import { listIrOperations } from '../dist/jobs/context-ir-store.js';
import { sha256Hex } from '../dist/storage/canonical.js';
import { processReview } from './context-ir-process-review.mjs';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = await mkdtemp(join(tmpdir(), 'metasocli-ir-process-'));
try {
  await mkdir(join(base, 'home'));
  for (const mode of ['ir-unknown', 'ir-receipt', 'ir-result', 'ir-reserved', 'ir-plan', 'ir-linked']) {
    const root = join(base, mode), source = join(base, `${mode}.txt`), text = '林舟：完整台词。\n';
    await writeFile(source, text); await initializeStory(root, mode);
    await importStory(root, { episodeId: 'ep-1', kind: 'video-prompts', source, segments: [{ id: 's1', start: 0, end: text.length, duration: 6.963 }] });
    const plan = await createPlan(root, 'ep-1', 'h3-context-ir');
    const permissions = process.platform === 'win32' && parse(packageRoot).root.toLowerCase() !== parse(base).root.toLowerCase()
      ? ['--permission', `--allow-fs-read=${packageRoot}`, `--allow-fs-read=${parse(base).root}`, `--allow-fs-write=${base}`] : [];
    const env = { ...process.env, PATH: dirname(process.execPath), USERPROFILE: join(base, 'home'), HOME: join(base, 'home') }; delete env.METASO_API_KEY;
    function launch(workerMode, operationId = '') {
      const child = spawn(process.execPath, [...permissions, join(packageRoot, 'scripts/context-ir-process-worker.mjs'), root, plan.planId, workerMode, operationId], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
      let diagnostics = ''; child.stderr.on('data', data => { diagnostics += String(data); });
      const exited = new Promise(resolveExit => child.once('exit', resolveExit));
      const ready = new Promise((resolveReady, reject) => {
        const timeout = setTimeout(() => reject(new Error(`IR checkpoint timeout: ${diagnostics}`)), 20000);
        child.once('message', value => { clearTimeout(timeout); resolveReady(value); });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error(`IR worker exited before checkpoint: ${diagnostics}`)); });
      });
      return { child, exited, ready };
    }
    const worker = launch(mode);
    try {
      assert.equal((await worker.ready).checkpoint, mode);
      if (mode === 'ir-unknown' || mode === 'ir-reserved') {
        const operation = (await listIrOperations(root))[0];
        const competitor = launch(mode === 'ir-reserved' ? 'derive-only' : mode, operation.operationId);
        try { assert.equal((await competitor.ready).busy, true); assert.equal(await competitor.exited, 3); }
        finally { competitor.child.kill('SIGKILL'); await competitor.exited; }
      }
    } finally { worker.child.kill('SIGKILL'); await worker.exited; }
    const operation = (await listIrOperations(root))[0]; assert.ok(operation);
    let creates = 0;
    const client = { async createContextIr() { creates++; throw new Error('Recovery must not create'); }, async queryContextIr(taskId) {
      assert.equal(taskId, 'ir-process-task'); return { taskId, model: 'MiniMax-H3', taskType: 'h3_context_ir', status: 'enhanced', rawStatus: 'succeeded', prompt: text, evidence: { sha256: sha256Hex('{}'), response: {} } };
    } };
    if (mode === 'ir-unknown') {
      assert.equal((await submitContextIr(root, plan.planId, 's1', true, { client })).status, 'submit_unknown');
    } else {
      const enhanced = await resumeContextIr(root, operation.operationId, { client }); assert.equal(enhanced.status, 'enhanced');
      const derived = await createPlanFromContextIr(root, operation.operationId, processReview(enhanced));
      if (operation.derived) assert.equal(derived.planId, operation.derived.planId);
      assert.equal((await createPlanFromContextIr(root, operation.operationId, processReview(enhanced))).planHash, derived.planHash);
      await validatePlan(root, derived);
    }
    assert.equal(creates, 0); assert.equal((await readFile(join(root, 'ir-create-count.txt'), 'utf8')).trim(), 'create');
    console.log(`PASS ${mode}: process termination/recovery, one IR create, same derived identity; old CLI hidden${permissions.length ? ', old source access denied' : ''}`);
  }
} finally {
  const actual = await realpath(base), parent = await realpath(tmpdir()), rel = relative(parent, actual);
  if (!rel.startsWith('metasocli-ir-process-') || rel.includes('..') || isAbsolute(rel)) throw new Error('Unsafe IR test cleanup target');
  await rm(actual, { recursive: true, force: true });
}
