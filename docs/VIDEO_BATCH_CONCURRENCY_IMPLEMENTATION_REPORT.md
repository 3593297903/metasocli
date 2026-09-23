# 视频四并发持续补位实施报告

日期：2026-09-21。实施位置：`E:\metasocli`，本任务单独完成，没有派发其他任务或并行写代码代理。

## 交付状态

已实现不可变批次、4个生成占位持续补位、2个独立下载、共享安装协调、CLI 和三个项目内 Skill 接入。所有新 CLI 视频请求使用原 H3 构造器，实际 JSON 为 `context_ir_enabled:true`。本次只使用假客户端及临时文件，没有调用真实 IR、图片或视频生成接口。

真实账户并发额度、真实限流响应、Metaso 对并行 true 请求的接受和计费、网络中断时的服务端行为及实际成片效果，均尚未验收。4是本地调度上限，不是已查证的供应商账户额度。

## 独立核验后的增量修复（2026-09-21）

本节对应 [独立核验报告](VIDEO_BATCH_CONCURRENCY_REVIEW.md) 的两处问题。修复前完整保留当前未提交源码、测试和文档，共122份文件快照及 Git 状态，位于 [.work/video-batch-review-fix/before](../.work/video-batch-review-fix/before) 和 [source-before.json](../.work/video-batch-review-fix/source-before.json)。没有回退整套实现，没有派发其他任务或代理。

用户给出的 `E:\metasocli.work\ts1-concurrency-review-20260921\repro-boundaries.mjs` 不存在；实际只读参考的是独立核验报告指向的 `E:\metasocli\.work\ts1-concurrency-review-20260921\repro-boundaries.mjs`。原独立核验报告、复现脚本及其结果没有覆盖。

### 本轮修改位置

| 文件 | 本轮增量 |
| --- | --- |
| `src/storage/paths.ts` | 共用 `pathIdentity` / `samePath`：绝对路径身份在 Windows 忽略大小写，其他平台保持大小写敏感；磁盘访问路径保留原写法 |
| `src/storage/locking.ts` | 项目短写队列使用同一身份规则，避免另设一套无条件小写规则 |
| `src/jobs/coordinator.ts` | 哈希校验后兼容旧 ledger 的等价路径，合并等价登记但不删除任何任务占位；登记、预留同步、项目/操作归属使用统一身份；拒绝实际不同目录共用身份；缺失的完整终态项目自动记 `retiredAt`，保留全部历史任务证据 |
| `src/jobs/batch.ts` | 查询事件按同一路径身份关联原批次集/段，不因调用路径大小写不同丢失 `order` |
| `tests/coordinator-boundaries.test.ts` | 新增13项回归，调用公开 `runCli` 参数解析及命令处理，覆盖大小写、旧 ledger、实际不同目录冲突、完成后归档、七种未决状态及空登记保护 |
| `README.md`、本报告 | 说明自动退出活动扫描的条件、归档前离线同步命令、原目录恢复规则、修复前后结果和实际验收证据 |

没有改 CLI 命令名、现有 Skill 或请求构造器；无需全局安装即可用当前本地构建入口。没有新增依赖，原 Story/Plan/Job 契约、原文/hash/cues、图片顺序、时长适配及旁白绑定代码保持本轮前的字节内容。

### 两处问题的修复前后

先加入断言正确行为的正式回归，再运行尚未修复的实现：[red-tests.log](../.work/video-batch-review-fix/red-tests.log) 实际复现3项失败（大小写1项、归档普通/旧 ledger 各1项），未将错误写成预期成功。

| 场景 | 修复前实际结果 | 修复后回归断言 |
| --- | --- | --- |
| CLI 以大写根登记，再以小写根 generate | 假 POST 返回任务后报 `RECEIPT_PERSISTENCE` | 退出0；仅1次 POST；回执、Job 均保存 `case-original-task`；切回大写根 resume 下载完成；再次 generate 复用原 operationId/taskId，仍仅1次 POST |
| 旧 ledger 的 project/slot 使用不同大小写，存在等价重复登记 | 同步可报身份冲突，批次查询事件无法关联原段 | 校验原哈希后统一归属；保留1份等价项目登记及原占位；原 `legacy-case-task` 恢复，无新增 POST；`query-result.order=0` |
| 完成项目 A 移到归档目录，再创建 B | A旧目录 `NOT_INITIALIZED`；B零 POST | A历史槽位、请求/input哈希、operationId/taskId/终态完整保留，登记增加 `retiredAt`；B正常完成；总2次 POST（A、B各1次）；恢复A原目录后再次生成仍总2次 |
| A仍是 reserved/prepared/submitting/queued/running/submit_unknown/query_unknown 时移走 | 原有保护需保留 | 7种状态均返回 `COORDINATOR_PROJECT_MISSING`，B零 POST，ledger 字节不变且占位仍为1；未知槽即便带 `retiredAt` 也不能释放；活动/未知任务恢复后不新增 POST |
| 克隆到另一个真实目录或只有空登记的目录丢失 | 不能借目录变动绕过保护 | 克隆身份被 `COORDINATOR_CONFLICT` 拒绝；没有终态历史的空登记丢失也阻止创建 |

归档判定在原共享协调锁内完成，没有新增嵌套项目锁。只有整个旧根不存在、hash 校验通过、存在历史槽位且**所有**槽位均已是 `generated/downloaded/failed/cancelled` 才退出活动扫描；成功类终态还必须有 taskId。`retiredAt` 仅是历史标记，不能替代终态检查。只缺清单、身份变化、损坏记录、预留或未知状态均不会自动忽略。旧版无此可选字段的 ledger 同样兼容。恢复原路径时重新加载并验证原项目及任务，不自动把活动项目迁移到另一个目录。

公开归档前同步命令（不收费、不联网创建）：

```powershell
node E:\metasocli\dist\cli\main.js batch register --root 'E:\metasocli\projects\已完成项目'
```

需先由正常查询/恢复确认生成终态；`batch register` 不自行向服务端查询。确认无未决名额后可移动完整项目，其他项目下一次协调时自动登记归档历史，无需删除 ledger 或重新生成。

本轮证据汇总：[boundary-regressions.json](../.work/video-batch-review-fix/boundary-regressions.json) 保存真实离线运行的原操作 UUID、请求哈希、回执 taskId、GET 的 taskId、POST 次数和批次事件；[本轮验收汇总](../.work/video-batch-review-fix/validation.json) 及对应日志记录实际执行结果。所有客户端均为假客户端，未向 Metaso 提交。

### 本轮最终实际验收

| 命令 | 最终实际结果 |
| --- | --- |
| `npm run build` | 退出0，[最终构建日志](../.work/video-batch-review-fix/build.log) |
| `npm test` | 退出0，**22文件 / 178项全部通过**，89.65秒；包含新增13项边界回归及 Windows DPAPI 测试，无跳过项；[完整日志](../.work/video-batch-review-fix/tests-final.log) |
| `npm run test:process` | 退出0，原视频2个、独立 IR 6个、批次10个 SIGKILL 边界及两项目/四个 CLI 进程竞争全部通过；[完整日志](../.work/video-batch-review-fix/process-final.log) |
| `npm run test:image-skill` | 退出0，11项通过；[最终日志](../.work/video-batch-review-fix/image-skill-final.log) |
| `.work/video-batch-isolation.ps1 -Mode verify` | 退出0，53份保护文件哈希、旧 Git 状态和全局命令路径一致；[本轮前](../.work/video-batch-review-fix/isolation-before.json) / [本轮后](../.work/video-batch-review-fix/isolation-after.json) |
| `git -c safe.directory=E:/metasocli diff --check` | 退出0；没有修改全局 Git 配置、提交或推送 |

环境限制及复核没有隐去：沙箱内首次全套为177通过、1项 DPAPI 因无法启动凭据子进程失败；进程套件最初在 `spawn EPERM` 处退出。这两次均记失败，不算通过，原日志保存在本轮目录。获准启动隔离子进程后重跑了**整个**单元套件和进程套件，得到上表结果。首次进程复核还发现“把访问路径直接小写化”会触发 Node 权限名单的 `ERR_ACCESS_DENIED`，该实现问题已修复为保留访问写法、只统一身份比较；随后原权限测试通过，未扩大子进程对旧源码的访问权限。DPAPI 仅使用临时文件和假密钥，不读取、写入真实用户凭据。

本轮重新产生的 [16段补位轨迹](../.work/video-batch-review-fix/batch-trace.json) 仍为 POST 1—16原顺序、生成占位峰值4、HTTP峰值4、独立下载峰值2，先完成第3段即补第5段；第6段下载失败后恢复，最终16段完成且总 POST 仍16。所有新视频请求的 `context_ir_enabled:true`、原文、图序、时长与旁白绑定回归继续通过。

[本轮进程证据](../.work/video-batch-review-fix/process-evidence.json) 中，已接受并保存 taskId 的边界全部沿用原 ID、恢复 POST 为0；创建结果未知仍占位且不重发；仅尚未提交的 reserved 边界可以继续原准备操作。大小写公开 CLI 回归保存的操作为 `41373b57-d6e6-4617-a254-6070326f7764`，回执及唯一查询 ID 均为 `case-original-task`，最终 downloaded，重调 generate 后总 POST 仍1。

本轮未运行真实付费 IR、图片或视频生成；真实付费并发仍未验收。临时安装验收只保留下文首次实施的历史结果，本轮未重跑、不计作本轮通过。当前未提交改动保留，没有修改旧 libcli、旧安装、全局配置/凭据、真实用户运行记录或现有 mttest/test34 业务数据。

## 实际修改

| 文件 | 用途 |
| --- | --- |
| `src/contracts/batch.ts` | 选择范围、不可变批次、哈希绑定授权、运行索引、持久化退避预算契约 |
| `src/jobs/batch-store.ts` | 按显式集/段顺序冻结 inline 计划，验证父计划/请求指纹，离线状态与已完成输出核验 |
| `src/jobs/batch.ts` | 持续补位调度，独立 POST/GET/下载队列，有限轮询和安全429退避、未知/账号异常暂停 |
| `src/jobs/coordinator.ts` | 安装级单调度器、共享预留及已知项目登记；从原 Job/receipt 重建名额 |
| `src/jobs/submission-owner.ts` | 独立提交进程/token/请求身份记录，识别受控 submitting 和真正失联 |
| `src/jobs/submit.ts`、`store.ts`、`submission-guard.ts` | 短锁保存意图/回执，POST 在状态锁外；普通生成入口使用同一共享上限；保留历史 Job 格式 |
| `src/jobs/resume.ts`、`video.ts` | GET/流式下载在状态锁外；有版本和身份检查的状态合并、单任务下载锁、终态先落盘再释放名额 |
| `src/storage/locking.ts` | 可验证文件锁、进程内短写队列、跨进程有界等待，兼容原锁恢复规则；空锁文件写入窗口有限重读 |
| `src/storage/io.ts` | 并发替换时读取完整 JSON 快照；Windows EPERM/EACCES/EBUSY 文件替换有限重试，不删除旧目标、不重发 HTTP |
| `src/storage/paths.ts` | 快速删除/重建锁文件时，按精确文件身份判断瞬时路径变化并完整重验；继续拒绝符号链接、硬链接及旧项目路径 |
| `src/metaso/client.ts` | POST120秒/GET30秒独立期限；保守判断明确429拒绝、任务 ID 冲突及账号错误 |
| `src/cli/main.ts`、`src/core/index.ts` | batch plan/run/status/resume/register，范围互斥、授权与运行目录注入、帮助和公共导出 |
| `skills/metasocli/SKILL.md`、`skills/metasocli-video-prompts/SKILL.md`、`skills/metasocli-video-prompts-旁白/SKILL.md` | 原入口接入完整授权范围的批次，未授权停在提交前，不逐段/每4段批准；旁白仍仅作用于明确含旁白段 |
| `tests/batch-helpers.ts`、`video-batch.test.ts`、`video-batch-faults.test.ts` | 批次顺序、实际并发屏障、HTTP 请求体、恢复、配额、限流、篡改与兼容验收 |
| `tests/storage-concurrency.test.ts` | 真实并发读写状态快照和快速释放文件锁，仍拒绝损坏记录/锁 |
| `tests/offline.ts`、`submit.test.ts`、`recovery.test.ts` | 每测试独立共享运行目录；活跃提交断言改为 submitting，失联仍未知；独立故障场景分开运行目录 |
| `scripts/video-batch-process-{fixture,worker,smoke}.mjs`、`scripts/process-smoke.mjs` | 真实子进程 SIGKILL 边界、两项目/多进程争用和 Node 权限隔离；旧测试也注入临时运行目录 |
| `README.md`、`docs/INLINE_CONTEXT_IR_WORKFLOW.md`、`docs/ARCHITECTURE.md`、`docs/VIDEO_BATCH_CONCURRENCY_PROPOSAL.md` | 实际命令、恢复语义、当前实现状态与限制 |

没有新增依赖或修改包版本、锁文件。H3 请求构造、原文/引用/旁白处理及时长向上取整继续复用原实现。`Story`、`Plan`、`Job` 契约未修改，历史独立 IR 底层兼容和原任务恢复测试保留；当前 CLI 不允许用 false 计划新建视频。

## 实际命令

以下 plan/status 是离线命令；run 只可在用户已授权该范围及含 IR 的视频生成后执行，本次未对业务项目执行 run。

```powershell
$cli = 'E:\metasocli\dist\cli\main.js'
$story = 'E:\metasocli\projects\我的视频'
$batch = node $cli batch plan --root $story --episodes ep-1,ep-2,ep-3 --concurrency 4 | ConvertFrom-Json
$batchId = $batch.plan.batchId
$batch.summary
node $cli batch status --root $story --batch $batchId
node $cli batch run --root $story --batch $batchId --confirm
node $cli batch resume --root $story --batch $batchId
```

`--episodes` 可换成 `--selection <selection.json>` 或 `--all-episodes`，三者互斥。选择 JSON：

```json
{"schemaVersion":1,"episodes":[{"episodeId":"ep-1","segmentIds":["s3","s4"]},{"episodeId":"ep-2","segmentIds":["s1"]}]}
```

数组决定顺序；每集、段都须存在且不能重复。`--episodes` 选整集原段序。`--all-episodes` 检测到独立 IR 历史时保守拒绝，要求显式原始范围；不按文件名猜原始集。batch plan 会冻结新的合法 inline 计划，但同请求的活动任务及合格成片会复用，不因新 planId 而重做。

`batch resume` 可以继续**已有授权批次内**尚未提交的段；未授权批次不能借 resume 生成。旧 `resume --operation`、`download`、`status` 永不创建新任务。普通 `generate/--submit-only` 共用名额，批次运行中拒绝抢占调度，不能各开4个。`batch register --root <story>` 可将已知旧任务登记到安装名额，默认不联网。

默认运行目录 `%USERPROFILE%\.metasocli-runtime`；开发测试可用 `--runtime-dir` 或 `METASO_RUNTIME_DIR` 注入。所有同一安装入口须使用同一目录，不可通过换目录绕过额度。一个活跃批次持有调度锁，其他批次默认等待30秒，`--scheduler-wait-ms` 可设0—300000，超时返回 LOCK_BUSY。它无法控制网页、旧程序、其他电脑或尚未登记的其他项目。

## 持久化与恢复行为

- 批次计划和授权：`.metasocli/batches/<batchId>/plan.json`、`run.json`，分别哈希验证。运行索引缺少操作链接时由原 Job/receipt 重建，不能借此重发。
- 提交：共享锁→短项目写锁，保存 prepared、预留、提交归属、submitting 意图后才 POST；回执先于任务索引保存。POST 不持有状态锁。创建仍收尾时不提前消耗查询预算。
- 名额：reserved、prepared（已有预留）、submitting、queued、running、submit_unknown、query_unknown 均占位。受控 submitting 有活进程/token；进程消失不会证明远端未接受。只有验证并持久化的 generated/downloaded/failed/cancelled 释放名额。
- 创建未知暂停新增，保留占位；已知任务继续查询/下载。401/402/403 或未知查询结果一经收到即暂停派发，覆盖错误落盘前的时间窗口。
- 明确拒绝、没有任何任务 ID 的429，每段最多2次重试，批次累计等待最多60000ms，次数、retryOf 和预算在新 POST 前落盘。超时、5xx、429含 ID/不明确回包不重试。普通失败段不自动付费重做。
- 下载最多2个，原 taskId 查询 URL，单任务下载锁与短项目提交锁；文件校验回执先于原子重命名，重命名后崩溃可恢复。输出按原集/段/operationId 归属。
- 同一安装的全部已登记项目共同核验。记录缺失、损坏或身份冲突保守停止，不通过删除锁/ledger 消除不确定性；本地哈希不声称供应商支持幂等。

## 首次四并发实施验收（独立核验修复前的历史记录）

以下保留首次实施的实际结果，不能替代本轮修复后的验收。本轮没有重跑临时安装测试，也未将旧安装结果计作本轮通过。所有假 HTTP/MP4 与临时项目都不使用真实业务资产或凭据；历史原文、时长、图片、旁白及独立 IR 测试均保留。

| 命令 | 实际结果 |
| --- | --- |
| `npm run build` | 退出0，TypeScript 构建通过 |
| `npm test` | 退出0，**21文件 / 165项全部通过**（最终运行181.96秒） |
| `npm run test:process` | 退出0，旧视频2个、独立 IR 6个、批次10个 SIGKILL 边界及两项目/四进程配额检查通过；竞争批次等待后接管断言通过 |
| `npm run test:image-skill` | 退出0，11项通过 |
| `scripts/package-smoke.ps1` | 退出0，离线 npm ci、干净构建及 **21文件 / 165项测试通过**（临时测试156.54秒），临时 prefix 安装/重装/卸载通过，**8个旧安装哨兵不变** |
| `.work/video-batch-isolation.ps1 -Mode verify` | 退出0，53份文件哈希、旧 Git 状态、全局命令路径一致 |
| `git -c safe.directory=E:/metasocli diff --check` | 退出0，无空白错误；只使用本次命令配置，没有修改全局 Git 配置 |

结构化验收摘要见 [.work/video-batch-validation.json](../.work/video-batch-validation.json)。测试中假客户端的耗时不代表真实 Metaso 性能；最终主套件与临时安装套件同时运行，共享本机 I/O。

修复过程没有删除历史测试或把未执行计为通过。发现并修复了下载最终落盘异常被吞掉、活锁文件尚未写完整时的竞争读取，以及创建/查询异常与下一派发之间的暂停窗口。临时安装和多进程复跑曾暴露偶发本地落盘错误；新加入的真实并发文件测试稳定复现 Windows 在目标仍被读取时原子 rename 返回 EPERM。现保留完整临时文件和旧目标，仅对该类本地文件冲突有限重试（最多15次等待、总计约1.05秒），不删除旧目标、不将 HTTP 创建放入重试。快速删除/重建锁文件导致的瞬时 canonical path 不一致，也通过精确文件身份变化判定后完整重验，真实链接保护仍保留。还固定了运行记录的原子快照，避免异步回执修改 retryOf 时哈希与写入内容不一致。未知状态测试明确区分“尚未收到未知结果”和“已收到并需停止新增”，不假定并发回执/查询的返回顺序。429 的空 error 或不合约错误码不作为明确拒绝依据，测试确认不重发。

覆盖还包括：task_id 不释放名额、同批次重跑/新同请求批次复用旧成片、普通 resume 无 POST、批次索引中断恢复、账号拒绝、有限429累计预算、5xx/超时/矛盾 ID、查询未知、来源变化后阻止新建但允许旧任务恢复、批次/授权/ledger 篡改、跨阶段/跨项目任务身份冲突，以及迟到的 running 查询不能覆盖已持久化终态。原素材变化、旁白、时长与独立 IR 恢复测试继续有效。假传输收到的完整请求体与原计划重建结果相等，包含 true、原文、图片顺序和原旁白音频内容，不仅检查配置字段。

## 可核对的补位与无重复提交证据

[16段轨迹](../.work/video-batch-trace.json) 使用3集：`ep-z` 6段、`ep-a` 5段、`ep-m` 5段，刻意不按集名字典序。对应实际事件：

| 事件 | 尚在生成的全局段号 |
| --- | --- |
| POST 1、2、3、4，在屏障中同时在途 | 1、2、3、4；HTTP 峰值4 |
| GET 3 返回 succeeded，终态持久化 | 1、2、4 |
| POST 5 | **1、2、4、5** |
| GET 1 成功后 POST 6 | **2、4、5、6** |
| 全部原序派发至16 | 生成占位峰值4、下载峰值2 |

首批慢下载故意等到 POST 8 才放行，证明补位没有等待下载完成。第6段故意下载失败一次；首次15个合格输出，batch resume 后16个合格输出，**总 POST 始终为16**。每个输出路径均断言原 episodeId/segmentId/operationId，完成顺序不改归属。

[进程证据](../.work/video-batch-process-evidence.json) 记录真实子进程终止与恢复的请求次数：

| 强制终止边界 | 中断前 POST | 恢复 POST | 结果 |
| --- | ---: | ---: | --- |
| reserved，尚无提交意图 | 0 | 1 | 同一准备操作安全继续 |
| submitting 意图已落盘、HTTP前 | 0 | 0 | 保守未知，停止新增 |
| HTTP 创建中 | 1 | 0 | 保守未知，保留占位 |
| 回执保存、终态前/后、释放名额前/后、下载重命名前/后 | 每场景1 | 每场景0 | 同原 taskId 完成恢复 |

两项目、4个普通 CLI 进程同时停在假 POST 中，第5个提交返回 CAPACITY_FULL。活跃批次期间普通提交返回 SCHEDULER_BUSY，第二批次零等待返回 LOCK_BUSY；有等待预算的竞争批次等待并在原进程结束后接管，已接受任务无新增 POST。子进程 PATH 隐藏旧 CLI，Node 权限拒绝读取 `E:\libcli\package.json`。

这些证据证明已测试的客户端路径没有重复提交；不把它表述为没有供应商幂等保证时的远端“恰好一次”承诺。

## 开发基线与隔离

开始时的 Git 状态保存于 [.work/video-batch-before/git-status.txt](../.work/video-batch-before/git-status.txt)：方案文档已有修改，任务书已存在但未跟踪。开发前复制源码/测试/Skill/文档快照到 `.work/video-batch-before`，在此基础增量修改，没有回退或覆盖他人代码。任务书字节哈希保持一致。

[保留能力基线](../.work/video-batch-preserved-baseline.json) 证明 `src/metaso/h3.ts`、`src/contracts/{story,plan,job}.ts`、`src/core/{project,planning}.ts`、`package.json`、`package-lock.json` 及原任务书均与实施前一致。小数向上取整、原文/hash/cues、图序、单旁白绑定由这些既有模块继续提供。

旧环境的 [实施前记录](../.work/video-batch-isolation-before.json) 和 [实施后比对](../.work/video-batch-isolation-after.json) 覆盖53个保护文件，包括旧 Skill、安装/命令文件、配置及已有改动文件；旧 Git 状态、全局 `story2libtv` 命令路径也一致。此比对只读旧环境，未改变全局 Git safe.directory 配置。两个全局 metasocli 提示词入口只读检查，仍指向 `E:/metasocli/skills/.../SKILL.md`；本次仅修改项目内 `skills` 正文，不覆盖全局入口或 `.agents` 转发文件。

所有新测试注入独立临时运行目录；没有写真实用户运行目录，没有修改 mttest/test34 业务数据、旧 libcli/安装/配置/凭据/Git，没有实际全局安装或 Git 提交/推送。临时安装仅使用脚本新建的临时 prefix。

## 仍待真实验收

1. 在用户另行明确授权和预算下，核对真实账号额度及是否低于4；当前离线测试不证明服务端支持4并发。
2. 验证真实429明确未受理的响应格式、Retry-After、账号余额/权限错误、创建延迟和网络中断恢复。无法证明未受理的创建仍按未知处理。
3. 验证 Metaso 对每个真实 `context_ir_enabled:true` 请求、原图/音频传输的接受、计费，以及台词、图序、旁白声线的成片遵从程度。
4. 程序退出或电脑关机后不自动本地补位/下载；重新 batch resume 才继续。未注册其他项目及外部程序不受本地共享名额控制。
