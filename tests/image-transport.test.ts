import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type RequestListener } from 'node:http';
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { cleanup } from './helpers.js';
import { imageFixture, imageResponse, profile } from './image-api-helpers.js';
import { nativeFetch } from './offline.js';
import { createImagePlan } from '../src/images/planning.js';
import { runImages } from '../src/images/run.js';
import { YicImageClient } from '../src/images/client.js';
import { imageTransportFailure } from '../src/images/transport.js';
import { ImageProfile } from '../src/images/contracts.js';
import { readImagePlan } from '../src/images/store.js';

afterEach(cleanup);

it('defaults to 300 seconds and caps legacy frozen plans without changing their identity or transport',async()=>{
  expect(ImageProfile.parse({}).generationTimeoutMs).toBe(300000);
  const f=await imageFixture(),previous=getGlobalDispatcher();
  const {plan}=await createImagePlan(f.root,{episodes:['ep-1'],profile:{...profile,generationTimeoutMs:600000},submissionMode:'all-ready'});
  const deadlines:number[]=[],signalTimeout=AbortSignal.timeout.bind(AbortSignal);
  const signalSpy=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{deadlines.push(ms);return signalTimeout(ms);});
  const dispatchSpy=vi.spyOn(previous,'dispatch').mockImplementation(options=>{
    expect(options.headersTimeout).toBe(300000);expect(options.bodyTimeout).toBe(300000);return true;
  });
  let calls=0;
  try{
    const client=new YicImageClient('offline-key',async(_url,init)=>{
      calls++;
      const dispatcher=(init as RequestInit & {dispatcher:Dispatcher}).dispatcher;
      dispatcher.dispatch({origin:'https://api.yiciyuang.com',path:'/v1/images/generations',method:'POST',headersTimeout:1,bodyTimeout:1},{});
      return imageResponse();
    });
    const result=await runImages(f.root,plan.planId,true,{client});
    expect(result.summary.registered).toBe(1);expect(calls).toBe(1);
    expect(deadlines).toContain(300000);expect(deadlines).not.toContain(600000);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);expect(getGlobalDispatcher()).toBe(previous);
    const saved=await readImagePlan(f.root,plan.planId);
    expect(saved.planHash).toBe(plan.planHash);expect(saved.profile.generationTimeoutMs).toBe(600000);
  }finally{dispatchSpy.mockRestore();signalSpy.mockRestore();}
});

async function serverWith(handler: RequestListener) {
  const server=createServer(handler);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('No local listener');
  return {origin:`http://127.0.0.1:${address.port}`,close:async()=>{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }};
}

it('waits past the underlying header timeout without changing global transport, request body or retry count',async()=>{
  const f=await imageFixture(),previous=getGlobalDispatcher(),agent=new Agent({headersTimeout:100,bodyTimeout:100});
  const bodies:string[]=[],reply=await imageResponse().text();
  const server=await serverWith(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;bodies.push(body);
    const timer=setTimeout(()=>{if(!res.destroyed)res.writeHead(200,{'content-type':'application/json'}).end(reply);},2100);
    res.on('close',()=>clearTimeout(timer));
  });
  setGlobalDispatcher(agent);
  try {
    // The control fails before the same fake service responds; no real API or key is used.
    await expect(nativeFetch(server.origin+'/control',{method:'POST',body:'control',signal:AbortSignal.timeout(6000)}))
      .rejects.toMatchObject({cause:{code:'UND_ERR_HEADERS_TIMEOUT'}});
    const {plan}=await createImagePlan(f.root,{episodes:['ep-1'],profile:{...profile,generationTimeoutMs:6000},submissionMode:'all-ready'});
    let calls=0;
    const client=new YicImageClient('offline-key',async(url,init)=>{
      calls++;expect(url).toBe('https://api.yiciyuang.com/v1/images/generations');
      expect(init?.redirect).toBe('error');expect(getGlobalDispatcher()).toBe(agent);
      return nativeFetch(server.origin+'/v1/images/generations',init);
    });
    const result=await runImages(f.root,plan.planId,true,{client});
    expect(result.summary.registered).toBe(1);expect(calls).toBe(1);
    expect(JSON.parse(bodies[1]!)).toEqual({model:'gpt-image-2.5',prompt:'asset-000 完整图片提示词：保留所有汉字\n第二行，不改写。',quality:'medium',size:'1024x1024',n:1,response_format:'url'});
    expect(getGlobalDispatcher()).toBe(agent);
    await runImages(f.root,plan.planId,false,{client});expect(calls).toBe(1);
  }finally{setGlobalDispatcher(previous);await server.close();await agent.destroy();}
},25000);

it('keeps the configured total deadline, preserves unknown state, and does not POST again on resume',async()=>{
  const f=await imageFixture();let calls=0;
  const server=await serverWith(async(req,res)=>{for await(const _ of req){};const timer=setTimeout(()=>res.end('{}'),3500);res.on('close',()=>clearTimeout(timer));});
  try{
    const {plan}=await createImagePlan(f.root,{episodes:['ep-1'],profile:{...profile,generationTimeoutMs:1000},submissionMode:'all-ready'});
    const client=new YicImageClient('offline-key',async(_url,init)=>{calls++;return nativeFetch(server.origin+'/test',init);});
    const result=await runImages(f.root,plan.planId,true,{client});
    expect(result.summary.unknown).toBe(1);expect(calls).toBe(1);
    expect(result.items[0]).toMatchObject({error:{code:'IMAGE_TRANSPORT_UNKNOWN',message:expect.stringContaining('GENERATION_TIMEOUT')}});
    await runImages(f.root,plan.planId,false,{client});expect(calls).toBe(1);
  }finally{await server.close();}
});

it('retains incomplete-body timeout evidence and only exposes allowlisted transport diagnostics',async()=>{
  const f=await imageFixture();let calls=0;
  const server=await serverWith(async(req,res)=>{for await(const _ of req){};res.writeHead(200,{'content-type':'application/json'});res.write('{"data":[');});
  try{
    const {plan}=await createImagePlan(f.root,{episodes:['ep-1'],profile:{...profile,generationTimeoutMs:1000},submissionMode:'all-ready'});
    const client=new YicImageClient('offline-key',async(_url,init)=>{calls++;return nativeFetch(server.origin+'/test',init);});
    const result=await runImages(f.root,plan.planId,true,{client});
    expect(result.summary.unknown).toBe(1);expect(calls).toBe(1);
    expect(result.items[0]).toMatchObject({responseHeadersAt:expect.any(String),error:{code:'IMAGE_TRANSPORT_UNKNOWN'}});
  }finally{await server.close();}
  const privateError=new TypeError('Bearer secret-test https://private.example/signed',{cause:{code:'UND_ERR_SOCKET',message:'secret-test'}});
  try{imageTransportFailure(privateError,600000);}catch(error){
    expect((error as Error).message).toContain('UND_ERR_SOCKET');expect((error as Error).message).not.toMatch(/secret-test|private\.example/);
  }
});
