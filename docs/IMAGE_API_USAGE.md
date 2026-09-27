# 图片 API 实际用法（2026-09-24）

本项目默认使用独立 `yiciyuang` 图片后端，请求模型固定 `gpt-image-2.5`。它是供应商别名，请求该名称不证明底层型号。已实现本地 all-ready 工作流；真实生成效果、账户权限、余额、并发/RPM、连接时限和 URL 有效期以实际账户和验收记录为准。

接口依据是公开[专属文档](https://newapi.yiciyuang.com/docs/exclusive-gpt-image-2)：无参考图 POST `https://api.yiciyuang.com/v1/images/generations` JSON；有参考图 POST `/v1/images/edits` multipart，单文件 `image`、多文件按依赖顺序重复 `images`。每资产一个完整 prompt、n=1。多文件编码仍待真实验收；没有批量/轮询/task_id 协议，没有自动 POST 重试。

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

同一个 `quotaGroup` 同时只有一个运行进程。不要更换组名或 `--runtime-dir` 绕开未决记录。已知 `providerLimits.concurrent/rpm/batch` 小于待提交范围则任何 POST 前报错；还须提供 source/checkedAt。未知额度明确为待验证，不会默认声称供应商能受理200项。

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

## 离线验证

在项目目录并将 TMP/TEMP 设为 `.work/image-api-20260924/tmp` 后：`npm run build`、`npm test`、`npm run test:image-skill`、`npm run test:process`、`npm run test:image-api`、`npm run test:image-api:process`。最后一项启动并强制终止自己的假客户端子进程；不需要真实 Key。结果和环境限制见 [实施报告](IMAGE_API_INTEGRATION_IMPLEMENTATION_REPORT.md)。
