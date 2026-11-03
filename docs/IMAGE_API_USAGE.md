# 图片 API 实际用法（2026-09-24）

## 固定准备与结果收集（2026-11-02）

新增本地 `images prepare`、`images collect`，六个项目 Skill 共用 [固定工作流](../skills/metasocli-reference-images/references/image-workflow.md)。完整配方已确认后，使用 [清单示例](../examples/image-batch.json)，将 projectId 换成当前故事 UUID，输入路径以故事根为基准：

```powershell
node E:\metasocli\dist\cli\main.js images prepare --root <story> --batch <image-batch.json>
node E:\metasocli\dist\cli\main.js images prepare --root <story> --preparation <preparationId>
# 仅在既有授权覆盖图片供应商、冻结范围和本次尝试后运行：
node E:\metasocli\dist\cli\main.js images run --root <story> --plan <planId> --confirm --summary
node E:\metasocli\dist\cli\main.js images status --root <story> --plan <planId> --summary
node E:\metasocli\dist\cli\main.js images collect --root <story> --preparation <preparationId>
```

prepare 的两个输入互斥；prepare/collect 可指定 `--python <Python可执行文件>`，必须实际执行包内 Python 3.10+ 校验，缺失时返回错误，不安装软件。两命令不读取/解密 Key、不构造网络客户端、不生成/下载/登记图片。已有正式计划直接走原命令，不要求创建准备记录或迁移旧故事。`--summary` 同样适用于原 run/resume/retry，只改变返回格式；旧默认 JSON 不变。

准备目录为 `.metasocli/image-preparations/<preparationId>/`：input.json 和 inputs 保存完整字节与哈希，state.json 保存逐集检查点，plan-intent.json 保存完整冻结计划，summary.json/timings.json 保存可重建摘要及阶段计时，collections/<UUID>/ 保存各次收集。by-input 只是可重建索引；摘要/索引不是授权或事实来源。同输入指纹复用 ID，登记媒体与 revision 的正常推进不会重建计划；原文 basename、规范化区间、提示词、图序、旁白和旧正式计划 schema 保持。仅本故事准备租约，不持有 project.lock 嵌套调用 import，不恢复全局运行锁。

导入仍逐集原子操作，不是全剧事务。失败摘要给出已保存检查点及实际观察到的已导入集；原命令恢复会复核这些集，用户中途编辑不被覆盖。计划先完整保存 intent 再写正式计划，最后记录准备完成；中断在任一步都验原 intent 并复用同一计划。冲突/损坏保留证据并拒绝，不能删记录重做来掩盖未知任务。

collect 只使用冻结范围、run 中准确 operationId 以及现有 Job/receipt/execution/原暂存图的真实证据，验证原文件字节后调用旧 result 校验器。部分集不会输出伪完整 result：未知/执行中/待下载或登记/范围外项留在 collection-report.json；已完成图片可立即展示。recipeSha256 是规范化 prompt 哈希；executionSha256 是文件原始字节哈希；reportedModel 缺报为 null。重复收集写新目录，不重编码、不重新登记、不修写旧 Job/账本。读取期间变化有界重采样，持续变化明确报错。

退出码：成功准备、完整可表达的结果交接为0；部分收集或原执行需处理为2；参数/输入/证据/权限等错误为1。完整交接可以含有明确失败，须继续看逐项状态，不能把退出0理解成全部生成成功。摘要独立统计 unknown、failed/rejected、各接收/登记阶段，异常最多显示50项并保留总数和原记录位置。计时为本地单调耗时及 UTC 时间戳；localStartToHeadersMs 不是供应商受理/推理时间，没有响应头时为 null。

本阶段不改变 all-ready、有效600秒、共享额度、下载/解码队列、视频四名额或 H3 参数。没有第二阶段长期缓存或整剧事务。离线实测与限制见 [本轮实施报告](../.work/image-workflow-implementation-20261102/implementation-report.md)（本机交付证据，不随 npm 包分发），不以准备成功代替真实 API 验收。

本项目默认使用独立 `yiciyuang` 图片后端，请求模型固定 `gpt-image-2.5`。它是供应商别名，请求该名称不证明底层型号。已实现本地 all-ready 工作流；真实生成效果、账户权限、余额、并发/RPM、连接时限和 URL 有效期以实际账户和验收记录为准。

接口依据是公开[专属文档](https://newapi.yiciyuang.com/docs/exclusive-gpt-image-2)：无参考图 POST `https://api.yiciyuang.com/v1/images/generations` JSON；有参考图 POST `/v1/images/edits` multipart，单文件 `image`、多文件按依赖顺序重复 `image[]`。每资产一个完整 prompt、n=1。多文件字段已于2026-10-19以image[]取得真实成功回执并登记文件，不能据此承诺所有供应商请求均成功；没有批量/轮询/task_id 协议，没有自动 POST 重试。

## 准备配置和独立凭据

开发入口是 `node E:\metasocli\dist\cli\main.js`。先在项目运行 `npm run build`。不安装全局命令。

无密钥配置样例：[image-provider.json](../examples/image-provider.json)。显式 `--profile` 优先，否则读取本安装 `.local/image-provider.json`，文件不存在用契约默认值：api / yiciyuang / gpt-image-2.5 / all-ready。因此无需创建本机配置文件才能使用默认参数。参数随图片计划冻结；修改配置不会改变已有计划。原 Story/Recipe、视频模型和旧计划哈希没有新增默认字段。

图片独立读取 `METASOCLI_IMAGE_API_KEY`，或本安装 `.local/image-credentials.json` 中绑定上述 origin 的 Windows 当前用户 DPAPI 密文。不会使用 `METASO_API_KEY`。没有 `--api-key` 参数；不要将 Key 写入聊天或 JSON 配置。

```powershell
node E:\metasocli\scripts\connect-image-local.mjs
node E:\metasocli\dist\cli\main.js images auth-status
```

连接脚本启动短时 loopback 表单并输出 setupUrl；在浏览器打开这个本机地址。表单仅加密保存用户输入，不调用生成或远端认证。已有凭据文件会拒绝覆盖；保存成功只说明本机已配置。此实施任务没有运行连接表单、绑定真实图片账号或读取真实密钥。非 Windows 使用独立环境变量。

默认人物/场景/道具横板1920x1088、竖首帧1088x1920，均不标成2K/4K或精确16:9/9:16。`sizes` 可按 assetId 指定文档列出的1024x1024、1536x1024、1024x1536、1920x1088、1088x1920、2048x2048、2560x1707、1707x2560、4096x4096。原配方明确更高规格时必须配套显式尺寸，不删规格字样绕过检查。

## 收齐本次范围再提交

三个原入口名称不变，图片 Skill 未指定后端时默认 api，不再询问后端选择；当前任务明确指定的后端优先，built_in 仅在用户明确选择时使用。先收齐选定全部集/段的素材身份、完整类型模板提示词、依赖、逐段引用，再校验逐集交接并 import；跨集同 ID 去重、真实 ready 图复用，旁白单独登记。缺少图片 Key 时停在离线图片计划，不自动调用宿主生图；已有冻结计划和未完成请求按原身份恢复，不因默认值变化重新生成。默认后端不代替本次供应商及生成范围的授权。

以下 plan/status/help 不生成图片；run 和 retry 必须已获得覆盖该供应商、该范围及新尝试的授权。

```powershell
node E:\metasocli\dist\cli\main.js images plan --root <story> --episodes ep-1,ep-2 --profile E:\metasocli\examples\image-provider.json --submission-mode all-ready
node E:\metasocli\dist\cli\main.js images run --root <story> --plan <imagePlanId> --confirm
node E:\metasocli\dist\cli\main.js images status --root <story> --plan <imagePlanId>
```

范围互斥：`--episodes`、`--all-episodes`、`--assets a,b` 或 `--selection file.json`。selection 结构为 `{"episodes":[{"episodeId":"ep-1","segmentIds":["s1","s2"]}]}`。只取实际引用及依赖闭包；`--assets` 可显式补独立素材，不包含 narration。素材 ID、原文和顺序不改变。

所有输入已就绪的项独立启动；200 个独立 ready 项发出200次请求，不等第一张生成完成。首次为160张、40张依赖时会准确报告等待；原参考图实际登记后立刻释放后续就绪请求。HTTP 响应先逐项流式落盘，再进行默认2个解码、2个下载和1个登记。这些是接收后的限制，不是图片生成槽位。视频仍四并发持续补位、两个下载。

同一个故事同时只有一个图片运行进程，不同故事可同时 all-ready。相同 quotaGroup 的已知 providerLimits.concurrent/rpm 共享预留和时间窗口；不足时保存 IMAGE_CAPACITY_WAIT，原计划 resume 继续。batch 小于冻结待提交范围仍在任何 POST 前报错，source/checkedAt 仍必需。无已知限额不加任意并发数字；不声称供应商能受理200项。详见 [项目隔离、等待参数与冷切换](PROJECT_ISOLATION.md)。

每项响应最多45MiB，图片最多30MiB，结构化记录保持8MiB；图片尺寸256–5760、比例0.4–2.5，且实际尺寸须匹配请求尺寸。不自动压缩、裁图或删引用。启动按每个待发项“最大响应+三份最大图片+256KiB元数据余量”并加上尚需建立的去重参考快照做保守磁盘预检，运行时限制临时存储；200个独立项默认约26.42GiB基础预留，实际结果通常更小，不能因此忽略磁盘要求。供应商 usage 元数据最多16KiB、revised_prompt 最多128000字节，超出保留完整原响应并报告契约错误。

## 状态和查看结果

状态输出含 assetId、operationId、请求模型/size、引用集/段、preparedAt/requestStartedAt/responseHeadersAt/responseSavedAt/receiptSavedAt/downloadCompletedAt/registeredAt。requestStartedAt 是本地持久化提交意图时点，不是供应商接受证明；原生 fetch 不提供可靠 requestBodySentAt，因此不伪造该字段。

汇总包含 total/reused/waitingDependency/notStarted/started/inFlight/received/registered/rejected/unknown。`received` 表示有效结果契约已保存，HTTP 200 本身不算成功。`run.unlocks` 记录实际依赖解锁。`status` 随时可看已完成项及其本地文件，不必等整批。结束时生成 `.metasocli/image-runs/<planId>-index.md` 图片索引；每项执行事实在 `image-receipts/<operationId>/execution.json`。reportedModel 仅来自返回字段，缺报保持 null。

图片任务、回执、输入快照和运行分别在 `.metasocli/image-jobs/`、`image-receipts/`、`image-inputs/`、`image-runs/`；共享账本在 `<runtime>/images/<quotaGroup>/ledger.json`，不占 video-ledger。正式图片使用原 assets 登记路径，原返回文件保留在 `.metasocli/drafts/assets/<operationId>/`，不会把临时供应商 URL 直接用于视频。

所有必要图 ready 后，`<planId>-video-check.json` 离线构造所选段 H3 请求，定位九图、64MiB及旁白冲突。检查失败保留图和正文，不缩减引用。原入口随后重新执行 `plan --workflow h3-inline-ir` / `batch plan`，视频仍需独立授权；未授权时暂停。新视频请求继续 `context_ir_enabled:true`。同一故事图片阶段未解决时禁止新视频计划/提交；已有视频 ID 的 resume/status/download 可继续。

## 中断与人工恢复

```powershell
node E:\metasocli\dist\cli\main.js images resume --root <story> --plan <imagePlanId>
node E:\metasocli\dist\cli\main.js images recover --root <story> --operation <operationId>
```

**images resume 会继续原授权内尚未发出的项**，没有该冻结计划的授权索引则拒绝。recover 只读取原响应、下载和登记，永不创建。prepared/waiting_dependency 与 submitting 分开；有意图却无完整响应是 submit_unknown，不能重发。已保存完整响应、URL、下载或登记文件会从缺失的步骤恢复；下载失败不重生。

401/402/403/429、5xx、断线或存储错误停止尚未发出的请求，已经在途的其他成功结果继续保存。HTTP错误和实际 Retry-After 留在回执。未知请求不会靠时间、进程死亡或新计划解除。用户更换目标/依赖时旧结果保留为冲突或 superseded，不能覆盖新选择。暂存结果/部分响应不自动删除，避免破坏恢复证据。

找回原请求结果后：

```powershell
node E:\metasocli\dist\cli\main.js images attach-result --root <story> --operation <id> --file <original-result.png> --expected-sha256 <hash> --confirm-result-link
```

这是用户明确关联，记录 recoveredManually；文件必须技术合格且与哈希一致，不能用任意补图证明供应商未执行。只有获得未受理/已终止的明确证据时，才能执行：

```powershell
node E:\metasocli\dist\cli\main.js images resolve --root <story> --operation <id> --outcome not-created --evidence <evidence.json> --confirm-resolution
node E:\metasocli\dist\cli\main.js images retry --root <story> --operation <id> --confirm
```

证据结构：`{"operationId":"<id>","requestHash":"<原请求hash>","outcome":"not-created","source":{"kind":"provider-support","reference":"<工单/日志编号>","statement":"<明确未受理或已终止的事实>"}}`。kind 也可为 provider-request-log，outcome 也可 failed。工具核对身份并标记 user-reported/independentlyVerified:false，不把任意 JSON 当服务端证明。retry 是新授权的新 attempt，保留 retryOf；unknown 禁止 retry。人工处理后 resume 原图片计划，恢复其他项并结束图片阶段。

同步 HTTP 无供应商查询契约，关机可能使未返回请求永久未知；CLI 不提供常驻后台保证。所有 URL 下载均不携带图片 Key，拒绝未验证重定向。标准输出对密钥和链接脱敏，原始回执仅本地用于恢复。

### 图片等待窗口（2026-11-03 调整为600秒）

图片创建请求默认等待600秒（`generationTimeoutMs: 600000`）。原300秒设置（包括历史计划冻结的 `300000`）在后续新请求中按600秒执行；其他设置的有效总时限为 `min(generationTimeoutMs, 600000)`，因此其他显式更短时限仍生效，超过600秒的值封顶为600秒。正式客户端通过锁定版本的 undici、请求级 dispatcher，将底层响应头/响应体等待与该有效时限对齐。旧计划字段、哈希、请求和回执保持不变；超时适配不会重新提交历史未知请求。已经启动的旧进程不受此次构建影响。

计时从每项创建请求发起时开始，覆盖该请求及其响应体接收，不是整批工作流或Codex聊天的总耗时。只作用于图片创建请求，沿用当前连接/代理 dispatcher，不修改全局网络设置或视频/独立图片下载请求；普通 CLI 无需额外 `--import` 临时脚本。升级需按锁文件安装依赖并重新构建。

HTTP 400 的完整回执若包含已知 `upstream_text_reply`，状态信息会指出供应商返回了文字而非图片。完整原文仍保存在该 operation 的 `response.bin`，不会把任意供应商文本、提示词或 URL 复制到公共错误信息。该诊断不证明未扣费，不将未知状态改为可自动重试；恢复不会重新 POST。

连接错误仍为 `IMAGE_TRANSPORT_UNKNOWN`，保留旧请求且不自动重发；诊断只记录允许名单中的错误码（如 `UND_ERR_HEADERS_TIMEOUT`、`ECONNRESET`）、总时限标识和实际有效时限，不输出原始异常消息、认证头或签名链接。完整HTTP错误响应仍按原样保存；达到600秒后停止等待不代表供应商已经停止生成。

## 离线验证

`images prepare` 会将选中素材与冻结交接决定逐项核对，包括故事中继承的旧配方。选中 `blocked` 返回 `IMAGE_PREPARATION_BLOCKED` 并保留快照；选中 `skipped_optional` 或共享资产决定冲突返回 `IMAGE_HANDOFF_CONFLICT`，不会生成可提交计划。已有准备记录和计划意图恢复也执行该核对，不以旧校验标记跳过。范围外的禁止生成项不阻止独立范围。

`images status --summary` 与 `images collect` 在新计划尚无 run 时，会只读解析 `recover` 条目冻结的原 operationId，并验证原任务归属。未知、响应已保存、待下载、待登记分别显示；缺失或不匹配记录报错。原任务保留原 planId，收集结果不足时只输出部分报告，不请求供应商或自动重发。

重复准备先校验历史记录的元数据和指纹，再完整验证匹配输入的快照。无关旧内容损坏不阻止新范围；匹配内容损坏、显式恢复目标损坏及元数据损坏仍拒绝，不删除历史记录。

在项目目录并将 TMP/TEMP 设为 `.work/image-api-20260924/tmp` 后：`npm run build`、`npm test`、`npm run test:image-skill`、`npm run test:process`、`npm run test:image-api`、`npm run test:image-api:process`。最后一项启动并强制终止自己的假客户端子进程；不需要真实 Key。结果和环境限制见 [实施报告](IMAGE_API_INTEGRATION_IMPLEMENTATION_REPORT.md)。


## 用户明确再次生成：一次性图片计划重试

默认未知图片请求仍禁止自动重发。只有当前用户明确要求再次生成，且已说明可能重复计费时，使用以下正式入口；不把502改成假失败，不伪造供应商证据。

先完成新设计及全部import（变更配方使用新assetId并保留原文历史），然后离线建立一个原计划的后继：

```powershell
node E:\metasocli\dist\cli\main.js images plan --root <story> --episodes <ordered,ids> --submission-mode all-ready --restart-of <previousImagePlanId>
node E:\metasocli\dist\cli\main.js images run --root <story> --plan <newImagePlanId> --confirm --accept-unknown-result
```

原计划只能绑定一个已授权后继。新计划冻结当前素材配方、引用、范围和请求预算；run保存原未知operationId与requestHash的明确接受记录。旧未知、原回执、请求占位和成功图片全部保留；只将原计划中确认从未进入提交的等待项标记superseded。旧计划不能继续派发，新后继中同一素材每项至多一个新operationId；同assetId的新尝试保存retryOf和单项授权。本项目新一轮出现的未知仍阻断本项目未发送项；其他项目未知仅保留配置额度中的可能占用。重试需要用户当前授权，不能自动循环建立后继。

恢复只用 `images resume --root <story> --plan <newImagePlanId>`；不再次新建后继，不重新发已提交项。新尝试再次502/断线时仍保留为submit_unknown；先保存已返回的其他结果，再报告准确缺项。该功能不修复供应商网关故障，也不承诺并发容量或底层模型。

### 明确任务中断的原始API证据

`images resolve`另支持`source.kind=provider-api-response`，仅用于`outcome=failed`。`source.reference`必须是本operation的`.metasocli/image-receipts/<id>/complete.json`。CLI实际核对请求身份、完整回执与原始响应字节哈希，并要求HTTP503及`error.type=server_error`、`error.code=task_interrupted`；普通502/503、无明确终态或不完整响应继续保持未知。通过后记录原始bodySha256与providerResponse，independentlyVerified仅表示该原始API证据已核对，不证明未扣费或底层模型。该操作只解除已明确终止任务造成的阻塞，不授权重新生成该失败项；resume只继续原授权内尚未提交项。

原始API证据还可核对HTTP500/new_api_error/convert_request_failed，且message以image is required开头、原请求为带参考文件的images/edits。该明确的生成前参数转换拒绝仅可解除为not-created；CLI核对相同原始响应字节与请求身份，保留供应商request id。修复多图字段须使用新operationId和正式授权，不能覆写旧请求或把通用500解释成未受理。

## 旧跨项目确认参数兼容（2026-11-02）

其他故事的未知默认不阻止当前故事 ready 项，不再需要 `--accept-existing-unknown`。原参数仍接受精确的其他项目旧未知 operationId，并校验 root/projectId/planId/assetId/fingerprint/requestHash；保存的 acceptedExistingUnknown 字段继续验哈希和保留审计意义，只核对共享快照，不重新打开其他故事文件。当前项目未知不能用此参数绕过。

原 `images resume --root <story> --plan <imagePlanId>` 保留范围、operationId、attempt 和原授权；不需要再确认。仅在当前用户要求记录指定旧请求时才添加兼容参数，resume 不能新增确认。默认隔离不授权重发旧任务，不释放未知容量；已知额度不足按 [容量等待](PROJECT_ISOLATION.md) 恢复。
