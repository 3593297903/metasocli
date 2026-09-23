# metasocli

独立的 Node.js / TypeScript CLI，将完整剧本或成品视频提示词整理为 Metaso `MiniMax-H3` 请求计划，并管理提交、查询、恢复及视频下载。当前版本 **0.1.0**。2026-09-21 起默认视频请求明确启用 `context_ir_enabled:true`；本次切换只做离线验证，没有发起付费生成。

当前源码包含视频四并发持续补位、独立下载，以及 Windows 路径大小写和已完成项目归档的恢复修复。详见 [批次实施报告](docs/VIDEO_BATCH_CONCURRENCY_IMPLEMENTATION_REPORT.md) 与 [独立复核](docs/VIDEO_BATCH_CONCURRENCY_RECHECK.md)。

2026-09-23 已重新构建并通过完整离线检查，见 [上传前核验](docs/UPLOAD_VERIFICATION_20260923.md)。

## 构建与本地运行

需要 Node.js 24+。在本项目执行：

```powershell
npm ci --ignore-scripts
npm run check
node .\dist\cli\main.js --help
```

依赖固定版本，缓存留在本项目 `.npm-cache`。程序不依赖 LibTV CLI、旧源码、旧 Skill 或旧登录状态，不创建全局 CLI 安装或 MCP 注册。视频提交/恢复使用独立 `%USERPROFILE%\.metasocli-runtime` 保存共享并发记录；开发测试注入临时运行目录。四份原 Skill 与新增旁白变体的正文位于 `skills/`，Codex 项目入口位于 `.agents/skills/`。本机另经用户授权添加了普通成品提示词与旁白的两个用户级入口；本版没有通用用户级 Skill 安装器。npm 包的唯一 bin 为 `metasocli`。

## 在 Codex 中使用 Skill

选择工作目录为 `E:\metasocli` 的本地任务，在输入框输入 `$metasocli-video-prompts` 可选择成品提示词入口；完整剧本使用 `$metasocli`。分段和参考图片技能也会随项目加载。技能入口会读取 `skills/` 下对应的完整说明。

例如，附上成品提示词文件后发送：

```text
$metasocli-video-prompts
读取附件中的全部成品提示词，故事项目使用 E:\metasocli\projects\我的视频。
按提示词准备参考图，保持每段原文、顺序和素材对应关系。
完成计划后先停下，展示生成参数和待提交的段落。
```

三个入口现在默认采用视频请求内启用 Context IR 的流程：准备素材和离线计划后停在视频提交前。后续可授权“按此计划生成这些段落，启用 Context IR，使用 MiniMax-H3、768P 并下载到故事项目”。授权当前范围及此模式后直接生成，不逐段再问。每段的视频请求明确发送 `context_ir_enabled:true`，不先创建独立 IR 任务；准备与计划不会联网生成。见 [当前流程说明](docs/INLINE_CONTEXT_IR_WORKFLOW.md)。

仓库内的五份入口随本仓库工作目录加载。为在 `mttest1` 等其他项目使用，2026-09-18 经用户明确授权，在 `C:\Users\Administrator\.codex\skills` 下另新增了 `metasocli-video-prompts`、`metasocli-video-prompts-旁白` 两份用户级入口。它们读取本项目的完整 Skill 正文，使用本机程序及已有旁白配置，不复制音频或凭据；其他三份仍是项目级技能，按正文相对路径读取即可。

用户级入口可在后续消息或新建任务中使用。若当前输入框列表未刷新，清空旧的技能名后重新输入；仍未出现时重启 Codex。新建视频故事既可使用 `E:\metasocli\projects/<故事名>`，也可由用户指定其他独立故事目录。入口依赖本机 `E:\metasocli` 安装，移动或重新安装后需同步更新。发现规则见 [Codex 官方技能文档](https://learn.chatgpt.com/docs/build-skills)。

需要统一旁白声线时使用独立变体，原入口保持原样：

```text
$metasocli-video-prompts-旁白
这里直接粘贴完整的视频提示词
```

该入口逐段、逐镜头检查声音归属，仅在明确需要叙述性画外旁白的段绑定指定音频；纯对白、环境声及静默段不绑定。混合段的角色对白保留各自声线与口型，原参考图及顺序不变。默认使用此安装 `.local/narration/default.mp3` 中用户选定的音频副本，按固定哈希校验；不需要每次重新附录音。文件缺失会明确报错。个人音频不进入 Git/npm，复制或重新安装项目后需要配置该音频。

音频只参考音色、语气、咬字、节奏与情绪，不复述示例台词、不把整条 MP3 铺到视频中。未授权包含 IR 的视频生成时，完成音频登记、参考图与本地计划后暂停。完整提示词、技术旁白说明、图片和音频一并进入启用 IR 的视频请求，不改原旁白 cues。详见 [旁白 Skill](skills/metasocli-video-prompts-旁白/SKILL.md) 与 [音频草稿契约](docs/INPUT_FORMAT.md#可选的统一旁白参考)。

两个成品提示词入口及剧本入口共同调用 [metasocli-reference-images](skills/metasocli-reference-images/SKILL.md)，不必另发一次生图指令。该图片 Skill 已独立带入完整的人物多视图板、场景空间结构板、道具结构材质板和单幅首帧模板：先保存完整配方，再原样交给宿主原生生图，保存展示首次图片并登记。人物按一人一套造型建立身份，图片仅分配给需要它的段；已登记且哈希一致的素材直接复用。用户明确提供的已有图片不因模板升级而自动重画。

在本仓库也可单独调用 `$metasocli-reference-images`，指定已有故事目录和需要准备的素材；它会先核对上游图片请求和状态，不生成视频。跨项目使用上述两个用户级视频入口时，会按链接读取同一套图片技能和模板，无需再安装旧图片 Skill。模板与校验器均在本项目内，运行不依赖 LibTV。

图片交接校验器使用 Python 3.10+ 标准库，检查素材/段落分配、完整配方传递、文件哈希和暂存路径；它不做视觉评分或保证出图外观。先 `npm run build`，再 `npm run test:image-skill` 可运行离线交接及 CLI 登记/计划检查；Node CLI 本身不依赖 Python。没有生成新图片或提交视频的测试，不等于真实图片/视频效果验收。

外部 `gpt-image-2.5` 生图 API 目前仅完成 [接入分析](docs/IMAGE_API_INTEGRATION_ANALYSIS.md)，尚未实现请求客户端、图片并发队列或付费验收；当前图片执行方式仍为宿主原生生图或已有图片导入。

## 两个离线入口

下面的演示只写本项目 `.work`；真实故事应使用独立目录。每条命令显式指定 `--root`，不会自动寻找附近项目。

```powershell
$cli = 'E:\metasocli\dist\cli\main.js'
$story = 'E:\metasocli\.work\demo-finished'
node $cli init --root $story --name '成品提示词演示'
node $cli import --root $story --file E:\metasocli\examples\finished.txt --kind video-prompts --episode ep-1 --duration 12.378
$plan = node $cli plan --root $story --episode ep-1 --workflow h3-inline-ir | ConvertFrom-Json
$plan
node $cli status --root $story
node $cli doctor --root $story
```

剧本草稿入口支持分段、保留原文的摄影说明和图片配方：

```powershell
$story = 'E:\metasocli\.work\demo-script'
node $cli init --root $story --name '剧本演示'
node $cli import --root $story --draft E:\metasocli\examples\script.draft.json
node $cli plan --root $story --episode ep-script --workflow h3-inline-ir
```

[草稿契约与多图示例](docs/INPUT_FORMAT.md)说明来源范围、完整台词校验、图片配方及引用。CLI 直接读取 UTF-8 TXT/Markdown；不自动创作分镜或解析 DOCX/PDF。Skill 负责宿主中的内容编排与原生图片准备。

省略 `--workflow` 也默认使用 `h3-inline-ir`，计划记录 `workflow.stage: inline-video` 和每段 `contextIr:true`。历史清单、计划和任务不自动修改；即使旧清单写 false，重新 plan 得到的实际请求也明确为 true。不要手改旧计划的开关或哈希；已有任务用 resume，新的生成对原始集重新 plan。

## 素材与 H3 计划

先在草稿中声明配方。`assets register --root <story> --id <asset-id> --file <image>` 将图片独立复制并登记哈希。原生生图文件加 `--provenance imagegen`；已有文件默认 user。`--url <https-url>` 会下载并核验图片，保存本地副本，提交前再次核对远端字节；不会自动上传到任何云存储。

支持 PNG/JPEG/WebP。`assets list --root <story>` 显示 missing/ready/changed。缺图或哈希变化必须登记恢复后重新计划；程序不静默降级为文字生成。

第一版请求支持文字、单首帧、多参考图。固定 MiniMax-H3，实际请求时长为 4–15 秒整数，768P/2K，最多 9 张参考图；首帧不能与参考图混合，实际比例为 adaptive。导入草稿和 `--duration` 可填写原始小数目标：`12.378` 自动请求 13 秒、`6.666`/`6.963` 自动请求 7 秒，计划保留 `targetDurationSeconds` 供核对。整数输入不新增字段。正常向上取整不需要逐段确认，不改原文、图片、旁白范围或音频，也不在出片后自动裁剪；H3 请求只收到整数 `duration`。新视频计划的 Context IR 明确为 true；水印仍默认 false。计划同时记录请求字节数、原文和渲染哈希、配方与图片哈希、引用顺序。7000 字符或 64 MiB 请求上限超出时拒绝，不截断。[契约依据与真实验收范围](docs/METASO_CONTRACT.md)

旁白扩展支持每段一份 MP3/PCM 或浮点 WAV 参考音频，2–15 秒、最多 15 MiB。与普通参考图一同提交原生 `reference_audio`，保留原图片顺序；不能与首帧混用。音频登记沿用 `assets register`，`kind: narration` 须先在草稿中声明。文件变化、缺失或不满足格式时阻止计划，不静默退回只有文字的旁白描述。请求音频传输及真实声线效果尚未进行付费验收。

## 授权后的生成与恢复

本次开发未执行下面的付费命令。只有用户明确授权当前范围及包含 IR 的视频模式后才运行；`METASO_API_KEY` 必须是 Metaso 的 Key，不与 MiniMax 官方 Key 混用。客户端只创建视频任务，其真实 POST 请求体明确包含 `context_ir_enabled:true`，不预先调用独立 IR。

Windows 本地开发也支持将现有 Key 用当前 Windows 用户的 DPAPI 加密，保存在此安装的 `.local/metaso-credentials.json`。该目录被 Git 忽略，npm 包不包含它；不写用户环境变量、全局配置或旧项目。CLI 自动读取这份凭据，显式设置的 `METASO_API_KEY` 优先。复制安装目录到其他机器或 Windows 用户后须重新连接。

```powershell
node .\scripts\connect-local.mjs
# 在浏览器打开命令输出的本机 URL，粘贴现有 Metaso Key 并保存。
# 页面仅监听 127.0.0.1，保存后自动退出；10 分钟未完成则超时。
node .\dist\cli\main.js auth status
```

`auth status` 只报告是否配置及来源，不输出密钥，不代表远端认证或生成已经验证。连接页只保存已有凭据，不新建供应商密钥，也不生成视频。远端凭据解密需要启动 Windows 自带 PowerShell；受限沙箱若禁止子进程，应使用进程环境变量或在普通本机终端运行。

```powershell
# 用户授权后，使用上文生成的 true 计划直接提交。
node $cli generate --root $story --plan $plan.planId --confirm
```

段 ID 从计划读取，示例单段导入为 `s1`。CLI 在联网前检查所选段全部为 `contextIr:true`，false 计划返回 `INLINE_IR_REQUIRED`，需重新 plan；已经提交的旧任务使用 resume。当前内联模式没有单独的增强文本审阅步骤，不能声称生成前已经核对服务端内部改写。接口不要求回传这个开关，程序不会伪造响应里的 true，也不会因缺少字段重新生成。

单段/旧兼容 `generate` 仍顺序处理计划各段，提交后有界查询并下载；`--segment <id>` 限定单段，`--submit-only` 只提交。这些入口与批次共用最多4个生成占位；需要持续补位时使用下文批次命令。`--max-polls` 默认 60（上限 720），`--poll-ms` 默认 5000。达到轮询限额保留原任务，不判定远端失败。CLI 退出后远端任务可能继续；本地没有常驻服务。

## 四并发持续补位

三个项目内入口 Skill 均使用批次流程。素材准备完成后，离线冻结选定范围；未授权生成时在此暂停。下列 plan/status 命令不付费、不读取 Key。选择参数三选一，`--episodes` 的集顺序和每集原段序决定派发顺序，数量不限于8段：

```powershell
$cli = 'E:\metasocli\dist\cli\main.js'
$story = 'E:\metasocli\projects\我的视频'
$batch = node $cli batch plan --root $story --episodes ep-1,ep-2,ep-3 --concurrency 4 | ConvertFrom-Json
$batch.summary
$batchId = $batch.plan.batchId
node $cli batch status --root $story --batch $batchId
# 只有用户已明确授权以上范围及包含 IR 的视频模式后执行：
node $cli batch run --root $story --batch $batchId --confirm
# 中断、轮询预算用完或下载失败后，恢复同一批次：
node $cli batch resume --root $story --batch $batchId
```

`batch plan --selection <selection.json>` 用于部分段，也适用于一个技术 episodeId 内含多个剧情集的故事，数组决定顺序，集/段不能重复：

```json
{"schemaVersion":1,"episodes":[{"episodeId":"ep-1","segmentIds":["s3","s4"]},{"episodeId":"ep-2","segmentIds":["s1"]}]}
```

`batch plan --all-episodes` 按故事清单顺序选原始集。若存在独立 IR 操作历史或可识别的派生来源，返回 `BATCH_ORIGINALS_AMBIGUOUS`，要求改用显式范围；不按 `-ir` 文件名猜测、拆写故事或自动叠加增强。

每个批次保存不可变计划哈希、请求及素材指纹、范围和运行授权。默认最多4个生成名额，可设置1—4。4个创建请求可同时在途；task_id 仅代表已受理，queued/running/受控 submitting/未知都继续占位。服务端终态验证并持久化后补下一个待提交段。下载另有最多2个并发，慢下载和下载失败不堵塞生成补位；输出仍为 `outputs/<episodeId>/<segmentId>-<operationId>.mp4`。

`batch run --confirm` 将授权绑定该批次哈希；`batch resume` 只能使用已保存授权，**允许继续范围内尚未提交的段**。旧 `resume --operation`、status、download 始终不创建任务。批次会接回已有 task_id，重建缺失的批次任务链接，复用通过文件/回执检查的成片。创建未知停止新增并保留占位，已知任务继续查询和下载；失败段不自动重做。只有明确未受理且无任何任务 ID 的429可自动重试，每段最多2次、批次累计等待最多60000ms，预算/每次尝试在新 POST 前保存；遵守更长 Retry-After 时超出预算则暂停。超时、5xx、矛盾回包绝不自动重发，401/402/403停止新增。POST 响应上限120秒、GET30秒，延长超时不代表幂等保证。

`batch run/resume` 支持 `--max-polls 60 --poll-ms 5000`（每个任务、本次运行的轮询预算）及 `--scheduler-wait-ms 30000`（0—300000）。同一运行目录只有一个活跃批次调度器，竞争批次等待，超时返回 `LOCK_BUSY`；普通新建入口在活跃批次期间返回 `SCHEDULER_BUSY`。占满时单段提交返回 `CAPACITY_FULL`，先查询/恢复既有任务；不能换目录绕开名额。

共享目录默认 `%USERPROFILE%\.metasocli-runtime`，可用 `METASO_RUNTIME_DIR` 或 `--runtime-dir <path>` 注入**同一个**安装运行目录；测试用临时目录。历史已知项目可先 `batch register --root <story>`，只将已有任务登记到共享名额，不联网创建。首次登记会扫描该项目原任务，此后会核对已登记项目。Windows 同一目录的不同大小写统一为一个身份，兼容旧 ledger 的写法；不同目录不能共用项目或操作身份。它不能发现未登记的其他项目，也不能控制网页、旧程序或其他电脑的调用；4是本地上限，真实账户额度和并发仍待授权验收。

已完成项目归档：先让查询/恢复确认所有生成终态，并运行 `batch register --root <story>` 同步共享记录，再移动完整项目目录。下一次共享核验发现旧目录不存在时，只有 hash 校验通过、有任务历史且全部为 generated/downloaded/failed/cancelled 的项目才自动标记 `retiredAt`、退出活动扫描；保留项目身份、全部原任务 ID、请求哈希和终态记录，不需要清理 ledger。旧版无 `retiredAt` 的 ledger 同样适用。仍有预留、提交中、排队、运行、未知状态，或只有空登记而无终态证据的缺失目录，返回 `COORDINATOR_PROJECT_MISSING`，保留名额并阻止新提交；须恢复原目录后沿用原任务处理。原路径恢复后重新核验身份；本机制不自动迁移活动项目，也不接受另一实际目录冒用原身份。不要删除 ledger/锁/任务来释放名额。

批次位于 `.metasocli/batches/<batchId>/{plan,run}.json`；共享 `video-ledger.json` 只做预留与索引，单段 Job/receipt 是恢复依据。提交和查询不持有长项目锁，下载仅持本任务锁；固定共享锁→短项目写锁顺序，网络、轮询等待和下载流在状态锁外执行。异常退出不清空未知名额。记录与轨迹见 [实施报告](docs/VIDEO_BATCH_CONCURRENCY_IMPLEMENTATION_REPORT.md)。

```text
status      --root <story>                           本地只读，不需要 Key
status      --root <story> --operation <id> --remote  只查询选定任务；IR 可保存文本，不下载视频、不创建任务
resume      --root <story> --operation <id>          按 ID 恢复 IR 或视频，不创建下一阶段
download    --root <story> --operation <id>          仅查询并恢复原视频任务下载，拒绝 IR
download    --root <story> --operation <id> --redownload-missing
```

提交前先落盘 prepared/submitting 请求记录及共享预留，取得 taskId 后先保存独立回执。同一请求重复执行复用已有操作；单段命令不自动重试创建，批次只有上述明确拒绝的429例外。本地哈希不代表服务端幂等。

新流程的任务与回执继续位于 `.metasocli/jobs/` 和 `.metasocli/receipts/`。历史独立 IR 数据位于 `.metasocli/context-ir/`，本地 status 仍列 `contextIrOperations`，可以按原 ID 恢复。任一阶段未知提交会在项目锁内阻止新的收费创建。

旧独立 IR 文本命令和底层兼容模块仍保留，历史结构见 [原独立流程记录](docs/CONTEXT_IR_WORKFLOW.md)。当前 Skill 不走该链，CLI 也不接受 false 的派生计划新建视频；不要绕过 CLI 或把旧增强文本自动叠加一次 IR。

- `submit_unknown`：可能已被接受，禁止重发。通过供应商核实原 taskId 与操作的关系后，执行 `attach-task --root <story> --operation <id> --task <task-id> --confirm-task-link`，再 resume。CLI 无法替供应商证明任务归属。
- `query_unknown`：保留已脱敏响应证据和原 taskId，随后再查。未知状态、缺失结果地址或错误响应不会当作 queued/success。
- `generated` 加下载错误：只恢复下载。MP4 经流式大小限制、容器/时长/尺寸及 SHA-256 检查后原子保存；落盘回执允许恢复“已重命名但最终状态未写入”。校验不等于完整解码或视觉质量保证。
- `failed/cancelled`：默认不再次提交。主动重生成必须指定单段和 `--retry-of <latest-operation-id>`，形成独立尝试；当前 true 请求继续使用同一 true 计划。旧 false 请求切换模式要创建新计划，并明确这是新请求。未知任务不允许重试。
- 进程锁只在同一主机、原 PID 已不存在且记录完整时恢复。活进程或不明锁不按等待时长强删。损坏锁/中断的 recovery.lock 保留供人工检查。

JSON 是默认输出，`--json` 可选。退出码：0 已完成本次动作；1 参数、契约或本地错误；2 任务失败、未知、轮询限额或下载未完成。日志不输出密钥、认证头或完整签名链接。故事清单中的输入 URL 是本地私有数据，勿提交真实故事目录。

## 验证及边界

`npm run check` 执行构建和假客户端/临时文件测试，测试默认封锁真实 fetch。详见 [交付验证记录](docs/VERIFICATION.md)。真实文字、首帧、多图生成与 URL/Data URL 接受情况仍需凭据、明确授权和预算另行验收。

进程中断验证：先构建，再执行 `npm run test:process`。Windows 临时安装隔离验证：`./scripts/package-smoke.ps1`，需要已填充的本项目 npm 缓存。两项均使用假客户端或本地包，不调用视频生成。

尾帧、参考视频、多音频或角色对白声线配置、完整旧项目转换、DOCX/PDF 解析、用户级 Skill 安装器、MCP 和常驻后台服务未开放。新项目只单向复制明确提供的原文、图片或旁白录音；不接管旧目录、旧命令或账户。

设计与来源：[AGENTS.md](AGENTS.md)、[ARCHITECTURE.md](docs/ARCHITECTURE.md)、[源码复制记录](docs/SOURCE_MANIFEST.json)、[移植说明](docs/MIGRATION_NOTES.md)。
