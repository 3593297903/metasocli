# 0.1.0 交付验证记录

## 2026-09-21 单次真实请求：余额不足，尚未生成

用户明确授权一次付费测试后，在独立目录 `.work/inline-ir-live-20260921/story` 通过当前构建的 CLI 和真实 MetasoClient 执行了一次视频创建。测试使用 `mttest3` 中已经提交过的两张生成参考板和同一条旁白 MP3 的独立副本，按 SHA-256 核对；原业务目录未写入。参数为 MiniMax-H3、4 秒、768P、9:16，实际传给原生 fetch 的序列化请求明确包含布尔值 `context_ir_enabled:true`，其请求哈希与不可变计划一致。

- 唯一 POST：`https://metaso.cn/api/minimax/v2/video_generation`，2026-09-21 13:15:08（北京时间）。没有独立 IR 请求、第二次创建、查询或下载。
- 真实服务响应：HTTP 402，`error.type: insufficient_balance_error`，`message: H3 积分余额不足 (1008)`，`request_id: 1eb83b71-40d5-4270-a7fe-d20ef1d3ae95`。
- 没有返回 task_id，也没有回传 `context_ir_enabled`。本地任务记为 `failed / CREATE_REJECTED`，未重试。此次仅证实发送 true 并收到服务端余额拒绝，不能据此认定 IR 已执行或视频生成已验收成功；实际扣费未查询账单。
- 出站请求脱敏副本、请求字节哈希、HTTP 事件、供应商响应和本地任务保存在 `.work/inline-ir-live-20260921/`。该测试脚本以独占提交标记限制最多一次创建，不得删除标记后重发。
- 结束时，53 个旧文件哈希、旧 Git 状态和旧全局命令路径未变；本次没有修改产品源码、安装或 GitHub。

最初自动审批因素材外发授权不清拦截执行，进程未启动且零请求；核对三项素材均为用户此前已要求发往同一 Metaso 服务的相同字节后复核获准。该审批拦截不计入 API 次数。继续真实成片验收需先解决本次 API Key 对应的 H3 积分余额，再取得下一次生成授权。

## 2026-09-21 默认视频请求显式启用 Context IR

按用户要求，新增不可变计划模式 `h3-inline-ir / inline-video`，默认 `plan --episode` 和三个业务 Skill 均使用此模式。新计划实际构造的视频 JSON 布尔值为 `context_ir_enabled:true`，请求哈希也基于 true 计算；校验时按已保存的模式重建相同请求，不修改历史 manifest、计划或任务。

CLI generate 在加载凭据或提交任何任务前检查所选全部段，发现 false 时返回 `INLINE_IR_REQUIRED`，要求对原始集重新 plan。旧独立 IR 文本接口及底层兼容模块保留，旧 false 派生计划不用于当前 CLI 新建视频。Skill 不再预先调用独立 IR 或将增强文本自动再次增强；内联模式没有独立的生成前增强文本审阅阶段。供应商响应无需回传此开关，程序不伪造返回值。

实际验证：

- `npm run build` 成功；构建后的 CLI help 和离线 init/import/plan 均成功，演示计划保存于 `.work/inline-ir-20260921/compiled-cli-plan.json`。
- 全套 142 个用例已验证：沙箱中 141 项通过，Windows DPAPI 用例因子进程受限失败；随后在本机单独运行 credentials.test.ts，3 项全部通过，包含该失败用例。
- 新增 5 项用例覆盖：剧本/成品提示词多段实际 HTTP 序列化均为 true、请求哈希一致、缺授权零请求、重复命令不重建、图片音频字节与旁白范围不变、原 ID 下载恢复、旧 false 计划联网前拒绝、旧独立 IR 派生结果不被自动叠加。
- `npm run test:image-skill` 11 项通过。
- `npm run test:process` 最初因沙箱 spawn EPERM 受限；本机重跑后 8 个进程中断恢复场景全部通过，测试客户端不会联网，PATH 排除旧 CLI，子进程权限禁止读取旧源码。
- 本轮隔离快照比较：53 个旧文件哈希、旧 Git 状态、旧全局命令路径全部未变。原初始化基线没有被覆盖。本机两个跨项目 Skill 包装入口仍引用本项目正文，无需改写用户级 Skill 或全局配置。
- 没有发起真实 Metaso 请求、付费 IR/视频、上传、Git 推送或安装覆盖。真实供应商接收 true 及内联 IR 成片效果仍待授权验收。

日期：2026-09-17；平台：Windows，Node.js 24.15.0，npm 11.12.1。此记录区分本地实现、离线验证和真实服务验证。

## 已实现并离线验证

| 验证 | 实际结果 |
| --- | --- |
| `npm run check` | TypeScript 构建成功；8 个测试文件、43 项测试通过 |
| `npm run test:process` | 2 处真实子进程强制中断恢复通过；未知创建不重发、已保存回执恢复原 taskId |
| `scripts/package-smoke.ps1` | 全新临时源码目录 `npm ci --offline --ignore-scripts`、独立构建及全部 43 项测试通过 |
| 临时 npm prefix 生命周期 | tarball 安装、同版本重复安装、CLI 启动、卸载通过；8 个旧命名空间哨兵文件未变 |
| 实际本地 CLI 示例 | `examples/finished.txt` 与 `examples/script.draft.json` 分别完成 init/import/plan，原始台词保留 |

离线测试的全局 fetch 被封锁，HTTP 只能通过显式假客户端注入。上述首次离线交付没有真实付费生成或真实任务查询。后续账号连接仅做下文记录的只读认证探测；公开文档读取及 npm 依赖下载不属于视频生成验证。

覆盖的关键行为：

- 原始文件字节、规范换行、完整说话人/台词、来源区间和段落顺序；重复导入、缺损副本恢复及配方循环拒绝。
- 文字、首帧、多参考图计划；有序引用、H3 参数、提示词超限拒绝、计划哈希篡改检查。
- 图片独立复制、哈希/尺寸校验、缺图与变化；公网 URL 在提交前重新核验；同一 URL 的不同素材字节不会被误当作同一个输入。
- 请求意图先落盘；创建只发送一次；创建结果未知、全部回执丢失、已保存回执但状态写入失败；重复执行与并发提交许可；明确失败后的独立重试尝试。
- 查询身份、未知状态、响应契约、限流 Retry-After、有界退避和轮询限额；超时保留原任务。
- 下载中断、错误内容类型、长度不符、时长不符、缺失文件；完整 MP4 结构与轨元数据检查；原子重命名后状态写入失败的恢复；恢复下载不再次创建。
- 旧源码/旧故事/旧 Skill 路径拒绝，Windows 目录联接、硬链接和越界路径；日志与证据的密钥/链接脱敏。

进程测试在 PATH 中隐藏旧 CLI，并使用独立用户目录。在本机跨盘布局下还启用 Node 权限，实际验证 `E:\libcli\package.json` 读取被拒绝；新任务提交记录及恢复流程仍运行成功。该测试不重命名、移动或改权限于旧目录。

完整构建测试最初受宿主沙箱的子进程限制影响，测试池改用 threads；Vite 配置使用无额外 import 的 MJS。临时包安装第一次因隔离用户目录后 registry 名称变化而缺少离线缓存，脚本显式沿用原缓存 registry 后全程离线通过。失败尝试没有修改真实全局安装。

## 旧项目隔离检查

开工时记录了旧 Git 状态、全局 `story2libtv` 三个命令路径、实际安装包/指定快照版本、四份旧 Skill 及相关文件的 53 个 SHA-256。敏感文件只保存哈希，没有复制凭据内容。

- 旧 Git 保持原来的六份修改和 `outputs/` 未跟踪目录；这六份已修改文件的内容哈希未变。
- 命令路径、安装版本 0.2.22、旧 Skill 与其余受检文件一致；53 项中 **52 项哈希一致**。
- **共享配置例外：** `C:\Users\Administrator\.codex\config.toml` 整体哈希发生变化。初始指纹记录于本地 16:30，文件修改时间为 16:45:10。本次源码与工具命令没有对该文件执行写入；变化来源未确认。未覆盖、恢复或重新采集基线来抹掉差异，因此不能断言共享配置或其中的 MCP 配置全量未变。

原始基线保留在 `.work/isolation-baseline.json`，复核结果在 `.work/isolation-check.json`。`scripts/isolation-baseline.ps1 verify` 对这处真实差异返回非零；这是隔离核对异常，不是 43 项代码测试失败。配置保持用户当前状态，需独立核对来源。

## 真实验证与未开放范围

尚未进行真实文字、首帧、多图生成；Metaso 对 Data URL/URL、Context IR、错误包络、输出时长和文件格式的实际兼容性仍待授权验收。已有离线结果不能证明第三方零故障或服务端恰好执行一次。

### Codex 项目技能发现修复（2026-09-18）

此前四份说明仅放在 `skills/`，没有 Codex 自动发现入口，导致输入 `$metasocli-video-prompts` 时无法选择。现已在本仓库 `.agents/skills/` 新增四份入口，分别引用 `skills/` 下的完整说明；没有新增用户级安装。README 和 START_HERE 已补充项目选择、使用示例及发现范围。

- 校验四份 YAML 名称与描述、指向技能正文的真实路径，均通过。
- 使用本机 Codex `0.154.0-alpha.6.2`，将验证进程的 `CODEX_HOME` 隔离到本项目 `.work`，仅调用 `initialize` 与 `skills/list`（`cwds: [E:\\metasocli]`、`forceReload: true`）。四个名称均返回 `enabled: true`、`scope: repo`，没有本项目技能解析错误。脱敏结果位于 `.work/skill-discovery-check.json`。
- 未创建 Codex 任务或调用视频生成；此检查验证技能发现，不等于对当前桌面输入框进行视觉验收。项目级技能只随本仓库工作目录加载，其他目录可显式读取技能完整路径。
- 旧 Git 状态、全局命令路径及旧 Skill 等 52 项受检文件与初始基线一致。共享 `C:\Users\Administrator\.codex\config.toml` 仍是唯一差异路径，当前哈希与此前记录也不同；本次没有写该共享配置或重置基线，核对脚本仍按差异返回非零。

### 本机账号连接（2026-09-17）

用户授权连接账号后，使用已登录 Metaso 控制台中现有、正常的 Default Key 完成本机配置，没有创建或撤销供应商密钥。凭据通过私有管道送入 Windows 当前用户的 DPAPI 加密，保存于本安装的 `.local/metaso-credentials.json`；未把明文写入文件、命令参数或日志。CLI 远端操作自动读取，`METASO_API_KEY` 仍优先。没有修改用户/系统环境变量或旧项目配置。

- 本地 `auth status` 和示例故事 `doctor` 均报告 `configured: true`、`source: local-encrypted`。这两个命令本身不访问远端。
- 本地时间 18:54 的真实只读探测仅执行 `GET /api/minimax/v2/query/video_generation/0`。不带 Key 返回 HTTP 401、认证错误 1004；带已保存 Key 返回 HTTP 400、视频任务不存在 2013。该对照验证密钥被接受，未提交视频生成；不能据此宣称真实出片已验证。脱敏原始结果保存在被 Git 忽略的 `.work/metaso-auth-check.json`。
- 新增凭据覆盖环境变量优先、旧路径拒绝、无效凭据、Windows 加密往返、已存凭据保护和密文损坏。最新构建及 9 个文件中的 46 项离线测试通过；2 项进程中断恢复测试再次通过。加密测试需允许 Windows PowerShell 子进程；在禁止子进程的沙箱中会明确失败。
- npm 打包预览共 90 个文件，不含 `.local`、`.work` 或凭据文件；Git 确认凭据目录被忽略。
- 隔离复核仍只报告此前记录的共享 Codex 配置差异，本次没有新增差异。临时本机连接页及服务已关闭。

本次没有发布、推送 GitHub、覆盖全局命令、安装用户级 Skill、注册 MCP 或写入旧运行目录。测试安装仅发生在自建临时 prefix 并已清理。

### 独立旁白 Skill 与音频契约（2026-09-18）

按用户要求新增 `metasocli-video-prompts-旁白`，原四份 Skill 正文哈希均保持本轮开始时的值。新入口逐段、逐镜头区分叙述性画外旁白、人物对白与无声部分；只为确有旁白的段绑定音频，混合段保留人物对白的声线与口型。原文与图片顺序保留，最终请求另附声线归属说明。

只读检查了 `C:\Users\Administrator\Desktop\test34` 的项目资料，以及任务「优化金龟祥瑞形象」中实际添加音频和后续纠正的记录。其最终做法是将同一 MP3 当作通用旁白声线参考，不按录音台词匹配单一镜头；每集建立音频引用，给含旁白的段保留参考图并连接音频。历史检查记录中六集共 31 段均含旁白，31/31 具有音频、说明与原图片，且当时未提交生成。新入口复用该判断原则，不假定其他项目的所有段都需要旁白，也不使用 LibTV 节点或旧 CLI。

用户指定的桌面 `旁白.mp3` 以独立副本保存在本安装 `.local/narration/default.mp3`，SHA-256 为 `d58249d4f000181f30e33e1b821fca408329b4a58b6ed9b39c672eba5b7da947`，235779 字节、44100 Hz、双声道、约 9.822 秒。本地解析与只读 ffprobe 的时长一致。登记时校验固定哈希，不裁剪或重编码；桌面原文件哈希未变。个人音频不加入 Git/npm，新机器需要单独配置。

| 验证 | 本轮结果 |
| --- | --- |
| `npm run check` | TypeScript 构建成功；11 个文件、61 项测试通过 |
| `npm run test:process` | 2 项进程中断恢复再次通过，旧 CLI 在测试 PATH 中隐藏 |
| 真实 MP3 的离线 CLI 流程 | init/import/register/plan/status 完成；三个样例段仅旁白段携带音频，原文逐字保留，任务数为 0；进程禁止网络 |
| Codex 实际技能发现 | 五份名称均 `enabled: true`、`scope: repo`，无解析错误；含用户要求的中文名称 |
| 元数据与路径 | YAML、名称/描述长度、正文链接、发现入口与正文对应关系通过 |
| npm 打包预览 | 97 个文件，包含新增 Skill 和音频模块，不包含 `.local`、`.work`、MP3/WAV 或凭据文件 |
| 原素材及原 Skill | 桌面音频与原四份 Skill 的五项输入哈希均未变；默认音频副本与原文件一致 |

新增测试覆盖音频结构/时长/大小、旁白范围与 Unicode 边界、首帧冲突、图片顺序、混合对白、缺失/变化恢复、指定哈希、提示词超限拒绝，以及实际 Metaso 客户端通过注入的假 HTTP 传输发送 `audio_url` / `reference_audio`。音频任务的回执写入中断、下载失败、未知创建不重发与 URL 内容变更检查均通过。请求的音频内容哈希与登记文件一致，计划不泄露 Data URL 或完整签名链接。

Skill 创建器附带的 Python 校验器因本机运行环境缺少 PyYAML 未能启动；改用已安装的 Node YAML 解析器检查元数据和链接，并使用实际 Codex `skills/list` 验证可加载。中文后缀是用户指定名称，保留该名称，不套用通用模板的 ASCII 命名限制。

本轮证据保存在忽略目录：`.work/narration-acceptance-check.json`、`.work/narration-final-check.json`、`.work/skill-discovery-check.json`。旧项目隔离核对仍是旧 Git 状态、全局命令路径与 52 项文件哈希一致，仅共享 `.codex/config.toml` 与初始基线不同；其当前整体哈希也再次变化，来源未确认。本轮没有写该文件或覆盖原始基线，隔离脚本仍如实返回非零，不能把它记成全部通过。

没有上传旁白或发起付费视频生成；音频请求的服务端接受情况、实际声线效果及对白保留效果尚未真实验收。

### 跨项目发现范围复核（2026-09-18）

用户在输入框仍无法找到普通成品提示词与旁白入口后，重新检查了实际安装位置：两份入口只存在于本项目 `.agents/skills/`，真实用户级目录没有 `metasocli-*` 入口。此前只验证本仓库可发现，不能推出其他项目也可发现。

将独立验证进程的 `CODEX_HOME` 设为本项目 `.work/cross-project-skill-check`，实际调用 `skills/list` 同时查询 `E:\metasocli` 与 `C:\Users\Administrator\Desktop\mttest1`：安装前前者有两个 repo 入口，后者没有。向隔离用户目录加入两份普通文件入口后，后者返回两个 `enabled: true`、`scope: user` 条目，无解析错误。名称 `metasocli-video-prompts-旁白` 可正常解析。没有运行视频业务或修改 mttest1。

临时用户入口以绝对路径读取本项目的原 Skill 正文，继续使用本机 metasocli 程序；不复制音频、凭据或旧项目资料，不依赖原有 LibTV Skill。两份入口均有 `owner: metasocli` 的安装回执。证据在 `.work/cross-project-skill-check.json`。本次临时验证本身没有安装到真实用户目录；实际跨项目安装需满足用户指定的写入范围。

用户随后明确回复“允许”。在确认两个目标目录不存在后，已于本机用户目录 `C:\Users\Administrator\.codex\skills` 下新增 `metasocli-video-prompts` 与 `metasocli-video-prompts-旁白`。每个目录仅有入口 `SKILL.md` 和 `.metasocli-install.json` 归属回执；以拒绝覆盖的方式创建，入口字节哈希与通过跨项目发现验证的临时版本一致。安装回执在 `.work/user-skill-install.json`。该授权仅用于新增这两个入口，没有修改共享 Codex 配置、原有 Skill、LibTV 安装或视频业务数据。

技能发现检查验证了 Codex 扫描器、中文名称、跨项目 user 范围和安装文件一致性，没有通过桌面 UI 自动化验证当前输入框的缓存刷新；用户可在下一条消息重输技能名，必要时重启 Codex。

未开放：尾帧、参考视频、多音频/角色对白声线配置、HEIC/HEIF、DOCX/PDF 直接解析、完整旧故事自动转换、用户级 Skill 安装器、MCP、常驻后台。提供已实现的 CLI、本地五份 Skill 与独立 npm 包边界；不把这些后续能力写成已完成。

### 完整参考图片 Skill 迁入（2026-09-18）

按用户要求补齐 `metasocli-reference-images`，同时衔接普通成品提示词、旁白和剧本入口。原安装与指定 0.2.22 快照的图片 Skill 八个来源文件哈希逐项一致。人物、场景、道具和共享视觉规则四份文件按原字节复制；首帧规则、交接契约、标准库校验器及主入口适配本项目，全部来源与新文件哈希已记录在 `SOURCE_MANIFEST.json`。未引入旧 CLI、LibTV 补图、画布、安装回执或业务状态。

图片流程现在先保存完整类型模板配方，再原样写入 CLI 草稿，导入后仅为缺失必需项调用宿主原生生图并登记。上游明确每个人物造型的独立身份及逐段分配；图片技能不擅自合并身份。新校验器核对实际段引用及传递依赖、必需/可选状态、完整提示词与依赖/精确文字的传递、复用文件身份、结果哈希和新项目暂存目录。旁白继续由旁白入口处理，不进入图片请求。

| 验证 | 本轮实际结果 |
| --- | --- |
| Skill Creator `quick_validate.py` | 使用 Python UTF-8 模式校验图片 Skill，通过 |
| 图片交接校验器 `--self-test` | 通过，校验器仅使用 Python 标准库 |
| `npm run test:image-skill` | 11 项通过；包括 request/recipe/result 实际命令参数和隔离故事的 CLI 导入、图片登记、重复导入复用、两段计划；任务目录为空 |
| `scripts/package-smoke.ps1` | 独立临时源码中离线安装、构建、11 个文件的全部 61 项原有测试通过；真实全局安装未变 |
| 新包资源及安装生命周期 | 五份 Skill、六份图片参考说明及校验器均入包；临时 prefix 安装、重复安装及卸载通过，8 份旧命名空间哨兵不变 |
| 独立资源和链接 | 8 份来源/目标记录、4 份未改模板的字节哈希、22 个本地 Skill 链接验证通过 |
| 本轮旧项目隔离 | 与本轮开始的独立记录相比，旧 Git 状态、旧全局命令路径及 53 项文件哈希全部未变 |

首次在受限沙箱执行原有测试时，60 项通过、Windows DPAPI 往返一项失败；随后在本机隔离临时环境中全部 61 项通过。新增 Python 测试首次受 Python 3.14 私有临时目录 ACL 影响，改为在工作区内创建并验证后清理唯一 UUID 测试目录，11 项通过。两个失败遗留的空临时目录已单独核实并清理。通用 Skill 校验器最初按 Windows GBK 读取中文失败，改用 `-X utf8` 后通过；未修改该系统 Skill。

本轮隔离证据位于 `.work/image-skill-isolation-before.json` 与 `.work/image-skill-isolation-after.json`。之前记录的共享 Codex 配置相对最初开发基线的差异仍保留，没有覆盖原始基线；“53 项未变”仅指本次图片 Skill 开发前后。没有改写旧项目、共享配置、用户级入口或 mttest1 业务素材，也没有发起图片生成、视频生成或 GitHub 推送。

离线检查使用合成 PNG 测试字节，不代表实际原生生图效果已验收。此次补齐图片模板与交接流程，不宣称两个平台的视频模型、所有提示词绑定行为或真实出片效果已经完全相同；既有故事素材需要按用户具体修订要求另行处理。

### 小数目标时长适配（2026-09-19）

`duration` 现在表示用户原始目标秒数；导入时只执行一次 `Math.ceil`，持久化段和计划保持 H3 的 4–15 秒整数，并只在小数目标时增加 `targetDurationSeconds`。请求体仍只包含整数 `duration`。正常小数适配不改原文、提示词哈希、图片顺序、旁白 cues 或音频媒体时长，也不会生成后裁剪视频。

| 离线 CLI 导入/计划目标 | 计划实际时长 | H3 请求时长 | 请求含目标元数据 |
| --- | ---: | ---: | --- |
| `12.378` | `13` | `13` | 否 |
| `6.666` | `7` | `7` | 否 |
| `6.963` | `7` | `7` | 否 |

- `npm run check`：构建通过；12 个测试文件、78 项通过。受限沙箱不能启动 Windows DPAPI 子进程，因此在同一台机器的隔离本机测试上下文重跑并通过。
- `npm run test:image-skill`：11 项通过。`npm run test:process`：两项中断恢复通过，PATH 中旧 CLI 被隐藏且 Node 权限拒绝读取旧源。
- `scripts/package-smoke.ps1`：隔离临时源码安装、构建、78 项测试，以及临时 npm prefix 的安装、重复安装、卸载全部通过；8 个旧安装哨兵未变。
- 修改前构建保存的普通整数计划 `6232e3c7821935871b7fde273889b368400fe9b1d46139c22d501298d9076c3a` 和旁白整数计划 `3832b49ce8ab670b2d105a96c73649c45c9e1b725be5fb53319d9dd3bcf2615b` 已由新构建完成 `loadPlan`、`validatePlan`。两份文件未补字段、哈希不变；普通段按原任务 ID 通过假客户端恢复，恢复时没有新建任务。
- 新增测试覆盖 script/成品提示词两个入口、CLI 小数与轮询参数的不同解析、非法目标定位、整数计划兼容、重复导入、显式替换后的旧计划失效、旁白源/哈希/cues/音频精度保持，以及小数任务的回执中断、未知创建和下载失败恢复。
- 本次开始时记录的 45 项旧项目/安装文件哈希、旧 Git 状态和三个 `story2libtv` 命令路径，结束后逐项一致；结果在 `.work/duration-adaptation-isolation-after.json`。既有历史基线和其共享 Codex 配置差异没有被重写。

这次仅运行本地计划和假客户端；没有实际生图、付费视频生成、mttest1/mttest2 业务数据修改、全局安装覆盖、提交或 GitHub 推送。真实 H3 小数时长、音频声线和生成服务仍未验收。

### 独立 Context IR 流程（2026-09-19）

在本轮开始时的未提交源码之上实施，没有 reset、分叉、转交任务或并行写代码代理。源码基线保存在 `.work/context-ir-source-before/`，初始 Git 状态在其中 `git-status.txt`。本轮没有改动 Story 契约、旧视频 Job 契约、时长模块、H3 基础构造器、图片 Skill/模板、旁白模块、凭据模块、package.json 或 package-lock.json；这些文件此前已有的修改保留。

实际增加独立 IR 契约、请求适配、任务存储/回执协调、提交/查询/挂接恢复及锁内跨阶段冲突检查；TaskId 移至契约叶模块并由原 client 导出兼容，避免计划/客户端循环初始化。Plan 只新增无默认值的可选 workflow；准备计划不能进入视频提交，派生计划按父计划、当前来源/素材、IR 原文及 review 哈希重建。原视频模块继续负责最终 H3 提交和下载，最终内联 `context_ir_enabled:false`。IR 意图、远端回执、结果回执与视频记录分别持久化；派生计划先落盘候选 planId/createdAt，中断后复用。

CLI 新增 `context-ir`、`plan --workflow h3-context-ir`、`plan --from-context-ir --review`，status/resume/attach-task 按 operationId 分派，download 拒绝 IR。三个原业务入口共用 [流程与核对契约](CONTEXT_IR_WORKFLOW.md)，默认暂停于收费 IR 前；同范围 IR+视频授权后，正常核对通过自动派生并继续，不增加逐段批准。普通成品入口不自动绑定旁白，旁白变体仍仅为有旁白的段带原音频。只更新仓库 skills 正文，已只读确认现有用户级包装入口读取这些正文；没有重装用户 Skill 或修改 `.agents` 入口。

| 实际执行 | 最终结果 |
| --- | --- |
| `npm run check` | 构建成功，正式 `tests` 目录 16 个文件、125 项全部通过（原 78 项 + 新 47 项） |
| `npm run test:image-skill` | 11 项通过，原图片交接及 CLI 导入/登记/复用/计划继续通过 |
| `npm run test:process` | 8 个真实进程中断检查点通过：原视频 2 个 + IR 6 个；另在 IR 提交和派生预留处验证第二进程收到 LOCK_BUSY |
| `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-smoke.ps1` | 临时源码离线 npm ci、构建、16 个文件 125 项测试通过；临时 prefix 安装/重复安装/卸载通过，8 个旧安装哨兵不变；新 IR 模块/共享流程文档入包 |
| `git -c safe.directory=E:/metasocli diff --check` | 通过，退出码 0；仅有 Git 对 package-smoke.ps1 未来 LF→CRLF 的提示 |
| Skill 本地链接检查 | 22 个文档链接的目标文件存在；没有更改全局包装入口 |
| 本轮旧环境比对 | 53 项受检文件 SHA-256、旧 Git 状态及全局命令路径全部与本轮开始时一致 |

check、进程及临时安装中的 Windows DPAPI/子进程操作在允许本机子进程的环境执行，使用临时测试文件和假客户端。第一次全量扫描还包含 `.work` 中捕获的升级前 78 项测试，因此曾显示 28 个文件/203 项；现将 Vitest 发现范围明确限定为 `tests/**/*.test.ts`，上述 16/125 为剔除重复后的最终统计。没有删减正式测试来制造通过。

新增 47 项覆盖：普通多图/旁白各 1 次假 IR + 1 次假视频、媒体内容和顺序相同、原清单字节及 cues 不变、最终内联 IR 关闭、IR 请求字段白名单、错误类型/模型/ID/空结果、超长/缺台词/缺旁白/非法引用、needs_review、来源/素材/远端 URL/IR/review 篡改阻断、已接受任务不受后来来源变化影响、创建结果未知不重发、回执写入失败、结果回执恢复、限流有界查询、显式失败重试、视频重试及下载复用 IR、跨阶段活跃/未知任务冲突和 taskId 重复绑定、派生身份三个持久化中断点及普通 CLI 恢复不创建下一阶段。增强文本的 UTF-8 BOM 也原样保留，结果哈希与最终文本一致。语义正确性仍需真实宿主核对，测试中的合成 approved 记录不是实际影片的核对结论。

进程测试在 PATH 中隐藏旧 CLI，Windows Node 权限明确拒绝读取 `E:\libcli\package.json`；强制终止后恢复同一任务/计划身份，假 IR 创建计数始终只有一次。未知回执状态保留为未知，不能借恢复创建另一个任务。

#### 小数时长在两个阶段的离线证据

使用全新 `.work/context-ir-evidence-*` 故事、合成 3.125 秒 WAV 和禁止真实 fetch 的假客户端生成证据，原提示词/哈希/cues 及清单字节保持，两阶段媒体 content 完全相同。每个样例假 IR、假视频各调用一次；没有真实服务请求。

| 原目标 | 准备计划执行时长 | IR 请求 duration | 视频请求 duration | 音频时长 | 视频内联 IR |
| ---: | ---: | ---: | ---: | ---: | --- |
| 12.378 | 13 | 13 | 13 | 3.125 | false |
| 6.666 | 7 | 7 | 7 | 3.125 | false |
| 6.963 | 7 | 7 | 7 | 3.125 | false |

汇总及具体准备/派生计划路径、requestHash、planHash 保存在 [.work/context-ir-offline-evidence.json](../.work/context-ir-offline-evidence.json)。目标元数据保留在本地计划，两个真实请求形状都只含整数 duration，不传 targetDurationSeconds。

#### 升级前计划与任务兼容

使用本轮修改前构建实际生成的普通/旁白整数计划；旧视频任务由捕获的升级前源码独立构建和假客户端生成，不用新代码伪造“旧格式”。固定样本在 [tests/fixtures/pre-context-ir](../tests/fixtures/pre-context-ir/capture.json)，测试复制到临时故事恢复，原计划/清单文件字节、planHash/inputHash/requestHash 均保持，旧 taskId 的新建次数为 0。

| 样本 | 保持不变的 planHash |
| --- | --- |
| 普通整数计划 | `e48bdff99dff04a6c31dadb18a10a42963c94ffdaab46fa07913bf0476f721d2` |
| 旁白整数计划 | `42ca9ca6288d697672bd4845b25b1be7d4a7c4f254bc6b2e371910695606a22a` |

#### 隔离与仍待真实验证

本轮基线和比对分别为 `.work/context-ir-isolation-before.json` 与 `.work/context-ir-isolation-after.json`。53 项受检文件包含旧 Skill、旧运行/配置、旧已修改文件、安装/命令及共享 Codex 配置；本轮零差异。之前最初开发阶段记录的共享配置历史差异仍保留，没有覆盖早期 `.work/isolation-baseline.json` 来消除它。按本轮源码副本得到的实际改动清单在 `.work/context-ir-final-review.json`。

没有发起真实收费 IR、图片或视频，没有修改 mttest1/mttest2/test34、旧项目/安装/Skill/配置/凭据/Git，没有覆盖真实全局命令、提交或推送。写入仅在本项目与测试临时目录。

公开资料已核对独立 IR 及共享查询的官方协议；Metaso `/api/minimax/v2/h3_context_ir` 是否支持，仍无法由公开页面/插件确认。IR 路由单独定义，保持原视频 URL，不在未知创建后尝试另一条路由。详见 [路由证据及限制](METASO_CONTRACT.md#独立-context-ir2026-09-19-公开资料核验)。真实包络/状态、图片与音频传输、IR 台词/引用/旁白保持、声线和视频效果、实际时长/MP4、供应商恢复行为均待另行授权验收，不能把本轮离线通过写成真实出片成功。

### Context IR 跨准备计划复用修复（2026-09-19）

修复独立核验发现的恢复阻塞：只修改其他段落或新增其他集时，当前段输入未变，成功 IR 会被复用，但原派生逻辑固定读取已经过期的初始准备计划，因而反复返回 `PLAN_STALE`。

现通过核对文件选择当前准备计划，完整重建并校验当前输入，再核对同项目、集、段、原文哈希、基础输入哈希及 IR 请求哈希。原始 IR 的 `planId/planHash/revision`、回执和结果保留，其他准备计划的核对及派生身份分别存入可选 `planBindings`。旧字段不增加默认值，原派生计划不覆盖；当前段实际输入有变化时仍拒绝错误复用。相同最终视频输入继续复用已有视频任务。

运行时只调整 `src/contracts/context-ir.ts`、`src/jobs/context-ir-store.ts`、`src/core/planning.ts`，新增 `tests/context-ir-reuse.test.ts`；未改动依赖、API 路由、凭据、视频任务或原提示词/旁白规则。README 与共享 IR 核对说明同步更新，Skill 名称和 CLI 命令不变。复用 IR 的 review 必须填写当前 preparePlanId/hash，不能照抄历史 operation.planId/hash；同一派生身份中断后继续使用已保存的 review。

| 实际检查 | 结果 |
| --- | --- |
| 新增恢复回归 | 12 项通过：修改同集其他段、新增其他集、旧视频恢复、四类当前段输入变化、跨集错误复用、三个新绑定持久化中断点、并发及篡改 |
| `npm run check` | 构建通过；17 个文件、137 项通过 |
| `npm run test:image-skill` | 11 项通过 |
| `npm run test:process` | 8 个进程中断恢复检查点及原两个跨进程锁检查通过 |
| `scripts/package-smoke.ps1` | 全新临时源码离线安装、构建、137 项测试通过；临时 prefix 安装/重复安装/卸载通过；8 个旧安装哨兵不变 |
| `node .work/ir-reuse-fix-verification.mjs` | 修复前的三组实际 IR 计划兼容；原故障故事的副本继续成功，新增 IR 创建数 0、假视频创建数 1、重复执行复用同一视频 |

兼容检查直接读取修复前保存的三个故事，涵盖目标 `12.378/6.666/6.963` 秒的准备与派生计划；六份 planHash 及故事中全部文件哈希一致。原缺陷复现故事也保持不变，仅在新副本中派生当前计划并提交假视频。证据在 [.work/ir-reuse-fix-verification.json](../.work/ir-reuse-fix-verification.json)，新增正式测试还验证了最终下载和旧视频的原 taskId 恢复。

旧环境复核对照保留的 `.work/context-ir-isolation-before.json`：旧 Git 状态、三个 `story2libtv` 命令路径及 **52/53 项文件哈希一致**。唯一差异为共享 `C:\Users\Administrator\.codex\config.toml`，其文件记录的最后修改时间为 `2026-09-19T07:12:06Z`。本次修复命令没有写入该文件，差异来源未确认；未恢复或覆盖共享配置，也未重置基线。因此隔离比较如实返回非零，不能将其写成 53 项全部未变。结果保存在 [.work/ir-reuse-fix-isolation-after.json](../.work/ir-reuse-fix-isolation-after.json)。此异常与已经通过的代码测试分别记录。

所有验证均封锁真实生成请求或使用假客户端。没有真实收费 IR/图片/视频，没有修改旧 LibTV 项目、安装和 Skill，没有操作 mttest1/mttest2/test34 的业务数据，没有提交或推送。Metaso 独立 IR 的真实路由、请求接受情况和出片效果仍待授权验收。
