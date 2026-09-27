# 图片 API 全量提交实施报告

日期：2026-09-24。依据 `IMAGE_API_INTEGRATION_PROPOSAL.md` 的2026-09-24全量提交修订版实施，保留现有功能和原有未提交修改。没有真实付费图片/IR/视频调用，没有设置真实图片 Key、修改旧安装或推送 GitHub。

## 2026-09-24 独立核验后的两项修复

本节是本轮增量修复的实际结果；下方原实施记录保留为历史记录，不将其全量测试、临时安装成绩计入本轮。先完整读取核验报告、boundary-evidence.json、reproduce-boundaries.mjs 和全量提交方案，保存当前源码/审计文件哈希、原报告和旧证据，没有整体回退或转交其他任务。

### 实际修改

| 位置 | 本轮修改 |
| --- | --- |
| `src/images/run.ts` | 在共享账本锁及项目短写事务中，核对已保存授权、预留 operationId、资产/计划/指纹、attempt、retryOf 和准备时间。只有确属原授权且没有发送证据的 prepared/waiting_dependency 才可补缺失账本项；进入 submitting 前再次确认账本项存在。保留原 Job 身份，不清账、不重置 unknown。重试预留仍需原新尝试授权。 |
| `src/images/run.ts` | 给已完成并从 inFlight 移除的任务记录完成版本；扫描前保存版本，等待剩余 Promise 或退出前比较，期间有完成事件就重扫。恢复任务及新提交任务共用该通知规则，没有新增固定间隔、忙轮询或图片生成槽位。 |
| `tests/image-api-boundaries.test.ts` | 新增6项回归：双 Job 部分准备、扫描期间依赖完成、attempt/预留身份/发送证据异常拒绝，以及真正未知请求原样保留。响应闸门保证先观测 B 启动，再释放 C。 |
| `scripts/image-api-process-smoke.mjs` | 在原11个单 Job 强杀点之外增加双 Job 部分准备强杀；验证账本0项/历史POST0、两个预留ID及attempt保留、各一次首次发送、再恢复0次发送。 |
| `package.json` | `test:image-api` 纳入新增边界测试文件。无依赖或锁文件变更。 |
| 本报告 | 增补本轮红/绿回归、HTTP到达测量、进程和隔离证据。 |

产品实现只增量修改 `run.ts`，CLI、Skill、请求/响应协议、原 Story/Recipe/视频 Plan/Job 均沿用现有实现。现有测试断言和200请求测试没有改写；原审计报告、证据和复现脚本字节保持。

### 先失败，再修复

证据目录：`E:\metasocli\.work\image-audit-fix-20260924`。

修改生产代码前只增加两条正确行为回归并执行：**2/2失败**（`regression-before.log`）。第一条要求恢复后登记2项，实际为0；第二条将C保持未完成，B未在5秒保护截止前启动。截止时间只用于使错误实现明确失败，不作为生产调度机制，也不按定时器放行C。

完成修复后原两条断言不变，**2/2通过**（`regression-after.log`），增加保护用例后**6/6通过**（`boundaries.log`），随后同样6项纳入37项图片专项再次通过。

| 问题 | 修复前 | 修复后实测 |
| --- | --- | --- |
| 第一项Job保存后、第二项保存前中断 | prepared缺账本；resume将未发送任务误变unknown，登记0项。 | 先按原授权补账，再首次发送；两项均registered，operationId/attempt不变，各发送1次，再resume新增0次。 |
| A在扫描B之后、提交C期间完成 | A的Promise已移除；循环只等C，B被拖住。 | 确定性轨迹为 `A registered and settled during scan → C started → B started → C released`；B实际带A的图片哈希及edits引用，3项均登记，再resume新增0次。 |

双 Job 真正SIGKILL的身份/发送证据（`process-evidence.json` 的 `partial-prepared`）：

| 资产 | 中断前预留ID = 恢复后ID | attempt | 历史POST | 恢复首次POST | 再次resume新增POST |
| --- | --- | --- | --- | --- | --- |
| first | `4a53455b-4eed-4907-a88a-d26deddb9d3a` | 1 | 0 | 1 | 0 |
| second | `59833886-20cd-4c27-831c-54e82908545f` | 1 | 0 | 1 | 0 |

这些POST计数来自隔离假客户端，未触及供应商。单元回归另保存 `partial-prepared.json`（原授权/原预留/恢复身份）和 `dependency-wakeup.json`（严格事件顺序）。真正unknown回归及原强杀测试仍保留未知状态，不重发；只有尚未进入发送步骤的预留才继续首次提交。

### 本轮200完整HTTP请求与实际测试

`200-arrivals.json` 使用本地HTTP服务对**完整请求体收齐时点**计时，仍要求200个完整请求全到达后才返回任何成功响应；随后200路开始流入磁盘，再乱序完成并逐项核对实际图片字节。测试没有用Promise数、本地意图时间或requestStartedAt代替到达证明。

| 实测指标 | 本轮结果 |
| --- | --- |
| 第一个完整请求到达（Unix毫秒） | 1790217693809 |
| 第200个完整请求到达（Unix毫秒） | 1790217737442 |
| 首尾到达跨度 | **43633ms（43.633秒）** |
| 平均/最大相邻到达间隔 | 219.26ms / 334ms |
| 第一次成功响应时点 | 1790217737442，在第200项收齐之后放行（毫秒粒度差值0） |
| 完整请求 / 开始接收的响应 / 正式登记 | 200 / 200 / 200 |
| 乱序回收 | 200项assetId/operationId及图片哈希逐一核对通过 |
| resume新增POST / 恢复后revision | 0 / 201（不增加） |

本轮43.633秒、原实施115.275秒、独立审计50.107秒不属于同条件性能基准，不能据此宣称代码提速或供应商受理速度。完整原始到达列表在本轮证据目录；原实施200到达/进程证据另备份于 `before/`，测试结束后已恢复原路径旧字节，避免历史报告与新测量混用。

| 实际运行 | 本轮结果与日志 |
| --- | --- |
| `npm run build` | 通过，当前dist已更新。`build.log`。 |
| `node node_modules/vitest/vitest.mjs run tests/image-api-boundaries.test.ts --pool=threads` | 修复前2失败；修复后2通过；补充保护后6通过。 |
| `npm run test:image-api` | **37/37，3文件通过，346.45秒**；包括200真实本地HTTP、独立凭据DPAPI、图片/视频阶段互斥、原视频ID恢复、重试授权和全部新增边界。`image-api.log`。 |
| `npm run test:image-skill` | **12/12通过**，含原built_in兼容和真实落盘假API证据交接。`image-skill.log`。 |
| `npm run test:image-api:process` | **12个SIGKILL点 + 双进程quota争用通过**；原ID/未知保护及零重复发送保持。`image-process.log`、`process-evidence.json`。 |
| 定向视频回归（下列命令） | **87/87，8文件通过，150.28秒**；四并发持续补位、独立下载、context_ir_enabled:true、旁白、小数时长、路径/归档、单任务/批次恢复。`video-regression.log`。 |
| `npm run test:process` | 原2个视频、6个IR、10个批次强杀点及4进程争用通过；使用原ID、没有重复创建或突破并发限制。`video-process.log`。 |

```powershell
node node_modules/vitest/vitest.mjs run tests/video-batch.test.ts tests/video-batch-faults.test.ts tests/coordinator-boundaries.test.ts tests/submit.test.ts tests/recovery.test.ts tests/inline-context-ir.test.ts tests/duration.test.ts tests/narration.test.ts --pool=threads
```

沙箱限制已实际复核：图片进程测试首次为 `spawn EPERM`，保留 `image-process-sandbox.log`；获准使用正常进程权限后完整通过。图片专项包含Windows假Key DPAPI，依据既有审计的沙箱限制，直接在获准的正常进程权限下执行并通过；没有操作真实凭据。原视频进程测试同样使用该权限范围。没有删测试或把未运行记为通过。本轮没有重跑全部 `npm test` 或临时安装；上面的定向回归和专项是本轮实际执行范围。

### 隔离与未验收边界

所有写入位于本项目及其隔离测试目录。以本轮开始时单独捕获的基线再次核对：**53份旧环境文件哈希、E:\libcli的Git状态、全局story2libtv命令路径均一致**，`isolation-after.json` 的 differences 为空。当前已有未提交修改保留，源码增量清单/审计文件哈希见 `changes.json` 和 `preserved-baselines.json`。没有写旧安装、旧Skill、配置、凭据或mttest业务数据，没有提交或推送。

以上证明本地离线调度、恢复、映射和隔离行为；**真实付费调用为0，供应商能力仍未验收**。真实权限/费用、模型实际执行、edits编码兼容、生成质量、参考图和prompt上限、URL有效期、连接时长及并发/RPM/排队能力继续待授权实测。没有宣称供应商可接收或同时推理200项。普通单项 `images recover` 后仍按现有用法 `images resume` 完成原图片计划收尾，本轮未改变该流程。

## 原实施记录（以下为修复前历史交付）

## 实际实现

- 新增 `src/images/{contracts,planning,client,stream,store,coordinator,phase,result,run,credentials}.ts`。独立 yiciyuang/gpt-image-2.5 profile、凭据、冻结计划、授权、任务、回执及账本；原 Story/Recipe/视频 Plan/Job 契约没有改默认字段或哈希语义。
- generations 使用完整原提示词、JSON、n=1；edits 使用有序真实文件、单图 image/多图重复 images 的 file-backed FormData。无图片生成槽位、固定发送间隔、自动付费重试或虚构任务查询。
- 全部 ready 请求逐项写意图后立即启动 HTTP；响应不等解码/下载名额，先流式写独立文件和完成证明。默认下载2、解码2、登记1；独立响应45MiB/图片30MiB/结构化记录8MiB限制、磁盘预检及运行预算。参考输入按哈希共用快照并计入预算。
- prepared、submitting 和完整响应区分持久化；断线/未知不会重 POST。一个失败不取消已发出的其他结果。收到原响应、URL、图片或已登记文件后只恢复缺失步骤。显式人工关联原结果、按请求证据解除未知、已确认失败的新 attempt/retryOf 都有独立记录。
- `assets/registry.ts` 增加同一短写事务的条件登记；用户替换目标/依赖时保留返回文件，不覆盖选择。同字节登记不增加 revision，缺失的正式副本可从原结果恢复。图片计划不因其他图片正常登记而过期。
- `core/planning.ts`、`jobs/submission-guard.ts`、`jobs/batch.ts` 增加项目图片/视频阶段互斥。图片与视频共享协调锁不嵌套；已有视频 ID 的单任务恢复和已授权 batch resume 可继续查询/下载，后者在图片阶段只暂停新提交。视频仍最多4段生成、2下载、每个新请求 context_ir_enabled:true。
- `cli/main.ts` 与公共 Core exports 接入 images 命令。凭据在首次新提交前检查并在当前进程复用，不为200请求重复启动解密子进程。普通状态/离线计划无需 Key，已有结果恢复不加载 Key。
- 新增 `scripts/connect-image-local.mjs` 和 `examples/image-provider.json`。原 Metaso 连接脚本/凭据模块未改。安装包包含独立图片连接脚本，仍只有 metasocli 一个 bin。
- 更新本项目图片 Skill、三个上游入口、handoff 契约/校验器。保留旧1.0.0 built_in/not_run；API result1.1.0 校验真实 Job/请求/提示词/回执文件及哈希，requestedModel 与 reportedModel 分开，requireExactModel=true 仍拒绝无法核实的保证。旁白不进入图片任务。
- README、START_HERE、ARCHITECTURE、SOURCE_BASELINE 和 [实际用法](IMAGE_API_USAGE.md) 已补齐当前流程。原分析/方案文件保持开始时字节，不用修改用户原方案来冒充验收状态。

## 实际命令

开发入口：`node E:\metasocli\dist\cli\main.js --help`。完整配置、连接、范围选择、恢复和人工证据格式见 [IMAGE_API_USAGE.md](IMAGE_API_USAGE.md)。

```powershell
node E:\metasocli\dist\cli\main.js images plan --root <story> --episodes ep-1,ep-2 --profile E:\metasocli\examples\image-provider.json --submission-mode all-ready
node E:\metasocli\dist\cli\main.js images status --root <story> --plan <imagePlanId>
# 以下 run 必须有覆盖图片供应商及该冻结范围的明确生成授权：
node E:\metasocli\dist\cli\main.js images run --root <story> --plan <imagePlanId> --confirm
node E:\metasocli\dist\cli\main.js images resume --root <story> --plan <imagePlanId>
node E:\metasocli\dist\cli\main.js images recover --root <story> --operation <operationId>
```

images resume 可发送原授权内尚未提交项；recover 永不创建。准备和计划后，未获相应收费阶段授权则暂停。所选图全部 ready 后离线检查实际 H3 九图/64MiB/旁白组合，再由原入口新建视频计划；图片生成授权不授权视频生成。

## 离线证据与恢复

200请求测试使用真实本机 HTTP 连接，服务端收齐200个完整 JSON 请求体后才返回成功响应头。随后各连接先写一小段，客户端确认200路均已落盘开始后，服务端按打乱顺序结束响应。每张 PNG 有独立字节，逐一核对 assetId/operationId 与正式资产哈希，恢复后 POST 增量为0。这里证明本地 HTTP 全量启动能力，不代表供应商受理或同时推理200项。

证据：`E:\metasocli\.work\image-api-20260924\200-arrivals.json`（每次完整请求时间、字节数、哈希、服务端放行时间、乱序完成序、200登记及0重复POST）。最终本项目专项中第一至第200个完整请求体跨度为 115275ms，首次成功响应在收齐第200项之后放行（毫秒时间差 0）；正式登记200项，resume新增POST为0，revision仍为201。汇总见同目录 acceptance-summary.json。

进程证据：`.work/image-api-20260924/process-evidence.json` 和 `image-process.log`。11个 SIGKILL 点：prepared、intent、POST进入后、响应前、部分响应、完整响应保存、有效回执保存、下载前、下载后、登记前、登记后。prepared 恢复后仅发首次POST；intent后但尚未进入HTTP为未知且总POST为0；POST后无完整响应为未知且总POST为1；完整响应及后续步骤恢复均总POST为1。所有原 operationId 保留。另有双进程 quotaGroup 互斥及死进程所有权回收测试。

回归另覆盖：显式重试在Job落盘前中断仍保留预留ID/attempt/retryOf；真实有序单图/多图 multipart；依赖图登记后不等待无关慢图；401/402/403/429/5xx、断线、损坏/空JSON、无效Base64、错误尺寸、过期URL、存储失败；完整45MiB流边界及部分文件留证；用户换图/换依赖；同资产互斥、ready复用、独立凭据；九参考图及原旁白、H3总请求超限定位；小数时长和历史视频行为。

## 验收执行记录

所有测试使用项目 `.work/image-api-20260924/tmp`、假Key/假客户端或127.0.0.1。初次沙箱运行保留了失败日志：Node子进程为 spawn EPERM，Windows DPAPI加解密不可用。没有删除/跳过相应用例；在经允许的测试执行环境复核。

| 实际命令 | 实际结果 |
| --- | --- |
| npm run build | 本项目通过，dist 已生成；无新增依赖，package-lock 原字节保持。 |
| npm test | 本项目全量207项通过；当时已包含图片契约和200请求测试，后续两个新边界另纳入专项及最终副本全量验收。 |
| npm run test:image-api | 最终31/31通过，2个文件，324.73秒；本地HTTP门槛和全部恢复/故障检查均通过。 |
| npm run test:image-skill | 最终12/12通过，含真实落盘的假API执行记录与旧built_in交接。 |
| npm run test:image-api:process | 11个SIGKILL点和双进程quota互斥通过；原ID保留、无重复POST。 |
| npm run test:process | 原2个视频、6个IR、10个批次中断点及4进程争用检查通过。 |
| scripts/package-smoke.ps1 | 通过：独立源码副本 offline npm ci 安装50个开发依赖，check 内 build 通过、24文件209/209项测试通过（296.52秒）；临时 prefix 安装/重装/卸载成功，8个旧安装哨兵哈希不变，旧CLI在PATH不可见。 |

日志均在 `.work/image-api-20260924/`：`npm-test.log`、`image-api.log`、`image-skill.log`、`image-process.log`、`old-process.log`、`package.log`。初轮图片专项有一条测试把 createBatchPlan 的返回值误当成计划本体，已按公开返回的 plan 字段修正并全量重跑31项通过，没有把错误行为改为预期。早期进程争用测试的保活逻辑也已修正，并重新验证真正同时存活的两个进程。

## 旧环境边界

开始时除原分析文件已修改、原方案文件未跟踪外，无其他源码改动。保存了 `.work/image-api-20260924/before/`、`source-before.json` 和 `git-before.txt`，没有回退用户改动。

2026-09-21旧比对基线在本次开发前已有两项差异：用户 `.codex/config.toml` 和 `.libtv/credentials.json`。本次仅做文件哈希比对，没有读取显示Key或修复这些外部差异；记录在 `prior-baseline-differences.json`。本次另捕获当前53文件基线及旧Git状态/命令路径，最终临时安装测试结束后再次比对通过：53文件哈希、旧Git状态、全局命令路径全部与开始时相同。不把旧日期差异归因于本次修改或隐瞒。另以 preserved-baselines.json 确认 AGENTS、用户原分析/方案、package-lock、Story/Plan/Job契约、原Metaso凭据模块和连接脚本的字节均保持。

## 尚未真实验证

公开契约来源：[创艺坊专属文档](https://newapi.yiciyuang.com/docs/exclusive-gpt-image-2)，以只读页面核验。以下仍须未来获得明确次数/费用授权后验收：真实图片账户权限/扣费、模型别名及服务端实际执行、生成效果/中文设计板、尺寸映射、edits多文件编码、参考图/提示词上限、URL/CDN重定向/有效期、连接超时、并发/RPM/服务端排队。没有服务端批量/幂等/查询契约时，同步请求中断后的未知创建可能需要人工恢复。

此次没有发起真实付费图片、IR或视频请求，也没有覆盖全局命令、旧Skill、旧配置/凭据、mttest业务数据，未提交或推送Git。
