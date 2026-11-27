import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Use Codex's path-scoped skill settings. A name-scoped setting would affect
// the same entry in both the user and repository skill search paths.
export async function withSkillService(cwd, env, visit) {
  const p = spawn(env.METASOCLI_CODEX_BIN ?? 'codex', ['app-server','--stdio'], {
    cwd, env, windowsHide:true, stdio:['pipe','pipe','pipe'],
  });
  const lines=createInterface({input:p.stdout});
  p.stderr.resume();
  let active;
  let id=0;
  function rejectActive(error) { active?.reject(error); }
  p.once('error',rejectActive);
  p.once('exit',code=>rejectActive(Error('Skill service exited '+code)));
  p.stdin.on('error',rejectActive);
  lines.on('line',line=>{
    let msg;try {msg=JSON.parse(line);}catch{return;}
    if(!active || msg.id!==active.id) return;
    if(msg.error) active.reject(Error(msg.error.message));
    else active.resolve(msg.result);
  });
  function send(msg){p.stdin.write(JSON.stringify(msg)+'\n');}
  async function request(method,params){
    let timer;
    try {
      return await new Promise((resolve,reject)=>{
        active={id:++id,resolve,reject};
        timer=setTimeout(()=>reject(Error(method+' timed out')),30000);
        send({id,method,params});
      });
    } finally { clearTimeout(timer); active=undefined; }
  }
  try {
    await request('initialize',{clientInfo:{name:'metasocli-skill-setup',version:'1'},capabilities:{experimentalApi:true}});
    send({method:'initialized'});
    return await visit({
      list: async cwds=>(await request('skills/list',{cwds,forceReload:true})).data,
      disableFile: async path=>(await request('skills/config/write',{path,enabled:false})).effectiveEnabled,
      async startSelectedSkillTurn(name, path, text) {
        const {thread} = await request('thread/start',{cwd,ephemeral:true,sandbox:'read-only',approvalPolicy:'never'});
        await request('turn/start',{threadId:thread.id,input:[{type:'skill',name,path},{type:'text',text}]});
      },
    });
  } finally { lines.close(); p.stdin.destroy(); p.stdout.destroy(); p.stderr.destroy(); p.kill(); }
}
