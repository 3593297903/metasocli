import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { readJson } from '../storage/io.js';
import type { SavedOutput } from '../contracts/job.js';
import { isCode } from '../core/errors.js';
import { inspectVideo } from './video.js';

const execute = promisify(execFile);
export type AvCommand = (tool:'ffprobe'|'ffmpeg',args:string[])=>Promise<string>;
const run:AvCommand = async (tool,args) => {
  let executable:string=tool;
  if(tool==='ffmpeg'){
    const configured=process.env.METASOCLI_FFMPEG;
    if(configured)executable=configured;
    else try{
      const path=fileURLToPath(new URL('../../.local/video-tools.json',import.meta.url));
      executable=z.object({ffmpeg:z.string().refine(isAbsolute)}).strict().parse(await readJson(path)).ffmpeg;
    }catch(e){if(!isCode(e,'ENOENT'))throw e;}
  }
  return (await execute(executable,args,{windowsHide:true,timeout:120000,maxBuffer:256*1024,encoding:'utf8'})).stdout;
};
export async function verifyAv(file:string, output:SavedOutput, command:AvCommand=run, requireAudio=true) {
  try {
    try {
      const probe = JSON.parse(await command('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-f','mov','-show_entries','stream=codec_type','-of','json',file]));
      const streams:unknown[] = Array.isArray(probe.streams) ? probe.streams.map((s:{codec_type?:unknown})=>s.codec_type) : [];
      if (!streams.includes('video') || (requireAudio && !streams.includes('audio'))) return {passed:false,reason:'AV_STREAM_MISSING'};
    } catch(error) {
      // Mandatory stream maps below verify both streams even on ffmpeg-only installations.
      if(!isCode(error,'ENOENT'))throw error;
    }
    await command('ffmpeg',['-nostdin','-v','error','-xerror','-protocol_whitelist','file,pipe','-f','mov','-i',file,'-map','0:v','-map',requireAudio?'0:a':'0:a?','-f','null','-']);
    if ((await inspectVideo(file)).sha256!==output.sha256) return {passed:false,reason:'OUTPUT_CHANGED'};
    return {passed:true};
  } catch (error) {
    return {passed:false,reason:isCode(error,'ENOENT')?'AV_TOOL_UNAVAILABLE':'AV_VERIFICATION_FAILED'};
  }
}
