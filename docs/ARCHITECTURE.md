# metasocli 独立项目方案

2026-09-21 批次实施补充：新增不可变批次、授权运行索引和安装级共享生成预留，默认4个生成占位持续补位、2个独立下载。单段视频生命周期拆为短状态写锁与锁外 HTTP；按共享协调锁→项目写锁顺序，用提交归属 token 区分活跃 submitting 和失联 unknown。terminal Job 持久化后才释放名额，batch resume 可在原授权范围内补交，旧 resume 永不 POST。Plan/Story/Job 原格式及 H3、时长、图片、旁白构造保持兼容。详见 [批次命令](../README.md#四并发持续补位) 和 [实施报告](VIDEO_BATCH_CONCURRENCY_IMPLEMENTATION_REPORT.md)；下文串行/长锁描述属于早期设计。

2026-09-21 当前默认改为 [视频请求内启用 Context IR](INLINE_CONTEXT_IR_WORKFLOW.md)：新计划使用 `h3-inline-ir / inline-video`，实际视频 JSON 显式发送 `context_ir_enabled:true`，不先执行独立 IR。CLI 在联网前拒绝 false 计划创建视频；已有任务按原 ID 恢复。下文 2026-09-19 的两阶段设计作为历史兼容记录保留。

日期：2026-09-17。本文保留独立项目的初始设计；0.1.0 离线实现与实际命令现已交付，见 [README](../README.md) 和 [验证记录](VERIFICATION.md)。真实接口验收尚未完成。命名与边界以仓库 AGENTS.md 为准。

2026-09-19 实施补充：现有时长、参考图和单旁白能力之上已加入 [独立 Context IR 流程](CONTEXT_IR_WORKFLOW.md)。Plan 的无默认值可选 workflow 区分准备与单段视频派生；原 Story 和视频 Job 格式保留。独立 IR 记录/回执/原始文本/review 位于 `.metasocli/context-ir/`，通过父计划和结果哈希连接；提交前重建派生请求，最终内联 IR 为 false。各阶段各自持项目锁，锁内检查两类任务冲突，普通恢复不创建下一阶段。未增加依赖、数据库或后台服务。以下早期设计中的“拟定”状态以 README 的已实现命令为准。

## 决策

建立独立仓库 `metasocli`，建议源码目录 `E:\metasocli`，初始版本 `0.1.0`。将已经验证的剧本、分段、素材、文件一致性能力复制进入新仓库，分别维护；Metaso 视频任务执行部分重新实现。采用 Metaso H3 原生 API，保持 Node.js / TypeScript / Zod / 文件状态管理的技术结构。

不在旧仓库中切换工作分支进行开发，不建立共享运行目录，不使用指向旧代码的 npm link、目录联接、符号链接、硬链接或 file: 依赖。新项目不通过旧项目的 CLI 执行业务，也不动态读取旧项目的 Skill。首次复制完成后，新项目的构建、运行、升级和卸载应能完全独立。

接受的代价是两个项目以后需要分别维护通用修复。现阶段这是实现“不影响当前项目”更清楚的边界；暂不抽取需要旧项目一起升级的共享公共包。

## 复用基线

- 当前实际安装：`story-to-libtv@0.2.22`。
- 对应源码：[0.2.22 源码清单](E:/libcli/.story2libtv-work/video-prompt-entry-0.2.22-20260916/source/package.json)。
- 当前根目录清单仍为 `0.2.5`，且有六份已有修改；不能用一次 git clone 假定获得正在运行的 0.2.22 实现。
- `0.2.23` 是候选，其图片交接改动与 LibTV 补图有关。仅在新仓库中审查并移植适用修复，不整体沿用候选的远端补图链路。
- 首次复制使用明确文件清单，记录来源版本、来源路径、原文件哈希和复制后的哈希。排除凭据、旧业务数据、远端绑定、任务记录、node_modules、历史交付目录和 Git 元数据。新仓库有自己的 Git 历史、锁文件、测试、发布产物和版本号。

## 产品边界

保留两个入口：完整剧本入口与成品视频提示词入口。剧本入口继承完整台词、说话人、顺序和分段约束；成品提示词入口保留原文，不重新编排用户已经确认的段落。

新项目的输出由 LibTV 画布配置改为 Metaso 生成计划、远端视频任务和本地分段视频。计划预览与付费提交分开，默认的导入、素材检查和计划操作不生成视频。明确执行生成后，自动查询并保存结果。

```mermaid
flowchart LR
    A[剧本或成品提示词] --> B[分段与原文追溯]
    B --> C[参考素材准备与登记]
    C --> D[H3 参数及素材校验]
    D --> E[可预览的生成计划]
    E --> F[明确执行生成]
    F --> G[Metaso 原生 API]
    G --> H[任务查询与中断恢复]
    H --> I[本地视频与分段结果清单]
```

第一版覆盖文字生成、首帧输入、多参考图生成及完整的查询、恢复、下载闭环。参考视频、音频和尾帧按相同素材契约预留，完成主流程验收后逐项开放。先交付 CLI 与项目 Skill；如需 MCP，沿用同一 Core 并使用新注册名，避免复制一份业务逻辑。

## 安装与数据隔离

| 对象 | 旧项目 | 新项目拟用名称 |
| --- | --- | --- |
| 源码目录 | `E:\libcli` | `E:\metasocli` |
| npm 包 | `story-to-libtv` | `metasocli` |
| CLI | `story2libtv` | `metasocli` |
| 故事清单 | `story2libtv.yaml` | `metasocli.yaml` |
| 每个故事的状态目录 | `.story2libtv` | `.metasocli` |
| 用户运行目录 | `%USERPROFILE%\.story2libtv-runtime` | `%USERPROFILE%\.metasocli-runtime` |
| 安装归属 owner | `story-to-libtv` | `metasocli` |
| 安装回执 | `.story2libtv-install.json` | `.metasocli-install.json` |
| 可选 MCP 名称 | `story-to-libtv-<UUID>` | `metasocli-<UUID>` |
| 凭据变量 | 旧流程自己的认证 | 仅新进程使用的 `METASO_API_KEY` |

全部业务 Skill 使用新名称，内部相对引用同时更新：

- `metasocli`
- `metasocli-video-prompts`
- `metasocli-prompt-engine`
- `metasocli-reference-images`

优先在新项目作用域加载这些 Skill；如发布为用户级安装，也只能新增上述名称，安装器按新 owner 识别文件，不能接管旧名称。开发期使用新仓库内构建出的 CLI，不覆盖全局 `story2libtv`，不修改旧 MCP 注册或全局模型设置。

源码仓库与实际故事数据目录分离。初始化必须拒绝旧故事根、旧源码根及它们的受保护子目录，并考虑 Windows 大小写、符号链接、目录联接与规范化真实路径。新旧故事禁止共用可写的 assets、episodes、输出目录或锁。

## 模块复用范围

| 部分 | 处理方式 |
| --- | --- |
| 剧本读取、成品提示词提取、原文追溯 | 复制并改为新包内依赖，保留内容一致性测试 |
| 段落、镜头、台词锁与素材需求 | 保留通用规则；Seedance 专属措辞和参数改为 H3 适配规则 |
| 资产 ID、有序引用、文件哈希、配方 | 保留概念与校验，生成新项目独立文件和记录 |
| 原子写入、路径限制、文件身份、锁 | 审查后复用，替换归属及目录命名，保留故障测试 |
| project/state/contracts/service | 按领域拆分；这些文件仍引用 LibTV 绑定和 EnginePlan，不可原样视为平台无关 Core |
| LibTV runner、画布/分组/节点/边、模型探测 | 从新运行链移除 |
| LibTV configure plan/apply/readback | 用 H3 请求计划、任务记录、状态查询和下载流程替代 |
| CLI/MCP 外壳 | 复用组织方式，重写命令、工具契约和名称 |
| 安装器、升级器、卸载器 | 新命名空间与新 owner；验证只操作自身文件 |
| LibTV 图片补图 | 移除；不可改一个 URL 后继续使用 |

已有原始提示词中的 `{{ref:assetId}}` 可作为本地中间表示，按有序资产映射渲染为 H3 请求。LibTV 的 `{{Node nodeKey}}` 不能直接发送给 H3。保留原文与渲染结果各自的哈希，避免覆盖原始台词或依靠人物姓名猜测绑定。

## 参考图能力

保留原有的人物、场景、道具、首帧配方组织与登记方式；新命名的图片 Skill 调用宿主原生生图能力，或导入用户已有图片。首次结果保存展示，不重新引入旧版自动视觉 QA 门槛。

H3 是这里的视频生成接口，不是旧 LibTV 图片生成的替代 API。原生生图失败且无法恢复文件时，记录缺失资产并停止依赖该资产的生成段；可恢复其他独立的准备工作。若以后需要图片 API 兜底，单独接入经过核实的图片服务，不暗中调用 LibTV。

本地文件需转换为 Metaso 支持的输入形式。第一版优先验证小图片 Data URL 与可访问 URL，检查编码后请求总字节数；大素材走可访问 URL，不把本机路径当作远端 URL，不自动上传到未经配置的云存储。传输方式以 Metaso 端实际验收结果为准。

## 新项目内部结构

```text
src/
  cli/           命令解析与结构化输出
  core/          两种内容入口、工作流组合
  contracts/     故事、素材、生成计划和任务记录
  story/         原文、段落、提示词与引用渲染
  assets/        配方、文件校验、登记与媒体准备
  metaso/        H3 参数映射、HTTP 客户端、响应及错误解析
  jobs/          提交记录、轮询、恢复、下载
  storage/       原子写入、哈希、路径与锁
  setup/         新项目自己的安装及归属管理
skills/          四个独立命名的业务 Skill
tests/           内容契约、接口契约、恢复与隔离测试
```

保持单个 Node 程序和清楚的内部模块边界。第一版不增加 New API、常驻 HTTP 服务、业务数据库、消息队列或复杂通用插件框架。Metaso 客户端只负责构造请求和解析响应；是否提交、重试、恢复、完成由 jobs 模块决定。

建议的命令职责为 init、import、assets、plan、generate、status、resume、download、doctor。它们是拟定接口，尚未实现。所有可能写文件或付费的命令绑定明确的新项目根，不能自动扫描并接管附近旧项目。

## H3 契约与版本边界

新项目固定使用 Metaso 服务地址和相应的 Metaso API Key。凭据不进入 Git、计划内容、日志或生成结果；日志对认证头和可能带签名的素材地址进行处理。

第一版模型固定为 `MiniMax-H3`；默认建议 `768P`，文字与多参考图模式沿用竖屏意图，时长逐段校验。首帧模式的比例服从输入图片，不能把接口忽略的参数当作已生效。生成计划明确展示实际模型、清晰度、时长、素材角色和素材顺序。

标准 H3 当前文档规定 4—15 秒、768P/2K；首尾帧不能与多参考素材混用，请求体有总大小上限。新适配层按这些规则校验，不沿用旧 Seedance 的 480p 和全部开关字段。Context IR 等 Metaso 扩展设置显式写入计划，不能依赖账户默认值悄悄变化。依据：[H3 创建接口](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)、[Metaso H3 入口](https://metaso.cn/minimax-h3)。

提示词长度上限按实际 API 契约核实；网页输入框上限不直接当作 API 保证。超限时返回可定位的问题，不自动截断或删减台词。

## 任务一致性与恢复

每次生成有本地 operationId、请求哈希、素材哈希与顺序、模型参数、内容 revision、提交时间、远端 taskId 和本地输出记录。请求哈希用于本地去重，不能代替尚未证实的服务端幂等支持。

状态区分为 prepared、submitting、queued、running、generated、downloaded，以及 failed、cancelled、submit_unknown。远端返回未知状态或无法解析的响应时保留原证据并报告，不伪装成成功或普通排队。

1. 校验来源和素材，写不可变计划；内容变化使计划失效。
2. 获得项目和任务锁后，先持久化提交意图，再发送一次创建请求。
3. 返回 taskId 后尽早原子保存回执；持久化失败时停止进一步副作用。
4. 查询允许有界退避并遵守限流提示，查询超时不自动判定远端生成失败。
5. 创建请求已发出但结果不明时进入 submit_unknown；不凭本地哈希、超时或列表未找到就重发付费请求。
6. 远端成功后下载到临时文件，验证文件与元数据，再原子写入目标并保存哈希。
7. 下载失败只恢复下载；进程重启后凭原 taskId 恢复查询。失败任务的主动重新生成是一次独立、可追踪的尝试。

CLI 退出后本地轮询会停止，远端已经接受的任务可能继续运行；再次执行 resume 查询原任务。不能承诺关闭电脑后自动下载。第一版无需为此部署常驻服务。

## 旧内容的可选导入

提供单向复制导入，而不是共享读写旧故事：从指定旧故事读取原始剧本、原始提示词、有序资产和实际图片，复制到新故事目录，重新生成本地项目 UUID 和任务记录。

不继承旧账户凭据、远端 workspace/canvas/node/edge 绑定、操作锁、未知任务或支付记录。保留一份只读来源映射用于追溯；映射不参与旧系统恢复。转换后的 H3 参数在新计划中展示，遇到无法映射的提示词引用或旧规格时明确报告。

## 实施顺序与验收

1. **建立隔离基线。** 记录旧 Git 状态、命令路径、正式安装版本、四份 Skill 文件哈希与已有配置；新建独立仓库、包名和命令，开发运行使用新项目本地入口。
2. **完成离线内容链。** 在新项目复制必要源码与测试，拆出领域契约；用两个入口生成可预览计划，确认台词、资产与顺序可追溯。
3. **完成 Metaso 任务链。** 使用可注入的假客户端验证提交、限流、网络失败、未知结果、中断恢复和下载；不以离线测试通过宣称真实接口成功。
4. **进行小规模真实验收。** 在有相应凭据、明确生成授权和预算时，验证文字、首帧、多参考图及恢复行为；记录真实耗时和请求结果，再决定并发参数。
5. **交付新项目自身安装。** 先在临时用户目录验证安装、升级和卸载不会操作旧命名空间，再部署新名称；对旧项目基线进行比对。

关键测试包括：创建成功但回执丢失时不重复提交；返回 taskId 后中断能够恢复；下载中断不重新生成；素材变更使旧计划失效；并发执行只获得一个本地提交许可；失败与未知状态不会被当作完成；新安装与卸载不覆盖旧命令、Skill、MCP 或运行目录；隐藏旧 CLI 和旧源码路径后新项目仍可运行。

以上测试减少客户端错误和相互影响，不能保证第三方服务零故障，也不能在供应商未提供幂等能力时证明远端恰好执行一次。

## 直接依据

- [旧固定模型与数据契约](E:/libcli/.story2libtv-work/video-prompt-entry-0.2.22-20260916/source/src/core/contracts.ts:97)
- [旧文件名常量](E:/libcli/.story2libtv-work/video-prompt-entry-0.2.22-20260916/source/src/core/constants.ts:42)
- [旧用户运行目录](E:/libcli/.story2libtv-work/video-prompt-entry-0.2.22-20260916/source/src/core/runtime.ts:9)
- [旧 Skill 名称与安装归属](E:/libcli/.story2libtv-work/video-prompt-entry-0.2.22-20260916/source/src/setup/skill.ts:11)
- [成品提示词入口的 LibTV 补图依赖](E:/libcli/.story2libtv-work/video-prompt-entry-0.2.22-20260916/source/skills/video-prompt-to-libtv/SKILL.md:44)
- [Metaso 提供的插件源码](https://metaso.cn/minimax-h3/new-api-guide/minimax-h3-metaso.plugin.js)
- [H3 查询协议](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query)
