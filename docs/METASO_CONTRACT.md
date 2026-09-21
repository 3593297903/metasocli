# Metaso H3 适配依据

2026-09-21 再次核对 [Metaso API 弹窗](https://metaso.cn/minimax-h3)及 [官方查询字段](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query#response-task)：`context_ir_enabled` 是可选请求参数，显式参数优先于全局开关；公开响应契约不要求回传它。视频创建返回 task_id，成功查询返回 generation/video/content.url，不伪造响应中的开关。此次 true 模式仅离线验证，未发起新的付费请求。详见 [当前流程](INLINE_CONTEXT_IR_WORKFLOW.md)。

核对日期：2026-09-17；旁白扩展复核于 2026-09-18。尚未创建真实生成任务；账号连接曾对不存在的任务 ID 做只读认证探测，见 [验证记录](VERIFICATION.md)。

- Metaso 官方发布的 [适配源码](https://metaso.cn/minimax-h3/new-api-guide/minimax-h3-metaso.plugin.js)确认 Bearer 认证，以及在 `ctx.baseUrl` 后拼接创建 `/minimax/v2/video_generation`、查询 `/minimax/v2/query/video_generation/{task_id}` 和 `content[].image_url.url` 结构。项目已采用的 base 为 `https://metaso.cn/api`；不能仅由插件后缀推断所有新路径都支持 `/api`。本项目直接实现 HTTP 客户端，不运行该插件，也不使用 New API。
- [MiniMax H3 创建文档](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)用于核对 MiniMax-H3 的时长、分辨率、图序/角色、首帧自适应比例、7000 字符及请求总大小边界。Metaso 可能有服务层差异，尚未以真实请求验证。
- [H3 查询文档](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query)给出任务对象、状态与结果 URL。文档的查询窗口有限；客户端不保证供应商长期保留任务和下载链接。

客户端只接受一个无歧义的 task ID；支持顶层 task_id 与 Metaso 插件展示的 task.id/task.task_id。未知外部字段可存在，但核心状态、身份和成功结果必须通过 Zod 契约。未知状态保留为 query_unknown。创建失败不会自动重试，明确 HTTP 拒绝与无法判断的结果分别记录。

2026-09-21 默认切换为 `h3-inline-ir`：新计划的实际视频请求明确携带 `context_ir_enabled:true`，水印继续按独立参数发送。旧 manifest 解析默认值及历史请求哈希保持；新计划用可验证的 workflow 策略覆盖实际 IR 请求值。CLI 拒绝 false 计划新建视频。以下独立 IR 章节是历史模式，不能混同当前默认流程。不透传未核实的 billing_policy 或其他扩展，多图顺序和完整原文继续保留。

第一版图片只开放 PNG/JPEG/WebP，未开放官方还列出的 HEIC/HEIF、尾帧和视频参考。2026-09-18 另按用户要求新增单一旁白音频参考，见下文。图片校验格式头/尺寸及哈希；视频检查 MP4 容器、视频轨元数据和时长/比例，不调用完整解码器。可访问 URL 不转发 API Key，拒绝带账号密码、内网地址字面量和不安全协议；不声称该轻量 URL 检查是完整的网络沙箱。

## 统一旁白扩展（2026-09-18）

再次只读核对上述 H3 创建文档及 Metaso 公开插件 1.1.0：后者 `FILE_FIELDS.reference_audio` 明确为 `type: audio_url`、`role: reference_audio`、默认 MIME `audio/mpeg`，`fileItem()` 将文件编码为 Data URL；`buildSubmitRequest()` 仍请求 Metaso 原生 `/api/minimax/v2/video_generation`。源码仅用于核对，没有执行其插件或引入 New API。

官方音频限制为 MP3/WAV、单文件 15 MB、每份 2–15 秒、最多 3 份且合计不超过 15 秒。当前旁白扩展有意仅支持一份固定声线参考；本地上限沿用 Metaso 插件的 `15 * 1024 * 1024` 字节。WAV 本地只接收 PCM/IEEE float，MP3 检查完整 MPEG Layer III 帧与常见 ID3/Xing 信息。校验不等于完整解码或声纹效果验证。

普通参考图与旁白音频可组成多模态参考输入，图片顺序保持不变，音频追加在图片之后。首帧/尾帧与 `reference_audio` 互斥，不用旧 LibTV 的 `mixed2video` 开关或 `{{Node ...}}` 标记。没有独立后期混音/TTS 功能。真实 Data URL/公网 URL 接受情况、旁白声线一致性及对白保留效果仍待明确授权的真实生成验收。

下一次真实验收需分别检查：三种生成模式、Data URL/公网 URL 接受情况、Context IR 显式选项、实际状态和错误格式、首帧比例、生成时长、原任务中断恢复、下载链接刷新和 MP4 元数据。离线通过不能证明供应商零故障或远端恰好执行一次。

## 独立 Context IR（2026-09-19 公开资料核验）

本轮仅访问公开页面、页面静态资源和文档，没有携带账号凭据访问 IR、图片或视频创建接口。MiniMax 文档页面在检索工具中超时后，以公开 HTTP GET 读取正文；没有执行下载的网页脚本。

- [MiniMax 独立 IR 文档](https://platform.minimax.cn/docs/api-reference/video-generation-v2-h3-context-ir)列出官方 `POST /v2/h3_context_ir`，模型 `MiniMax-H3`，输入 `content`、`duration`、`ratio`。独立任务只返回增强文本，不同时创建视频。本实现 IR 请求仅包含这四项，不透传视频分辨率、水印或内联 IR 开关。
- [官方查询文档](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query)区分 `task_type=h3_context_ir`、`modality=text`、`content.prompt` 与视频的 `task_type=generation`、`modality=video`、`content.url`；公开说明的任务查询窗口为最近 7 天，因此增强结果必须尽早本地保存。客户端要求 IR 的模型、任务类型和 ID 一致，不把 prompt 当下载 URL。
- [Metaso H3 公开页](https://metaso.cn/minimax-h3)展示 Context IR 及其计费；本轮读取的页面、两个入口静态块及 [公开适配源码](https://metaso.cn/minimax-h3/new-api-guide/minimax-h3-metaso.plugin.js)未给出足以确认独立 IR `/api` 别名的证据。插件只说明视频路由与外部传入的 baseUrl；不能证明用户截图的 `/minimax/v2/h3_context_ir` 和当前项目 `/api/minimax/v2/h3_context_ir` 等价。

| 本项目独立常量 | 当前值 | 证据状态 |
| --- | --- | --- |
| IR 创建 `CONTEXT_IR_CREATE_URL` | `https://metaso.cn/api/minimax/v2/h3_context_ir` | 按项目现有代理前缀和官方 IR 后缀推定，**Metaso 实际支持待真实验收** |
| IR 查询 `CONTEXT_IR_QUERY_BASE` | `https://metaso.cn/api/minimax/v2/query/video_generation/{task_id}` | 沿用既有查询路径；同路由查询 IR 类型的服务端支持待验收 |
| 原视频创建 | `https://metaso.cn/api/minimax/v2/video_generation` | 保留原配置，本轮没有变更或真实生成 |

IR 创建与查询 URL 单独定义，不全局替换 API_BASE。一次创建结果不确定后禁止自动切换到无 `/api` 路由，也禁止再次提交试探；查询重试始终围绕同一 taskId。Key 只发给 Metaso，绝不发往官方 MiniMax 域名。

准备计划保留基础视频 requestHash，IR operation 另存真实四字段 POST 的 irRequestHash；派生视频计划保存新的实际请求摘要与来源证明。两阶段使用同组媒体角色、顺序、字节身份与执行时长。增强文本完整保存，经原入口核对后只替换视频 text，明确 `context_ir_enabled:false`，不重复执行内联增强。超长/缺句/错引用保留文本并停止派生，不截断、不自动再次付费。

待另行授权验证：上述 Metaso 创建/查询路由、真实包络和状态、图片/单旁白 Data URL 及公网 URL 接受情况、增强文本对台词/图序/旁白归属的保持、实际时长和最终 MP4，以及真实中断/限流/下载恢复。本轮离线测试不能替代这些服务验证。
