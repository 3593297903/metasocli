import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

export const seedanceEntries = {
  ycy480sd2: { trigger: '$ycy480sd2.5', purpose: 'video', model: 'seedance-2.5-face-full-5s-480p' },
  ycy720sd2: { trigger: '$ycy720sd2.5', purpose: 'video', model: 'seedance-2.5-face-full-5s-720p' },
  yiciyuang2: { trigger: '$yiciyuang2.5cli', purpose: 'story' },
};
const absolutePath = z.string().refine(isAbsolute, 'Expected an absolute path');
const requestSchema = z.object({
  entry: z.enum(Object.keys(seedanceEntries)),
  message: z.string().min(1),
  intent: z.enum(['select', 'discuss', 'status', 'prepare', 'generate']),
  selectedInUI: z.boolean().optional(),
  root: absolutePath.optional(),
  prior: z.object({ root: absolutePath, message: z.string(), selectedInUI: z.boolean().optional() }).strict().optional(),
  selection: absolutePath.optional(),
  episodes: z.array(z.string().min(1).regex(/^[^,]+$/)).nonempty().optional(),
}).strict();

// The Skill supplies intent after reading the user's own message. These checks
// also reject frequent ambiguous matches made by Codex's dotted-name parser.
const tokens = /\$(?:ycy|yiciyuang)[a-zA-Z0-9_.-]*/giu;
function plainInstruction(text) {
  return text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu, ' ').trim();
}
function mentioned(text, expected, ui) {
  const all = text.match(tokens) ?? [];
  if (all.some(token => token !== expected)) return false;
  return (plainInstruction(text).match(tokens) ?? []).includes(expected) || (ui === true && all.length === 0);
}
function isDiscussion(text) {
  const explanatory = /什么意思|怎么用|怎么写|是否支持|(?:用法|示例)(?:是|中|里)|(?:举个?|给个?|讨论|解释|这个|这是)(?:例子|示例|用法)|假设我|假如我|如果我/u;
  const informational = /(?:只|仅)(?:看|查)(?:看)?(?:状态|用法|示例)|(?:可以用|能用).+(?:吗|么|[?？])\s*[?？]?$/u;
  const estimate = /多少钱|多少[元块钱]|(?:费用|价格|造价|报价)(?:大约|大概|是|为)?多少|怎么(?:扣费|计费|收费)|(?:只|先)(?:估算|估价|报价)/u;
  const hold = /(?:先别|先不|不要|禁止|别)(?:真的?|实际|直接)?(?:执行|提交|下单)|(?:先别|先不|不要|别)生成(?:了|[。！!，,]|$)/u;
  if (explanatory.test(text) || informational.test(text) || estimate.test(text) || hold.test(text)) return true;
  // An excluded episode can coexist with a clear instruction for a different
  // episode. Keep the supplied selection tied to that affirmative instruction.
  const negated = /(?:先别|先不|不要|禁止|不用|不必|暂不|别)(?:再|继续|马上|立即|开始)?(?:生成|制作|做成视频|出片)/u;
  return negated.test(text) && !text.split(/[，,。；;！!\n]/u).some(clause =>
    !negated.test(clause) && /生成|制作|做成视频|出片/u.test(clause));
}

export async function skillDecision(value) {
  const input = requestSchema.parse(value);
  const entry = seedanceEntries[input.entry];
  const expected = entry.trigger;
  const requestTokens = input.message.match(tokens) ?? [];
  let selected = mentioned(input.message, expected, input.selectedInUI);
  if (!selected && requestTokens.length === 0 && input.prior && input.root) {
    selected = mentioned(input.prior.message, expected, input.prior.selectedInUI)
      && !isDiscussion(plainInstruction(input.prior.message))
      && await realpath(input.prior.root) === await realpath(input.root);
  }
  if (!selected || ['discuss', 'status'].includes(input.intent)) return { status: 'no_submission' };
  if (entry.purpose === 'story') {
    if (input.intent === 'generate') return { status: 'video_entry_required' };
    return { status: 'prepare_story' };
  }
  const model = entry.model;
  const instruction = plainInstruction(input.message);
  if (isDiscussion(instruction)) return { status: 'no_submission' };
  if (input.intent === 'select' || !instruction.replace(tokens, '').replace(/[\s\p{P}]/gu, '')) {
    return { status: 'model_selected', model };
  }
  if (!input.root || Number(!!input.episodes) + Number(!!input.selection) !== 1) {
    return { status: 'scope_required', model };
  }
  const args = ['video', 'run', '--root', await realpath(input.root), '--model', model];
  if (input.episodes) args.push('--episodes', input.episodes.join(','));
  else args.push('--selection', input.selection);
  if (input.intent === 'generate') args.push('--confirm');
  return { status: 'run', model, args };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw Error('Expected a UTF-8 JSON request file');
    const packet = JSON.parse((await readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/u, ''));
    const decision = await skillDecision(packet);
    if (decision.status === 'run') {
      const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
      const child = spawn(process.execPath, [cli, ...decision.args], { stdio: 'inherit', windowsHide: true });
      process.exitCode = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('exit', code => done(code ?? 1));
      });
    } else {
      console.log(JSON.stringify(decision));
    }
  } catch (error) {
    console.error(error instanceof z.ZodError ? 'Invalid Seedance skill request fields.' : error.message);
    process.exitCode = 1;
  }
}
