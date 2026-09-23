import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { cleanup, fixture } from './helpers.js';
import { readJson, writeJson } from '../src/storage/io.js';
import { canonicalSha256 } from '../src/storage/canonical.js';
import { acquireLease, liveLease, waitLease } from '../src/storage/locking.js';
afterEach(cleanup);
it('reads whole validated snapshots during atomic state replacement and retains fail-closed corruption checks',async()=>{
  const f=await fixture(),file=join(f.root,'state.json');
  const state=(revision:number)=>{const value={revision,body:String(revision).repeat(50000)};return {...value,hash:canonicalSha256(value)};};
  await writeJson(file,state(0));
  await Promise.all([
    (async()=>{for(let i=1;i<=20;i++)await writeJson(file,state(i));})(),
    (async()=>{for(let i=0;i<60;i++){const {hash,...value}=await readJson(file) as ReturnType<typeof state>;expect(hash).toBe(canonicalSha256(value));}})(),
  ]);
  await writeFile(file,'{corrupt');await expect(readJson(file)).rejects.toMatchObject({code:'INVALID_JSON'});
  await expect(readJson(join(f.root,'absent.json'))).rejects.toMatchObject({code:'ENOENT'});
},30000);
it('observes and waits for rapidly released leases without stealing ownership; malformed locks remain protected',async()=>{
  const f=await fixture(),file=join(f.root,'lease.lock');
  await Promise.all([
    (async()=>{for(let i=0;i<30;i++){const lease=await waitLease(file);await lease.assertOwned();await lease.release();}})(),
    (async()=>{for(let i=0;i<100;i++)await liveLease(file);})(),
  ]);
  await writeFile(file,'{corrupt');await expect(acquireLease(file)).rejects.toMatchObject({code:'LOCK_UNKNOWN'});
},30000);
