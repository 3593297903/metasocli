import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const credential = 'local-test-only-seedance-abc123456';
export const model = res => 'seedance-2.5-face-full-5s-' + res;
const keys = {
  reference_image: 'referenceImages', reference_audio: 'referenceAudios', reference_video: 'referenceVideos',
  first_frame: 'first_frame_image', last_frame: 'last_frame_image',
};

export async function startProvider(outputVideos) {
  const cases = new Map();
  function newCase(name, options = {}) {
    const item = { name, requests: [], tasks: new Map(), expected: new Map(), errors: [], options };
    cases.set(name, item);
    return item;
  }
  function reply(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': Buffer.isBuffer(body) ? 'video/mp4' : 'application/json', ...headers });
    res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }
  async function receive(req, captureWire) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.headers['content-type']?.includes('multipart/form-data')) {
      const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const parts = [], formEntries = [];
      for (const [field, value] of form) {
        if (typeof value === 'string') {
          if (captureWire) formEntries.push({field,value,bytes:Buffer.byteLength(value),sha256:digest(value)});
          continue;
        }
        const bytes = Buffer.from(await value.arrayBuffer());
        const part = { field, sha256: digest(bytes), mime: value.type, name: value.name };
        parts.push(part);
        if (captureWire) formEntries.push({...part,bytes:bytes.length});
      }
      return { params: Object.fromEntries([...form].filter(([,v]) => typeof v === 'string')), parts, formEntries };
    }
    assert.match(req.headers['content-type'] ?? '', /application\/json/);
    return { params: JSON.parse(body.toString('utf8')), parts: [] };
  }
  async function handle(req, res, item, log) {
    const { options } = item;
    if (req.url.startsWith('/cdn/')) {
      assert.equal(req.headers.authorization, undefined, 'API credential reached the storage domain');
      const task = item.tasks.get(req.url.split('/').at(-1));
      assert.ok(task);
      log.taskId = task.id;
      return reply(res, 200, task.output);
    }
    assert.equal(req.headers.authorization, 'Bearer ' + credential);
    if (req.method === 'POST') {
      assert.equal(req.url, '/api/v1/videos');
      const { params, parts, formEntries } = await receive(req, options.captureWire);
      const expected = item.expected.get(params.prompt);
      assert.ok(expected, 'Unexpected prompt bytes on the wire: ' + JSON.stringify(params.prompt));
      assert.equal(params.model, model(params.resolution));
      assert.equal(params.ratio, '9:16');
      assert.equal(Number(params.duration), Math.ceil(expected.duration));
      assert.equal(params.context_ir_enabled, undefined);
      if (expected.assets.length && expected.assets.every(a => a.url)) {
        assert.equal(parts.length, 0);
        for (const [role,field] of Object.entries(keys)) {
          const matching = expected.assets.filter(a=>a.role===role);
          if (matching.length) assert.deepEqual(params[field], field.endsWith('_image') ? matching[0].url : matching.map(a=>a.url));
        }
      } else {
        assert.equal(parts.length, expected.assets.length);
        for (const [role, field] of Object.entries(keys)) {
          const received = parts.filter(p => p.field === field);
          const wanted = expected.assets.filter(a => a.role === role);
          assert.deepEqual(received.map(p=>[p.sha256,p.mime]), wanted.map(a=>[a.sha256,a.mime]), field);
          for (const part of received) {
            if (part.mime==='image/png') assert.match(part.name,/\.png$/i);
            if (part.mime==='image/jpeg') assert.match(part.name,/\.jpe?g$/i);
          }
        }
      }
      const id = 'task_' + randomUUID();
      const outputKey = [options.wrongResolution ?? params.resolution, params.duration,
        options.silentResult ? false : expected.requireAudio].join('-');
      const template = outputVideos.get(outputKey);
      assert.ok(template, 'No generated fixture ' + outputKey);
      const tag=Buffer.from(id), box=Buffer.alloc(8);
      box.writeUInt32BE(tag.length+8);box.write('free',4);
      const output=Buffer.concat([template,box,tag]);
      const task = { id, queries:0, downloads:0, receivedAt:log.now, output,
        ...(options.captureWire ? {receivedPrompt: params.prompt, formEntries} : {}),
        segmentId:expected.id, model:params.model, promptSha256:digest(params.prompt), parts };
      item.tasks.set(id, task);
      log.taskId = id;
      if (options.dropCreate) return req.socket.destroy();
      return reply(res,200,{[item.tasks.size % 2 ? 'id' : 'task_id']:id,status:'queued'});
    }
    assert.equal(req.method,'GET');
    const match = /^\/api\/v1\/videos\/([^/]+)(\/content)?$/.exec(req.url);
    assert.ok(match, 'Unrecognized route ' + req.url);
    const task = item.tasks.get(match[1]);
    assert.ok(task);
    log.taskId = task.id;
    if (match[2]) {
      task.downloads++;
      if (options.downloadFailure && (!options.allowDownload || task.downloads===1)) {
        options.onDownloadFailure?.(); return reply(res,503,{});
      }
      if (options.redirect) {
        res.writeHead(302, {location:'https://seedance-cdn.example/files/' + task.id});
        return res.end();
      }
      return reply(res,200,task.output);
    }
    task.queries++;
    if (options.holdQuery) { options.onHeld?.(); return; }
    if (options.query429 && task.queries===1) return reply(res,429,{},{'retry-after':'1'});
    if (options.badIdentity) return reply(res,200,{id:'task_unrelated',status:'completed',model:task.model});
    const elapsed = log.now-task.receivedAt;
    if (options.minutes && elapsed < options.minutes*60000) {
      // Keep the 39/40/41-minute boundary observable while skipping uneventful queue time.
      const advance = elapsed < 37*60000 ? 38*60000 : 0;
      log.status = 'processing';
      return reply(res,200,{id:task.id,status:'processing'},{'x-fixture-advance-ms':String(advance)});
    }
    log.status = 'completed';
    return reply(res,200,{id:task.id,status:'completed',model:task.model});
  }
  const server=createServer((req,res)=>{
    const item=cases.get(req.headers['x-fixture-scenario']);
    if(!item) { res.writeHead(400); res.end(); return; }
    const log={method:req.method,route:req.url,now:Number(req.headers['x-fixture-now'])};
    item.requests.push(log);
    res.on('finish',()=>{ log.httpStatus=res.statusCode; });
    res.on('close',()=>{ if(!res.writableFinished)log.disconnected=true; });
    handle(req,res,item,log).catch(e=>{item.errors.push(String(e.stack));if(!res.headersSent)reply(res,500,{});else res.destroy();});
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return { newCase, origin:'http://127.0.0.1:'+server.address().port, close:async()=>{
    server.closeAllConnections(); await new Promise(r=>server.close(r));
  } };
}
