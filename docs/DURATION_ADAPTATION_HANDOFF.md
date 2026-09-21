# 小数目标时长适配：交给 ts1 的实施方案

日期：2026-09-18。状态：待实施。本文件仅记录方案，不能作为功能已实现或真实生成已验证的证明。

## 目标与依据

让剧本入口、成品提示词入口及旁白入口自动接受小数目标时长，沿用已核实的 LibCLI 0.2.22 规则：保留目标值，向上取整得到视频请求时长。用户不必为了正常的小数适配逐段确认。

旧正式安装的 `dist/core/prompt.js` 中 `calculateGenerationDuration` 使用 `Math.ceil`；对应快照为 `E:\libcli\.story2libtv-work\video-prompt-entry-0.2.22-20260916\source\src\core\prompt.ts`。旧成品提示词适配器也分别保存目标时长和生成时长。本次只移植这项规则，在 metasocli 中独立实现。

当前 metasocli 的导入草稿、故事段、计划段及 H3 请求均要求整数；CLI 的 `--duration` 还共用整数参数解析器。因此仅修改 Skill，或者仅把一个 Zod 字段放宽为小数，都不能完成闭环。

| 输入目标秒数 | 实际请求 duration | 保存的原始目标 | 结果 |
| --- | --- | --- | --- |
| 12.378 | 13 | 12.378 | 接受 |
| 6.666 | 7 | 6.666 | 接受 |
| 6.963 | 7 | 6.963 | 接受 |
| 12 | 12 | 不新增字段 | 维持整数旧行为 |
| 15 | 15 | 不新增字段 | 接受 |
| 3.1 | 4 | 3.1 | 接受，与旧规则一致 |
| 3、0、负数、超过 15、NaN、Infinity | 无 | 无 | 拒绝，定位到对应段/参数 |

精确定义：目标必须是有限正数且不超过 15；`Math.ceil(target)` 必须落在整数 4–15 内。不使用四舍五入、向下取整、误差容忍取整或上下限强行截断。特别是 12.378 应得到 13，不能得到 12。

适配只决定请求时长。原文仍可写 12.378 秒，计划展示实际请求 13 秒；本次不包含把最终成片自动裁剪为 12.378 秒的功能。

## 实施边界

1. 先完整读取 `AGENTS.md`、`START_HERE.md`、`docs/ARCHITECTURE.md`、`docs/SOURCE_BASELINE.md`，再检查当前实现。保留当前工作区已有的图片 Skill、旁白、认证等改动；不要重置工作区，也不要从 Git HEAD 覆盖这些未提交内容。
2. 所有开发和测试产物写入 `E:\metasocli` 或测试临时目录。`E:\libcli`、旧全局安装、旧 Skill、配置、运行目录及业务数据保持只读。
3. 本次只做实现、构建、离线测试。不得调用真实视频创建接口、生图、修改账号/API Key、覆盖全局安装或推送 GitHub。不自动提交当前混合工作区。
4. 不在 mttest1、mttest2 原故事中修数据或重跑流程。需要真实格式样例时，只读其原文，在本项目隔离目录构造最小测试。
5. 不引入新依赖、数据库、后台服务、旧 CLI 调用、旧目录动态 import 或共享链接；不整体复制旧适配器和 Core。

## 数据设计：保留现有执行字段，增加可选目标字段

对外导入仍只要求 `segments[].duration`，它可以填写原始小数目标值：

```json
{"id":"s1","start":0,"end":100,"duration":12.378}
```

在 `importStory` 内完成一次归一化。以下仅表示持久化故事段和计划段中的时长字段，不是完整段对象：

```json
{"duration":13,"targetDurationSeconds":12.378}
```

约束：

- `duration` 在持久化故事、计划及 H3 请求中继续表示实际整数请求时长，保持 4–15。
- `targetDurationSeconds` 仅在新导入的小数目标需要取整时写入故事段和计划段。整数输入不补字段，不写 null，不设置 Zod 默认值。
- 字段存在时，校验目标的有限性、范围及 `duration === Math.ceil(targetDurationSeconds)`。拒绝不一致的组合。
- H3 请求体只发送现有的整数 `duration`，不发送 `targetDurationSeconds` 或其他新增元数据。
- 不额外要求用户在导入草稿同时填写两个时长字段；目标值由原始 `duration` 输入保留。
- 只在导入时转换。读取旧 manifest、加载旧 plan、status、resume、download 都不能重新取整、补字段或重写文件。
- 沿用 schemaVersion 1 的可选字段扩展，让升级后的程序继续读取原有整数数据；不承诺旧程序能够读取新扩展数据。

## 最小代码改动

| 文件（相对于 E:\metasocli） | 所需改动 |
| --- | --- |
| `src/story/duration.ts`（新增） | 实现无 I/O 的目标时长校验/向上取整函数，提供唯一的取整策略。不要依赖故事契约，避免循环引用。 |
| `src/contracts/story.ts` | ImportDraft 接受合法小数目标；Segment 保持整数 duration，增加可选 targetDurationSeconds 及对应关系校验。不要改音频媒体的 duration。 |
| `src/core/project.ts` | 在导入段映射时调用适配函数；覆盖存储 duration 并按需写目标字段，再按现有路径校验、加锁和保存。原文和素材处理沿用现有逻辑。 |
| `src/contracts/plan.ts` | PlanSegment 增加同样的可选目标字段及合法关系校验；缺省时保持原解析结果。 |
| `src/metaso/h3.ts` | 仅向 summary 按需带出目标字段。请求仍使用 segment.duration，保留 RequestSchema 的整数校验。 |
| `src/cli/main.ts` | 为 --duration 增加专用十进制数解析，接受 12.378；更新 help。不要放宽现有 --max-polls、--poll-ms 的整数解析。 |

JSON 草稿中的数字契约不做字符串强制转换。CLI 专用解析拒绝空串、非数、Infinity、十六进制、带单位或夹杂尾部字符的输入；合法范围由统一规则校验。

`src/core/planning.ts` 应先确认现有完整摘要哈希已经覆盖新增字段，通常不需要改动。`src/story/text.ts`、jobs 模块及下载模块原则上只做回归检查，除非发现本次变更造成的具体兼容问题。

## 原文、哈希与恢复兼容

1. 原始来源字节、规范文本、原文提示词、promptHash、UTF-16 start/end 和旁白 cues 均不得因取整改变。不替换原文中的数字，不重排镜头，不缩短台词，不拉伸或裁剪参考 MP3。
2. 保持当前提示词渲染规则。本次不附加新的时长说明文字，避免无必要地改变 renderedPrompt、requestHash 和现有请求去重行为；目标与实际时长通过计划字段展示。
3. 现有 planHash、manifestHash 继续覆盖其完整对象；新目标字段自然纳入新故事和新计划的完整性校验。旧整数对象不补字段，旧哈希继续有效。
4. 保持 requestHash 和 inputHash 的现有算法。相同实际请求不能仅因为新增元数据而被当成另一个待付费请求；原始提示词、实际时长或素材真正变化时仍按现有规则改变哈希。
5. 重复导入同一小数草稿应幂等，不增加 revision；已有整数草稿重新导入也不增加 revision。内容变更继续遵守显式 --replace；变更后旧计划仍按现有规则失效。
6. 已提交任务继续凭原 taskId 与原计划中的整数 duration 恢复，不读取当前提示词重新推算时长。回执未知不重提，下载失败只恢复下载。
7. 修改前用当前工作区构建并保存具有真实旧哈希的整数 manifest/plan 兼容样例。升级后实际验证其 loadPlan、validatePlan 和假客户端恢复；不能只用新代码生成一份整数样例就声称证明旧版本兼容。

## Skill 和文档接入

更新本项目规范正文：

- `skills/metasocli-video-prompts/SKILL.md`
- `skills/metasocli-video-prompts-旁白/SKILL.md`
- `skills/metasocli/SKILL.md` 及 `skills/metasocli-prompt-engine/SKILL.md` 中涉及目标时长的说明
- `docs/INPUT_FORMAT.md`、README 的输入/计划示例，以及 `docs/VERIFICATION.md` 的实际验证结果

统一写清：将原始目标小数原样填入草稿 duration，由程序自动向上取整；正常取整是技术适配，不需要额外逐段确认。两个视频提示词入口共享核心规则，图片准备和旁白绑定保持现有流程。未授权视频生成时，仍停在计划完成后。

对 mttest2 这类原文，明确的“本段生成时长 12.378 秒”应保留为目标；标题或末镜头显示 12.38 秒，若只是按显示精度舍入，不应机械地判定为内容冲突。不把标题显示值代替更精确的明确目标，也不改原始时码。无需为本任务新增通用自然语言时长解析器。

缺少明确目标、确实无法解释的时长冲突、超过允许范围才定位具体段落报告；可以继续其他明确段落的准备。正常小数适配不属于这种冲突。

现有用户级两个入口读取本项目 Skill 正文；确认这一指向即可，不必改写或重新安装全局入口。检查新增链接。若实际复制旧代码，按项目要求补充来源文件、版本和哈希记录；仅独立实现同一规则也应在来源说明中记清行为依据。

## 执行顺序与验收

1. 检查当前工作区状态，记录本次修改前的旧 Git 状态、全局 story2libtv 路径与相关旧安装/Skill/配置/运行文件哈希。将本次基线保存为新的独立文件；不覆盖既有 `.work/isolation-baseline.json`。如已有历史差异，单独说明，并用本次前后对比判断新增影响。
2. 在修改前构建当前版本，捕获上一节要求的旧整数兼容样例，包含普通段和旁白段。采用项目内临时目录及假客户端，不连接真实服务。
3. 实现纯函数、契约和导入归一化，再接入 CLI 与计划摘要；保持当前恢复实现及锁机制。
4. 更新两个 Skill 和相关说明，增加必要的行为测试，不为单纯文案改动堆叠镜像测试。
5. 使用独立临时故事完成两个内容入口的离线 import → 素材登记（需要时使用测试素材）→ plan；再通过假客户端验证 generate/resume/download 的时长与去重兼容。

必须覆盖的验收项：

- 表中全部例子；另验证 15.001 拒绝、合法整数不补目标字段，不一致的目标/执行组合拒绝。
- JSON 草稿及 `--duration 12.378` 两条公开入口都成功。script 和 video-prompts 两种 kind 都走同一核心逻辑。
- 非法小数输入定位到具体段或参数；轮询次数等参数仍拒绝小数。
- 12.378/6.666/6.963 的新计划分别展示 13/7/7 与原目标；实际 H3 payload 为整数，严格不含新增目标字段。
- 原始来源、promptHash、素材顺序、旁白 cues 和音频文件哈希保持一致；旁白音频自己的媒体时长保持原精度。
- 重复导入幂等；无 --replace 不覆盖已有不同内容；显式替换后旧计划正确失效。
- 修改前保存的旧整数计划及哈希可读取、可校验，不被补字段或重写；同样的旧整数输入所构造的请求与 inputHash 不变。
- 旧任务通过原 taskId 恢复，create 调用计数不增加；小数新任务也能在模拟中断后恢复。submit_unknown、下载失败不能触发再次创建。
- 图片 Skill、独立打包/安装隔离和现有恢复测试全部继续通过。

从 `E:\metasocli` 使用 PowerShell 执行现有验收命令，并逐条检查退出码：

```powershell
Set-Location -LiteralPath 'E:\metasocli'
npm run check
npm run test:image-skill
npm run test:process
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package-smoke.ps1
git -c safe.directory=E:/metasocli diff --check
```

`npm run check` 已包含构建和 TypeScript 测试。包安装验证只使用现有脚本的隔离 prefix，不进行真实全局安装。测试若遇到环境或权限问题，按真实原因处理并报告，不能把未执行写成通过。

实现完后用本次独立基线比较旧项目及安装状态，确认本次零改动。对既有历史隔离基线的差异不得通过重写基线消除。

## ts1 的交付内容

- 列出实际修改文件及原因，区分原本已有改动与本次新增。
- 给出包含 12.378 → 13、6.666 → 7、6.963 → 7 的真实离线 CLI 计划结果。
- 报告旧计划哈希兼容、原文/旁白保持、重复导入、未知提交和下载恢复的测试证据。
- 报告各验收命令的实际结果，以及旧项目/安装的本次前后比较结果。
- 明确说明：本次完成到离线计划和假客户端验证；没有执行真实生图、付费视频生成、mttest2 数据修改或 GitHub 推送。
- 不宣称成片已自动裁剪到小数时长，也不宣称真实 H3 声线效果或生成服务已经验收。

## 可以直接发给 ts1 的指令

```text
请在 E:\metasocli 落实 E:\metasocli\docs\DURATION_ADAPTATION_HANDOFF.md。

先完整读取 AGENTS.md、START_HERE.md、docs/ARCHITECTURE.md、docs/SOURCE_BASELINE.md 和上述方案，再基于当前工作区实现，不覆盖已有未提交改动。

按方案把旧 LibCLI 的小数目标时长向上取整规则融入新项目导入核心：12.378→13、6.666→7、6.963→7；保留原始目标、提示词、旁白范围和素材顺序。两个视频提示词 Skill 自动使用此规则，不再为正常取整逐段询问。兼容旧整数故事、不可变计划、请求去重及已有任务恢复。

完成代码、Skill、文档、旧数据兼容测试及方案列出的构建/离线/打包隔离检查，最后按方案交付实际证据。本次授权本地离线实现；E:\libcli 和旧安装全程只读，不改 mttest1/mttest2，不真实生图、不付费生成、不重装全局命令、不自动提交或推送 GitHub。
```
