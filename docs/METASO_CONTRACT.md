# Metaso H3 适配依据

核对日期：2026-09-17。本项目没有调用创建或查询真实任务的接口。

- Metaso 官方发布的 [适配源码](https://metaso.cn/minimax-h3/new-api-guide/minimax-h3-metaso.plugin.js)确认 Bearer 认证、创建 `POST https://metaso.cn/api/minimax/v2/video_generation`、查询 `GET https://metaso.cn/api/minimax/v2/query/video_generation/{task_id}`，以及 `content[].image_url.url` 结构。本项目直接实现 HTTP 客户端，不运行该插件，也不使用 New API。
- [MiniMax H3 创建文档](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)用于核对 MiniMax-H3 的时长、分辨率、图序/角色、首帧自适应比例、7000 字符及请求总大小边界。Metaso 可能有服务层差异，尚未以真实请求验证。
- [H3 查询文档](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query)给出任务对象、状态与结果 URL。文档的查询窗口有限；客户端不保证供应商长期保留任务和下载链接。

客户端只接受一个无歧义的 task ID；支持顶层 task_id 与 Metaso 插件展示的 task.id/task.task_id。未知外部字段可存在，但核心状态、身份和成功结果必须通过 Zod 契约。未知状态保留为 query_unknown。创建失败不会自动重试，明确 HTTP 拒绝与无法判断的结果分别记录。

Context IR 采用 Metaso 扩展 `context_ir_enabled`，默认 false 且显式发送；同样显式发送 `aigc_watermark`。不透传未核实的 billing_policy 或其他扩展。多图占位符渲染为按 content 数组顺序编号的自然语言标签，原文与渲染结果均保留。

第一版有意只开放 PNG/JPEG/WebP，未开放官方还列出的 HEIC/HEIF、尾帧、视频和音频参考。图片校验格式头/尺寸及哈希；视频检查 MP4 容器、视频轨元数据和时长/比例，不调用完整解码器。可访问 URL 不转发 API Key，拒绝带账号密码、内网地址字面量和不安全协议；不声称该轻量 URL 检查是完整的网络沙箱。

下一次真实验收需分别检查：三种生成模式、Data URL/公网 URL 接受情况、Context IR 显式选项、实际状态和错误格式、首帧比例、生成时长、原任务中断恢复、下载链接刷新和 MP4 元数据。离线通过不能证明供应商零故障或远端恰好执行一次。
