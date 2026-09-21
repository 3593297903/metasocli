import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { submitContextIr, resumeContextIr } from '../dist/jobs/context-ir.js';
import { irPersistence, readIrOperation } from '../dist/jobs/context-ir-store.js';
import { createPlanFromContextIr, loadPlan } from '../dist/core/planning.js';
import { writeJson } from '../dist/storage/io.js';
import { sha256Hex } from '../dist/storage/canonical.js';
import { processReview } from './context-ir-process-review.mjs';
const [root, planId, mode, operationId] = process.argv.slice(2);
if (process.platform === 'win32' && process.permission) {
  try { await readFile('E:\\libcli\\package.json'); throw new Error('Old source unexpectedly readable'); }
  catch (error) { if (error.code !== 'ERR_ACCESS_DENIED') throw error; }
}
const evidence = { sha256: sha256Hex('{}'), response: {} };
const stop = async () => { process.send?.({ checkpoint: mode }); setInterval(() => {}, 1000); return new Promise(() => {}); };
try {
  if (mode === 'derive-only') {
    const operation = await readIrOperation(root, operationId);
    await createPlanFromContextIr(root, operationId, processReview(operation));
  } else {
    const plan = await loadPlan(root, planId), prompt = plan.segments[0].renderedPrompt;
    const client = {
      async createContextIr() { await appendFile(join(root, 'ir-create-count.txt'), 'create\n'); if (mode === 'ir-unknown') return stop(); return { taskId: 'ir-process-task', evidence }; },
      async queryContextIr(taskId) { return { taskId, model: 'MiniMax-H3', taskType: 'h3_context_ir', status: 'enhanced', rawStatus: 'succeeded', prompt, evidence }; },
    };
    let operation = await submitContextIr(root, planId, 's1', true, { client, persistence: { ...irPersistence,
      async operation(root, operation) { if (mode === 'ir-receipt' && operation.status === 'queued') return stop(); await irPersistence.operation(root, operation); },
    } });
    operation = await resumeContextIr(root, operation.operationId, { client, persistence: { ...irPersistence,
      async result(root, operation, prompt) { await irPersistence.result(root, operation, prompt); if (mode === 'ir-result') await stop(); },
    } });
    await createPlanFromContextIr(root, operation.operationId, processReview(operation), {
      async operation(root, value) {
        if (mode === 'ir-linked' && value.derived?.planHash) return stop();
        await irPersistence.operation(root, value);
        if (mode === 'ir-reserved' && value.derived && !value.derived.planHash) await stop();
      },
      async plan(root, plan) { await writeJson(join(root, `.metasocli/plans/${plan.planId}.json`), plan); if (mode === 'ir-plan') await stop(); },
    });
  }
} catch (error) {
  if (error.code === 'LOCK_BUSY') { process.send?.({ busy: true }); process.exitCode = 3; }
  else { console.error(error); process.exitCode = 1; }
}
