import { readFile } from 'node:fs/promises';
import { submit } from '../dist/jobs/submit.js';
import { persistence } from '../dist/jobs/store.js';
import { sha256Hex } from '../dist/storage/canonical.js';
const [root, planId, mode] = process.argv.slice(2);
if (process.platform === 'win32' && process.permission) {
  try { await readFile('E:\\libcli\\package.json'); throw new Error('Old source unexpectedly readable'); }
  catch (error) { if (error.code !== 'ERR_ACCESS_DENIED') throw error; }
}
const evidence = { sha256: sha256Hex('{}'), response: { task_id: 'process-task' } };
// Keep the process alive at an exact durable checkpoint until the parent terminates it.
const stop = async () => { process.send?.({ checkpoint: mode }); setInterval(() => {}, 1000); return new Promise(() => {}); };
await submit(root, planId, 's1', true, {
  client: {
    async create() { if (mode === 'unknown') return stop(); return { taskId: 'process-task', evidence }; },
    async query() { throw new Error('Worker must not query'); },
  },
  persistence: { ...persistence, async job(root, job) { if (mode === 'receipt' && job.status === 'queued') return stop(); await persistence.job(root, job); } },
});
