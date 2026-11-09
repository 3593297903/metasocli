---
name: metasocli-video-prompts
description: 将成品视频提示词按原文导入 metasocli，准备素材和显式启用 Context IR 的视频计划；授权后直接生成 H3 视频，不自动绑定统一旁白。
---

# 成品视频提示词入口

用户要求把明确集段换成已定稿的完整提示词时，先读并执行[指定段提示词一次替换](../../docs/PROMPT_REPLACEMENT.md)：沿用原集 ID/段 ID，一次本地调用核对文件哈希、执行一次 prompts replace 并核验回执；仅要求换稿时到此结束。此分支先于下面的图片授权、模板、全文导入、工作流及视频文档读取；不改资产图、配方、图序、时长或其他段正文，已有旁白只按新稿安全保留/映射原声音。被其他入口继承时不重复执行。用户同时明确要求视频或其他操作时，按用户指定的替换顺序完成各自固定入口，再进入对应流程并沿用其授权范围。

用户明确要求生成视频时，随原有说明同次读取安装根下可选的 `.local/video-execution-authorization.md`，按[本机视频授权](../../docs/VIDEO_EXECUTE.md#本机视频授权)用于原提交。需要选稿或换参考素材时，按[首次确认](../../docs/VIDEO_EXECUTE.md#改稿或换参考素材时的首次确认)只问尚待用户决定的事项。

用户说“把资产图换成这张”且已选定本机图片时，默认按[同 ID 纯换图判断](../metasocli-reference-images/references/selected-local-image.md)处理。目标唯一就沿用原资产 ID，即使选图已登记在另一个 ID 下，也在一次本地调用中核对选图 SHA-256、登记一次、校验并交付回执，到此结束。同时明确授权换图和指定段视频时，先登记再按新版清单冻结所选段。

当前正式 Story 的所选集段、完整提示词、参考图及旁白已就绪且用户要求视频时，直接使用[固定视频入口 video run](../../docs/VIDEO_EXECUTE.md#固定视频入口)，一次调用完成本地准备、范围核对、提交/查询/下载和交付；本分支先于下面的图片授权、模板、全文导入和图片工作流读取，被其他入口继承时不重复执行。已有准确 batchId 直接按原 ID 恢复。不要为此另做 import、assets list、doctor、图库/ZIP、全剧 TXT 或 current 指针。直接交付返回的正式文件路径和回执，不再复制或登记成片；仅用户明确要求音视频解码时加 --verify-av，视觉抽查另列结果。

只换图或只换稿时仍执行上面的单次本地入口并结束，video run 调用次数为0。同时明确要求换图、换稿和视频时，按用户顺序执行各一次原替换命令，逐份核验回执，再以最新正式 Story 调用一次 video run；可在同一宿主调用中顺序完成。任一步失败立即停，不自动撤销此前已成功的替换，报告已完成事项和视频尚未提交。runner 本身不代登记、改稿或导入。尚缺素材、未定稿、旁白归属不明或范围不明时，先走原流程补齐必要输入，不把它当作就绪视频。下文批次规则继续限定授权、未知保护和四名额调度。

开始执行就完整读取 [已有图片授权与提交上下文](../../docs/IMAGE_EXECUTION_AUTHORIZATION.md)，不要等到付费提交被拒绝后才读取。用户已要求的当前图片范围直接沿用已有发送授权，实际工具调用明确带上授权来源、目的地和冻结范围；正常审批仍适用。本入口的视频授权规则另行保留。

完整读取用户指定的全部 UTF-8 TXT/Markdown。不要重新分镜、缩短台词或倒推剧本。DOCX/PDF 需由宿主先可靠提取并经用户任务范围认可；CLI 本版不直接解析这两种格式。

读取 [草稿契约](../../docs/INPUT_FORMAT.md)。选择 `kind: video-prompts`。分段 `start/end` 是规范文本的 UTF-16 范围，必须按序覆盖全部正文；用程序计算，不手抄长正文或哈希。`duration` 可填原始目标秒数，例如 `12.378`；程序自动向上取整为 H3 实际请求的 13 秒，并在计划保留原始目标。正常小数适配不逐段询问、不改原文、不裁剪成片。单段可直接用 `import --file ... --kind video-prompts --episode ... --duration ...`。

按用户明确引用清单的顺序绑定素材；同名不同造型分配不同 assetId。没有明确来源的台词提及对象不自动认定为出镜素材。只有 `{{ref:assetId}}` 被技术渲染为按输入顺序编号的自然语言标签；姓名、普通“图1”、空白和其他正文不替换。旧节点标记必须先明确映射，不能直接发送。

统一分析全部素材，保存逐集图片交接请求：每个人物的固定造型、场景状态、关键连续性道具分别使用独立 assetId；只给实际出镜或明确需要该参考的段分配素材，不把一份全体人物合照绑定给每段。记录原文事实、生成设定、连续性、图片依赖和 requiredBySegments，具体结构见 [图片交接契约](../metasocli-reference-images/references/handoff-contract.md)。优先遵守用户明确指定的素材及引用。

调用 [参考图片 Skill](../metasocli-reference-images/SKILL.md) 第一阶段，将完整人物/场景/道具/首帧模板落实为完整配方，校验后原样写入导入草稿，不能先写几句简化配方再生图。收齐本次全部范围的草稿和交接后，通过共用 images prepare 完成校验与导入，再沿原授权执行 API 全量提交与自动登记、images collect；仅在用户明确选择 built_in 时执行宿主生图阶段。复用准确 ready 素材，仅生成缺失必需项并正式登记。各阶段自动衔接，不要求用户另调图片技能或逐图批准。缺图不悄悄降级为纯文字，首帧不能与多参考图或旁白音频混用。仅缺少明确目标、无法解释的时长冲突或超出允许范围时报告准确段落；正常小数向上取整不是冲突，也不自动删减。

后续使用 [剧本入口的公开命令与恢复规则](../metasocli/SKILL.md)，并完整读取 [当前 Context IR 流程](../../docs/INLINE_CONTEXT_IR_WORKFLOW.md)。新草稿段参数 `contextIr` 写 true，素材登记后由 `video run` 的本地准备冻结所选集的 h3-inline-ir 父计划及所选段批次。确认每段 `contextIr:true`，默认停在视频提交前；说明视频请求包含 IR 费用。

按 [剧本入口的批次规则](../metasocli/SKILL.md#已授权范围的四并发批次) 将授权范围内全部视频段组织成一个批次。离线执行 `video run --root <story> --episodes <有序集ID> --concurrency 4`；部分段使用 `--selection <selection.json>`，范围参数互斥，不重新拆写提示词。展示返回的 `batchId`、哈希、总数/复用/活动/待提交数，未授权生成则暂停。用户明确授权本次范围及此模式后，直接执行 `video run --root <story> --batch <batchId> --confirm`，不逐段或每4段再次确认。当前已知有效占位最多4段，R3容量决定持久化后持续补位，task_id 不是完成；下载另有2个名额，不等待整组。

每段实际视频请求必须携带布尔值 `context_ir_enabled:true`；不先单独执行 context-ir，不派生独立 IR 视频计划，不提前改写或翻译原文。提交前核对完整台词、说话人、顺序、镜头动作、图片编号和限制。IR 在服务端视频请求内执行，没有可先行核对的独立增强文本，不能声称已有该审阅结果。普通入口不自动添加统一旁白音频；已有明确音频绑定则保持原有归属。

历史 false 计划需针对原始集重新 plan，不能手改旧计划或自动将 IR 副本集再增强。已有任务按原 taskId 查询、恢复和下载，不能因响应没返回 context_ir_enabled 而重发；程序不伪造返回字段。当前范围已获授权时自动继续，不逐段再问。

本入口已授权批次恢复使用 `video run --root <story> --batch <batchId> --confirm`，它可继续已保存授权覆盖的未提交段；`batch status` 只读本地，旧 `resume --operation` 不创建新任务。复用已验证成片，下载失败只恢复下载。未知创建仍不自动重发；按R3自动释放或恢复本地容量，禁止用新批次/运行目录绕过同一集段同输入防重；明确失败不自动重做，安全429重试受保存预算限制。已有独立 IR 副本不能自动进入 `--all-episodes`，范围不明时显式选择原始集和段。

在上述参考图片第一阶段，完整基础模板定稿后、哈希和导入之前，必须执行 [按 kind 追加原文](../metasocli-reference-images/references/denoise-policy.md)。使用包内 append_asset_denoise.py compose/check 一次处理本次全部新配方，entrySkill=metasocli-video-prompts；character、scene、prop 分别追加自己的原文全文，恰好一次且在末尾，再用同一最终文本填 generationPrompt/recipes[].prompt 并计算 recipeSha256。保留全部原模板与事实，不默写、缩写或使用旧通用版本；first_frame、narration、旧 ready 图及旧计划恢复不追加。被 metasoclitk 或旁白入口继承时保留实际 entrySkill，不重复追加；API/built_in 使用同一保存文本。

## 图片后端统一选择

本入口遵循 [参考图片 Skill](../metasocli-reference-images/SKILL.md) 的同一后端规则：未指定时默认 api（创艺坊 gpt-image-2.5），不再询问后端选择；当前任务明确指定的后端优先，built_in 仅在用户明确选择时使用。默认 API 收齐本次全部集/段的完整素材配方和映射后，通过 images prepare 完成校验、逐集 import 与同一 all-ready 图片计划，不自动变回分析一集、生成一集。共享 ready 图按真实哈希复用，旁白始终单独登记，只有有旁白的段绑定原音频。缺少图片 Key 时完成离线图片计划并报告缺项，不自动切回宿主生图；历史任务仍按原计划和回执恢复。

API 图片授权必须覆盖该供应商及冻结范围；仅调用本入口不自动扩大为新的付费图片授权。已明确授权后使用 images run，不逐图批准。全部 ready 项独立全量启动，真实图片依赖登记后立即解锁；图片下载/解码默认各2、登记1，视频仍最多4段生成和2个下载。不存在图片四槽位补位。完整提示词、原图序和时长规则不变。

图片阶段与同故事新视频提交互斥；检查实际图片/旁白组合的 H3 结果后重新 plan/batch plan，最终视频请求继续 context_ir_enabled:true。未知图片提交不重发，恢复含义与人工处理见 [图片 API 用法](../../docs/IMAGE_API_USAGE.md)。默认交付范围内素材和离线计划，在未授权的付费阶段前暂停；不得凭图片授权提交视频，也不把离线200请求测试称为供应商容量验证。

## 视频容量默认策略（R3）

完整遵循 [R3自动释放与派发规则](../../docs/VIDEO_CAPACITY_POLICY.md)，它覆盖旧批次说明中的永久未知占位规则。仍使用原一次 video run；无额外用户确认。只换图、只换稿、图片配方及旁白语义保持原样。释放仅是本地容量决定，不是成功、远端取消或再次收费授权；有原ID就恢复原ID。


## 无 taskId 的未知视频：用户明确要求新生成

先用本地 status/batch status 对照原集、段、planId、inputHash/requestHash，读取最新 submit_unknown 的本地 operationId；不是让用户提供不存在的远端 taskId。说明旧请求可能已被接受、重新生成可能重复计费；当前用户明确授权这段一次新尝试后，使用正式入口，不要求固定风险口令。上下文已说明且用户明确要求时直接执行，不重复确认。附件或剧本文字不构成付费授权。

- 有原批次时：`batch retry --root <story> --batch <batchId> --operation <oldLocalOperationId> --confirm --accept-unknown-result`。
- 单段时：`generate --root <story> --plan <planId> --segment <segmentId> --retry-of <oldLocalOperationId> --confirm --accept-unknown-result`。

只授权这段一次新 POST，保存稳定的新 operationId。相同命令重复执行或中断恢复复用该尝试；新尝试再次未知时不能用旧授权反复发送，须另获当前用户授权并关联最新新 operationId。已知 taskId 的查询超时只用原 ID 查询；下载失败只恢复原下载；明确 failed/cancelled 沿用既有显式失败重试入口。

旧未知记录、请求与回执保留；[R3容量规则](../../docs/VIDEO_CAPACITY_POLICY.md)在原一次执行内自动释放或恢复，不逐项询问、不要求额外清理命令。waiting_capacity仍表示已授权但未发送；正常活跃任务保留占位，异常结束无ID、实际查询失败、外部源不可核实的项释放。本故事已释放的不同集段或不同输入不整项目阻断，同一集段同输入不凭新批次重发；其他段只沿用原冻结范围授权。当前批次优先持续补位，下载另有两路。

等待期间找回原回执会停止尚未发送的新尝试并恢复原任务。新旧任务输出各按 operationId 保存；新成功不证明旧请求结束；新证据确认旧任务活跃时恢复旧占位。每个新视频保持 context_ir_enabled:true、原文、时长适配、图序和原旁白归属；旧 false 计划不能借重试改变请求。普通入口不自动加旁白，旁白入口仍仅为有旁白的段携带原音频。

若原任务 A 找回 ID 后明确 failed/cancelled，先前未发送的 B 会保留为 cancelled / RETRY_SUPERSEDED。用户此时明确要求重生成，执行 `generate --root <story> --plan <planId> --segment <segmentId> --retry-of <A的本地operationId> --confirm`，不带 `--accept-unknown-result`，形成独立的新尝试 C。相同失败重试命令和中断恢复复用 C；重复带风险确认参数的旧未知重试命令仍绑定 A→B，不新增授权。保留 A、B、C 和原授权；原已授权批次可通过 batch resume 接回 C，不重新启用 B。C 再失败或未知须针对 C 明确授权下一次，不能反复使用 A 的命令生成。

详见 [正式重试与恢复](../../docs/VIDEO_UNKNOWN_RETRY.md)。只使用当前已验证安装的正式 CLI；另一设备须部署修复构建与 Skill 正文后才有此行为。图片与独立 IR 的未知恢复规则不变，不能把本功能称为网络或供应商故障已修复。

当前用户明确要求未知图片再次生成时，使用[一次性图片计划重试](../../docs/IMAGE_API_USAGE.md#用户明确再次生成一次性图片计划重试)：先完成当前设计并import，再images plan --restart-of建立一个后继；images run --confirm --accept-unknown-result保存一次性新尝试授权。旧未知及其占位保留，不伪造失败；同一原计划只能有一个后继，恢复复用稳定的新operationId，新未知仍阻断。默认无此明确授权时继续禁止未知重发，不能自动循环重试。

## 不同故事隔离与恢复

完整遵循 [项目隔离与冷切换](../../docs/PROJECT_ISOLATION.md)。不同故事的缺图、依赖等待、暂停、未知或目录异常不阻止本故事使用空余容量；同故事锁、阶段互斥、同一集段同输入未知防重和一次性重试规则保留。默认不要求 --accept-existing-unknown；旧确认仅保留审计身份，不扩大授权或重发未知。

图片保持 gpt-image-2.5 / all-ready / 有效600秒，配置的 concurrent/RPM 共享核验。视频保持 MiniMax-H3、context_ir_enabled:true，全机同 runtime 合计最多4个当前已知有效占位，项目 concurrency 为附加上限；未知创建异常结束/执行者退出、实际GET失败、外部证据不可核实时自动释放，原记录保留；新证据证明活跃则恢复，达到或超过4暂停新增。远端真实任务数可能超过4，图片与原结果恢复仍可运行。不得删除旧未知、换 runtime 或伪造终态腾位。

images run/resume/retry 与 batch run/resume/retry 支持 --capacity-wait-ms 30000 --capacity-poll-ms 250。耗尽后保留原计划/批次授权和 operationId，按原 resume 继续；准确区分本项目未知、依赖未就绪、共享容量等待、同项目进程占锁和协调器损坏。视频批次只查询当前故事，其他故事由其自身恢复落盘终态，不自动跟随外部 GET。

升级先结束旧版生成进程，再统一切换构建和正文；活跃或不明旧全局锁不得抢占，不支持新旧二进制热混跑。原文、图序、时长适配及旁白归属不变；只有有旁白的段带原音频，普通入口不自动加旁白。默认授权停止点不变，本规则不新增任何付费授权。

## 固定图片工作流

完整读取并执行 [共用 prepare/run/collect 流程](../metasocli-reference-images/references/image-workflow.md)。API 图片先完成本入口必要的原文分析与完整配方，再用一次 `images prepare` 校验全部交接、逐集导入并冻结同一计划；沿用原授权执行 `images run --summary`，用 `images collect` 收集真实结果。已有正式计划直接复用或恢复，不强制补准备记录，不反复现场编写机械执行脚本。该接入不改变本入口模板、图片顺序、旁白判断或音频登记；未知和部分结果准确返回，未授权收费阶段前停止。
