import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SavedOutput } from '../contracts/job.js';
import { isCode } from '../core/errors.js';
import { inspectVideo } from './video.js';

const execute = promisify(execFile);
export type AvCommand = (tool:'ffprobe'|'ffmpeg',args:string[])=>Promise<string>;
const run:AvCommand = async (tool,args) => (await execute(tool,args,{windowsHide:true,timeout:120000,maxBuffer:256*1024,encoding:'utf8'})).stdout;
export async function verifyAv(file:string, output:SavedOutput, command:AvCommand=run) {
  try {
    const probe = JSON.parse(await command('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-f','mov','-show_entries','stream=codec_type','-of','json',file]));
    const streams:unknown[] = Array.isArray(probe.streams) ? probe.streams.map((s:{codec_type?:unknown})=>s.codec_type) : [];
    if (!streams.includes('video') || !streams.includes('audio')) return {passed:false,reason:'AV_STREAM_MISSING'};
    await command('ffmpeg',['-nostdin','-v','error','-xerror','-protocol_whitelist','file,pipe','-f','mov','-i',file,'-map','0:v','-map','0:a','-f','null','-']);
    if ((await inspectVideo(file)).sha256!==output.sha256) return {passed:false,reason:'OUTPUT_CHANGED'};
    return {passed:true};
  } catch (error) {
    return {passed:false,reason:isCode(error,'ENOENT')?'AV_TOOL_UNAVAILABLE':'AV_VERIFICATION_FAILED'};
  }
}
