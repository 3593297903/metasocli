# 未知视频显式重试实施报告

交付状态说明：下文“未提交、未推送”描述各次实施与核验结束时的历史状态。用户随后授权上传当前项目；新设备应按 [修复版本部署说明](NEW_DEVICE_RETRY_BUILD.md) 使用上传回执中经远端核实的完整提交 SHA，不能继续固定旧基线。

## 2026-10-16 上传前独立复核

独立副本构建通过，当前 dist 的 100 个 JS/声明文件与副本构建一致。11 个文件的 112 项相关回归首次运行 110 通过、2 项触及 20 秒时限；两项在停止其他测试后以原时限和原断言单独复跑均通过，不能表述为本轮一次运行 112/112 全绿。正式进程测试 34 组通过，原缺陷复现与额外两个恢复边界通过。上传前核对 156 个源码文件与已核验清单一致；仅随后更新本部署说明和交付状态文字。

本次上传没有新增付费调用，也没有重新运行全量测试、图片 API 或安装测试。独立核验日志保留在开发设备的 `.work/ts1-retry-recheck-20261016-184508-742f84/`，不随源码上传。第三方真实接口、网络与计费行为仍不属于本轮离线验收结论。

## 2026-10-16 独立核验后的两项补修

本节记录本次增量修复；后文保留首次实现的历史记录。独立审核已证明首次实现存在“旧未知授权截断后来明确失败重试”与“进程测试误把 running 当作非法状态”两个缺陷，后文一次通过的旧记录不能代表这两项已被覆盖。本次从已有未提交实现继续修改，未回退、提交、推送或覆盖全局安装。

证据目录：[unknown-video-retry-followup-20261016](../.work/unknown-video-retry-followup-20261016)。修改前源码备份为其中 `before/`，初始源码哈希与 Git 状态为 `source-before.json`、`git-before.txt`。独立审核原目录、原脚本和失败日志保持原样。

### 本次实际修改

| 文件 | 增量修改 |
|---|---|
| `src/jobs/video-retry.ts` | 增加只读的 supersededRetry 判定：原任务须已恢复 taskId，B 须是确实未发送的 RETRY_SUPERSEDED 记录；仅有授权、尚无 B 时，还核对无回执、发送 owner 或共享预留证据。保留原授权及 B。 |
| `src/jobs/submit.ts` | 分离原未知重试授权和后来普通明确失败重试；在锁外检查、锁内复核及 prepared 恢复时一致处理。A 明确 failed/cancelled 后允许独立 C，仍用原锁/提交/回执事务；C 的 attempt 包含取消 B 和预分配授权的历史计数。重复命令复用 C；意图后无回执保持未知。 |
| `src/cli/main.ts` | 将 `--accept-unknown-result` 原样传入 submit，由共享入口检查授权，避免旧风险确认命令被误解释成普通失败的新授权。凭据仍延迟到本地校验之后。 |
| `scripts/video-retry-process-smoke.mjs` | retry-batch-index 接受 queued/running，保留 taskId、operationId、POST 次数、旧未知占位断言；增加 C 的 7 组实际子进程中断/并发与原批次索引恢复检查。证据可写指定测试目录，避免覆盖历史报告。 |
| `scripts/video-retry-process-worker.mjs` | 增加普通失败重试的子进程测试模式；prepared、预留、意图、HTTP、回执、批次索引处由父进程 SIGKILL，另验两个并发命令。没有更改业务 Job 状态来迁就测试。 |
| `tests/video-recovered-failure-retry.test.ts` | 新增 10 项确定性回归：failed/cancelled、C 的 prepared/intent/receipt 中断、原批次恢复 C、预检期间找回 A 的竞态、C 再失败/未知时的新授权与旧命令去重。 |
| `skills/metasocli/SKILL.md`、`skills/metasocli-video-prompts/SKILL.md`、`skills/metasocli-video-prompts-旁白/SKILL.md` | 三个项目内正文统一说明 A→B 失效后普通失败重试形成 C，以及旧命令不扩张授权。未覆盖 `.agents`、用户级 Skill 或全局配置。 |
| `docs/VIDEO_UNKNOWN_RETRY.md`、本报告 | 补齐实际命令、历史保留、原批次与 retryOnly 范围边界、实测证据和未验证范围。 |

本次共修改上述 10 个已有文件、新增 1 个测试文件；本地 dist 已重新构建。未改 Job/Plan/ledger schema、依赖、图片并发或批次容量规则。其余先前未提交修改保持原样；最终差异/哈希见 `source-delta.json`、`final-source-hashes.json`。

### 修复前后及实际验证

先添加正确行为回归再修改源码：原实现的 7 项初始回归全部失败（`red-regression.log`，退出 1）。普通失败重试仍返回 A、退出 2；C 的 prepared/intent/receipt 检查点未到达。修复后这 7 项全部通过（`green-regression.log`，退出 0），随后扩大至 10 项并纳入最终相关回归。

| 实际命令/检查 | 本次结果 | 日志/退出码 |
|---|---|---|
| `npm run build` | 通过，最终本地 dist 可用 | `build-final.log` / 0 |
| `npm test -- tests/video-recovered-failure-retry.test.ts tests/video-unknown-retry.test.ts tests/submit.test.ts tests/recovery.test.ts tests/video-batch.test.ts tests/video-batch-faults.test.ts tests/cli.test.ts tests/coordinator-boundaries.test.ts tests/inline-context-ir.test.ts tests/client.test.ts tests/context-ir-recovery.test.ts` | **11 文件，112/112**；含原请求内容、旁白、四并发、路径/归档边界及独立 IR 恢复 | `focused-final.log` / 0 |
| `npm run test:process`，正式脚本、正常权限 | **34 组 PASS**；包括原未知 8 组和新增恢复失败链路 7 组 | `process-approved.log` / 0；`process-evidence.json` |
| `npm run test:image-skill` | **12/12** | `image-skill.log` / 0 |
| 构建后的 `node dist/cli/main.js --help` | 通过，正式 CLI 入口存在 | `cli-help.log` / 0 |
| `git diff --check` | 通过 | `diff-check.log` / 0 |

每次运行的退出码均另存同名 `.exit.txt`。还保留了中间失败：

- `process.log` / 1：本轮首次正式进程测试被 sandbox `spawn EPERM` 阻止；随后正常权限正式脚本通过。独立审核中的 actual running / expected queued 是另一项真实测试缺陷，不能用这个权限限制解释；已正式修改断言。
- `focused.log` / 1：7 文件 74 项中 73 项通过，新增加的完整 A/B/C/D 多次 CLI/调度生命周期用例触及默认 20 秒时限。仅为该长链路设为 90 秒，未改任何业务状态或预期；最终同一链路及相关 112 项全部通过。该中间命令还包含两个未匹配的测试过滤名，实际覆盖仅为日志中的 7 个文件，最终命令已使用正确的全部 11 个文件名。
- `compatibility.log` / 0：另行执行的 coordinator-boundaries、inline-context-ir、client、context-ir-recovery 四文件 38 项通过；已包含在最终 112 项中，不重复累计。

本轮没有重跑全量 236 项、图片 200 HTTP 屏障或临时安装，不将上一轮结果计入本轮通过项。使用假客户端、合成故事、隔离 runtime；进程测试屏蔽真实 fetch 和旧 CLI 路径。

### 原 ID 与无重复 POST 的可复核证据

以下计数来自本轮正式进程脚本，均另有原 A 的 1 次模拟 POST；表中只计 C。B 保留为 cancelled / RETRY_SUPERSEDED，原 A 保留 provider failed 和原 taskId，授权文件逐字节比较不变。每组重跑普通失败命令、旧未知命令和原 batch resume 后计数不增加，批次索引指向同一 C。

| C 的中断/并发点 | 中断前 POST | 恢复 POST | 本轮观察结果 |
|---|---:|---:|---|
| prepared | 0 | 1 | queued，attempt 3 |
| reserved | 0 | 1 | queued，attempt 3 |
| intent | 0 | 0 | submit_unknown，绝不推断未受理 |
| HTTP 已进入 | 1 | 0 | submit_unknown，不重发 |
| receipt | 1 | 0 | queued，复用已保存 taskId |
| retry-batch-index | 1 | 0 | **running**，不降级 queued |
| 两个并发命令 | 1 | 0 | 同一个 C，同一个 taskId |

具体样例（完整 15 组记录见 [process-evidence.json](../.work/unknown-video-retry-followup-20261016/process-evidence.json)）：

- C 准备中断恢复：A=`98013103-3d03-4065-9a59-9fce188d271a`，B=`39e4eeb6-1ca3-4cbf-aab7-a290670f003f`，C=`c02b984b-927f-4208-bf94-78e501550a77`，恢复首次发送后 taskId=`recovery-C-prepared`；总 POST 为 A 1 + C 1。
- C 回执中断：C=`bcc1e323-96eb-4441-ad2b-9134eb9bc26e`，原 taskId=`retry-process-30144`，恢复 POST=0。
- 两个并发失败重试命令：C=`c53f9c62-dfee-4a9e-a945-9d43442deb15`，taskId=`retry-process-38984`，两个进程合计新 POST=1，恢复 POST=0。

原未知重试的 retry-batch-index 本轮实际为 queued，新增 C 的对应检查点实际为 running，二者均保留 ID 与次数约束。原未知任务的 8 组回归继续断言旧未知占位保留；新链路中的 A 只有在假供应商明确 failed 后才释放名额。原 task5 补位轨迹本轮也由相关回归重跑，另存 `replenishment.json`，历史证据按修改前备份保留。

### 隔离、使用与未验证事项

旧环境修改前后 **53 个文件哈希一致**，E:\libcli 的原 Git 状态和全局 story2libtv 命令路径一致；本项目 `.local` 与用户 metasocli runtime 的 **10 个文件哈希一致**。见 `isolation-before.json`、`isolation-after.json`、`personal-before.json`、`personal-after.json`、`personal-comparison.json`。未将生产故事、历史任务/账本或真实凭据用于测试，未修改 LibTV、旧安装或全局配置。

找回 A 后查询得到明确 failed/cancelled，当前用户授权重新生成时执行：

```text
node E:\metasocli\dist\cli\main.js generate --root <story> --plan <planId> --segment <segmentId> --retry-of <A的本地operationId> --confirm --submit-only
```

不带 `--accept-unknown-result`；重复上述命令复用 C。省略 `--submit-only` 可沿用正常查询下载；或用 `resume --root <story> --operation <C的本地operationId>`。原范围已授权的批次用 `batch resume` 重建 C 的索引并继续。仅有 B 的 retryOnly 授权不会扩大为对 C 的提交授权，具体规则见 [使用文档](VIDEO_UNKNOWN_RETRY.md#找回原任务后又确认失败)。

**已实现并通过上述离线验证；真实付费接口仍未验收。** 没有真实 IR、图片、视频调用，不证明供应商零重复收费、网络超时已修复或真实并发效果通过。当前仍是 e781ccb 上的本地未提交改动、版本 0.1.0；另一设备仅检出旧提交不会得到本修复。

---

实施日期：2026-10-16。基线为 `e781ccb1a4b0fefb63cf76b2eea1480ee4cbe59d`，开始时工作区干净。当前修改在本地工作区，未提交、未推送、未覆盖全局安装。源文件备份及本轮日志保存在 `.work/unknown-video-retry-20261016/`。

## 实际修改

- `src/contracts/video-retry.ts`、`src/jobs/video-retry.ts`：新增哈希校验的一次性授权，绑定项目、原操作、计划/段、输入/请求、运行目录、时间、唯一新 operationId 与 attempt。授权独立于容量；状态从 Job、receipt、ledger 重建。授权已落盘但 Job 未写时可补齐同一身份；已有发送证据却缺 Job 时拒绝重建。新尝试未知不重置，旧未知不伪造终态。
- `src/jobs/submit.ts`、`submission-guard.ts`、`coordinator.ts`：单段与批次复用原提交事务、锁顺序、owner 和回执优先落盘。只对本项目经核验的那条旧未知解除派发阻断；仍统计旧名额，其他未知与跨项目冲突继续拒绝。满额返回 prepared + waiting_capacity。提交锁内再次核验原回执，找回旧 ID 后取消仅能证明尚未发送的新 Job，恢复原任务。
- `src/jobs/batch.ts`、`batch-store.ts`、`contracts/batch.ts`：显式重试优先补位，仍最多四个可能生成占位、两个独立下载。恢复重建索引；未保存原批次授权时只保存 `authorization.retryOnly` 的精确新操作范围，resume 不扩大授权。该一次性尝试不继承批次自动 429 重试预算。四未知且无可查询任务时保存授权并退出，输出准确容量阻塞事件。
- `src/cli/main.ts`：新增 `--accept-unknown-result` 与 `batch retry`，本地参数/授权检查先于凭据和 POST；凭据延迟准备仍发生在写提交意图之前。status/generate 返回 videoRetries，batch 返回 retries。普通 resume/status/download 不创建任务。
- `src/metaso/client.ts`、`jobs/submit.ts`：保存脱敏创建诊断，包括阶段、耗时、是否收到响应头、HTTP 状态、错误 name/code、可用 request ID；不记录密钥、认证头、完整请求或签名 URL。`resume.ts` 仅更新无 ID 错误说明，不改变恢复行为。
- 三个 `skills/*/SKILL.md`、AGENTS、README、INLINE_CONTEXT_IR_WORKFLOW 与新增使用文档：明确一次授权、新旧尝试、缺失远端 ID 不作为重生前提、waiting_capacity 的处理、附件不能授权付费。只读核对了三个 `.agents` 入口及两个现有用户级入口，均引用仓库正文，无需覆盖入口或全局配置。
- `tests/video-unknown-retry.test.ts`、`scripts/video-retry-process-*.mjs`：新增契约、恢复、容量、CLI、素材保持、诊断、Skill 和真实进程中断回归；纳入 `test:process`。原 submit 测试断言保留，仅将标题明确为 retry-of 单独不能授权未知新尝试。

Job、计划与 ledger 原 schema 不变；BatchRun 仅增加无默认值的可选范围字段，不重写旧记录或旧哈希。图片并发、独立 IR 历史流程和依赖版本不变。

## 实测与证据

已执行结果：

| 实际命令/检查 | 结果 | 证据 |
|---|---|---|
| `npm run build`（最终根目录构建） | 退出 0 | `build-final.log` |
| 视频相关 9 个测试文件 | 79/79，通过 | `video-regression.log` |
| `npm run check`（根目录全量重跑） | 退出 0，26 文件、235/235 | `check-escalated.log` |
| `npm run test:process`（最终构建） | 退出 0，27 组 PASS；含新增 7 个中断点及双进程重复重试 | `process-final.log`、`process-evidence.json` |
| `npm run test:image-skill` | 退出 0，12/12 | `image-skill.log` |
| `powershell.exe -NoProfile -File scripts/package-smoke.ps1`（最终独立源码） | 退出 0：离线 ci/build、26 文件 236/236；临时安装/重装/卸载通过，8 个旧安装哨兵不变；已安装 CLI 重试入口存在 | `package.log` |

上述日志均在 [.work/unknown-video-retry-20261016](../.work/unknown-video-retry-20261016)。根目录全量重跑之后又收紧了“缺 Job 但仍有 slot”及原计划/授权绑定的恢复检查，并增加一条用例；最终源码已由独立副本全量 236 项验收覆盖；src/tests/scripts/skills 的最终文件哈希复核无变化。

如实保留的首轮失败：普通 resume 的新测试最初错误期待返回未知 Job，实际正确行为是抛 SUBMIT_UNKNOWN；已修正测试样本的调用预期，生产行为未放宽。旧 false 计划样本最初仍携带 inline workflow，触发 INVALID_INPUT；改为有效旧计划格式后按预期拒绝为 INLINE_IR_REQUIRED。第一次根目录 check 为 231/235：上述旧计划样本失败、两项假凭据 DPAPI 受限、原有快速锁竞争测试出现一次 realpath EPERM。未删除测试或改变旧锁规则；正常权限全量重跑 235/235 通过。test:process 首次也被 sandbox spawn EPERM 阻止，获正常执行权限后原命令通过。各失败日志保留为 `focused.log`、`identity-check.log`、`check.log`、`process.log`。

补位轨迹文件 [replenishment.json](../.work/unknown-video-retry-20261016/replenishment.json) 记录原 1–4 进入、1 终态后 5 补位、5 未知、明确授权的新 5 等待名额、已知终态后新 5 优先、其余 6/7 按原范围继续。新旧 5 使用不同 operationId，原未知占位保留，重复原命令不增加 POST；本轮只使用合成故事和假客户端。最终源码副本的对应轨迹另存 [package-replenishment.json](../.work/unknown-video-retry-20261016/package-replenishment.json)。

根目录实测：原 5 为 `865c1856-decc-4b6f-8d37-da0e54effe12`，新 5 为 `f449aee1-2e66-483c-98f1-6b1e084cd04c`。请求顺序为 `[1,2,3,4,5,5,6,7]`，整个轨迹最多 4 个可能占位；7 段输出完成，旧 5 仍未知占位。两个 5 分别属于原未知尝试和明确新授权，不存在第三次 POST。

原图片 200 请求全量屏障回归也通过：200 个完整 HTTP 请求体实际到达本地服务后才放行第一个响应，200 项登记、恢复重发 0，乱序结果逐资产归位。根目录本轮首尾到达为 53146ms（53.146 秒），这是实际本地接收时间，不是 Promise 启动时间；[证据](../.work/unknown-video-retry-20261016/200-arrivals-final.json)。历史图片验收文件已按备份恢复，当前轮证据另存，未以新结果覆盖旧报告依据。

`process-evidence.json` 记录授权、Job、ledger 预留、意图、HTTP 中、回执、批次索引七个 SIGKILL 点，以及两个进程重复同一命令：新请求在授权/Job/预留中断后只发送一次；意图无回执保持未知；HTTP 已开始但未知不重发；回执存在时使用原新 taskId。两个并发进程只有一次新 POST，稳定新 operationId 不变。

## 隔离与保留

修改前采集旧环境 53 文件 SHA-256、旧 Git 状态及 story2libtv 全局命令路径；另采集本项目 `.local` 和用户 metasocli runtime 的 10 个文件哈希。修改只在本项目及测试临时目录；真实业务故事、素材、任务、账本与凭据未用于测试。最终复核全部一致：旧环境 53 文件、旧 Git 状态、全局命令路径均未变化；凭据/旁白及个人运行目录 10 文件哈希全部不变。证据为 `isolation-before.json`、`isolation-after.json`、`personal-before.json`、`personal-after.json`。`git diff --check` 退出 0。

未新增依赖、未改图片并发或真实账本，未覆盖 `.agents`/用户级入口、LibTV 或全局配置。临时安装脚本补验新 retry 模块、文档及已安装 CLI 的 `batch retry`/`--accept-unknown-result` 帮助，安装 prefix 位于隔离目录。

## 使用方法

先查询本地记录，由 Skill 匹配目标集/段的本地 operationId。旧请求可能受理并重复计费；当前用户授权该段一次新生成后执行：

```text
node E:\metasocli\dist\cli\main.js batch retry --root <story> --batch <batchId> --operation <oldLocalOperationId> --confirm --accept-unknown-result
node E:\metasocli\dist\cli\main.js generate --root <story> --plan <planId> --segment <segmentId> --retry-of <oldLocalOperationId> --confirm --accept-unknown-result
```

批次优先补位并继续原已授权范围；没有原范围授权时只处理指定段。waiting_capacity 保留授权，随后使用同一命令或原 batch resume，不索要不存在的旧远端 ID，不清理账本。详见 [使用与恢复](VIDEO_UNKNOWN_RETRY.md)。

## 真实验证与部署边界

本轮没有真实付费 IR、图片或视频调用。供应商真实重复计费、任务恢复证据、真实四并发、限流、网络超时与成片效果尚未验收。离线通过不等于供应商请求零故障，也不等于修好了代理。

另一设备未在本轮部署。当前 package 仍为 0.1.0，本地未提交改动没有新的 GitHub SHA；旧 e781ccb 不包含本功能。已提供 [新设备修复构建说明](NEW_DEVICE_RETRY_BUILD.md)，后续授权提交/部署时须记录实际修复提交或交付包 SHA-256，不能继续检出旧 SHA 却声称已更新。
