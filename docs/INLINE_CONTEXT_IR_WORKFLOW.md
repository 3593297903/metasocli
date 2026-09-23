# 当前默认：视频请求启用 Context IR

2026-09-21 按用户要求切换。三个业务入口及默认 `plan --episode` 都使用 `h3-inline-ir`；授权生成后，每段向 `POST https://metaso.cn/api/minimax/v2/video_generation` 发送真正的 JSON 布尔值 `context_ir_enabled: true`。由 Metaso 在该请求内处理 IR，不先调用独立 `/h3_context_ir`，不预先改写或翻译原提示词。

## 准备与执行

1. 保持原文导入、时长向上取整、参考图片准备与登记。旁白入口仍只给明确含旁白的段绑定指定音频；原图序、原文、cues 和素材哈希不变。
2. 新草稿的 `parameters.contextIr` 明确写 true。历史清单可以保留 false；新计划使用明确记录的 inline 策略得到实际请求，不原地修改清单或旧计划。
3. 执行以下离线命令，核对所有 `segments[].contextIr` 都是 true、`workflow` 为 `{"type":"h3-inline-ir","stage":"inline-video"}`。默认省略 `--workflow` 也采用此策略。

```text
node E:\metasocli\dist\cli\main.js plan --root <story> --episode <id> --workflow h3-inline-ir
```

4. 展示 planId、段落范围、时长、模型、分辨率、图片/音频顺序和完整请求文本，说明视频请求包含收费 IR，默认在提交前暂停。仅配置 true 或创建计划不会联网生成。用户已明确授权当前范围和此模式时直接继续，不逐段再次询问；本次程序升级不等于授权生成业务视频。
5. 素材就绪后按当前选择范围建立离线批次；授权后运行整个批次，不逐段或每4段再次确认：

```text
node E:\metasocli\dist\cli\main.js batch plan --root <story> --episodes <有序集ID> --concurrency 4
node E:\metasocli\dist\cli\main.js batch run --root <story> --batch <batchId> --confirm
```

部分段用 `batch plan --selection <selection.json>`，完整格式见 [README](../README.md#四并发持续补位)。单段兼容命令仍为 `generate --plan <id> --segment <id> --confirm`。提交时重新构造同一请求并核对计划哈希，HTTP 客户端将该请求完整 JSON 序列化发送，不能只在提示词或日志里写 true。CLI 会在读取凭据、创建任何任务前拒绝所选范围内含 false 的计划，返回 `INLINE_IR_REQUIRED`；批次只接受冻结的 inline 计划。新计划不能直接覆盖旧计划中的开关或哈希。

默认4个生成占位持续补位，收到 task_id 不释放；终态验证落盘后释放。下载独立最多2个并行。`batch status` 只读本地，`batch resume` 可接回任务并继续原授权内待提交段；旧 `resume --operation` 始终不新建。未知创建保留占位、停止新增，下载失败仅恢复下载。所有新版 CLI 视频创建入口共用安装名额；真实账户并发与限流尚未付费验收。

## 历史项目与恢复

- 已有项目要进行新的生成，对原始集执行上述新 plan 命令即可；素材无需重新生成，原文和旁白绑定无需重导入。
- 旧 false 计划（包括独立 IR 派生计划）不能直接交给当前 CLI 新建视频。不得把已增强文本又当作原文自动叠加一遍 IR；重新计划应选择原始集。若历史任务曾手工增加 `*-ir` 副本集，应选择其对应的原始集。
- 已经提交、成功或结果未知的任务仍用 `status`、`resume`、`download`、`attach-task` 按原 ID 恢复。升级不会重生成它们，也不会把历史请求改为 true；未知或活动任务依旧阻止冲突的新提交。
- 旧独立 IR 文本命令、派生计划契约与底层兼容模块保留，供历史数据核对和明确要求的独立文本任务使用。它们不是当前 Skill 默认生成流程。不要直接调用底层 `submit` 绕过 CLI 的 true 检查。

## 请求参数与响应证据

[Metaso H3 页面](https://metaso.cn/minimax-h3)的 API 弹窗将 `context_ir_enabled` 定义为可选请求参数，显式参数优先于全局开关。当前公开响应契约不要求回传它；创建返回 task_id，成功视频查询返回 `task_type:generation`、`modality:video`、`content.url`，见 [官方查询字段](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query)。程序不会伪造服务端返回的 true，也不会因响应缺少开关而再次付费提交。

内联模式没有独立的本地 IR 文本审阅停顿，不能声称在生成前已人工核对服务端内部增强文本。原始提示词与完整素材仍原样送入该请求，模型对台词、镜头及声线的实际遵从程度需查看真实成片。

此次改动只做离线 HTTP 序列化、任务恢复及旧计划兼容测试，不发起付费调用；不能把离线验证写成 Metaso 已实际接收本次 true 请求。
