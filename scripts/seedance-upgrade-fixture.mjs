import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepare, initial, seedPath, save, receipt } from '../dist/seedance/store.js';
import { canonicalSha256, sha256Hex } from '../dist/storage/canonical.js';
import { writeJson } from '../dist/storage/io.js';
import { verifiedFiles } from '../dist/seedance/request.js';
import { SeedClient, encodeRequest } from '../dist/seedance/client.js';

// Reconstruct the old v1 serialized contract independently of the compatibility lookup.
// The legacy wire text really goes through the client's multipart POST to the loopback receiver.
export async function legacyOrder(root, model, drop=true) {
  const view=await prepare(root,model,1,{selection:{schemaVersion:1,episodes:[{episodeId:'ep-1',segmentIds:['s1']}]}});
  const {request,...row}=view.items[0];
  const prompt=request.prompt.replace(/参考图([1-9]\d*)/gu,'@图$1');
  const oldRequest={...request,prompt,promptHash:sha256Hex(prompt)};
  const {episodeId,segmentId}=row;
  const item={episodeId,segmentId,request:oldRequest,requestHash:canonicalSha256({projectId:view.projectId,episodeId,segmentId,request:oldRequest})};
  const body={version:1,projectId:view.projectId,model,concurrency:1,items:[item]};
  const plan={...body,batchId:randomUUID(),scopeHash:canonicalSha256(body)};
  await writeJson(await seedPath(root,'plans/'+plan.batchId+'.json'),plan);
  await writeJson(await seedPath(root,'scopes/'+plan.scopeHash+'.json'),plan.batchId);
  const job=initial(plan,item),client=await SeedClient.configured();
  job.status='submitting';job.credentialRef=client.credentialRef;await save(root,job);
  const payload=encodeRequest(oldRequest,await verifiedFiles(root,oldRequest));
  if(drop){
    await assert.rejects(client.create(model,payload));
    job.status='submit_unknown';job.lastError={code:'SUBMIT_UNKNOWN',message:'Fixture dropped original receipt.'};await save(root,job);
  }else await receipt(root,job,await client.create(model,payload));
  return {plan,job,item,current:view};
}
