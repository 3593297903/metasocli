# 新图片配方按 kind 追加去噪原文

只在 `metasoclitk`、`metasocli-video-prompts`、`metasocli-video-prompts-旁白` 三个入口以后新准备、尚未导入和冻结的图片配方启用。继承入口保留实际 entrySkill，只组装一次；不向用户新增“是否去噪”的确认。其他调用者保持原默认行为。

先按入口原有完整模板和用户事实写完基础提示词，包括全部布局、尺寸、参考图角色和技术说明；metasoclitk 继续完整采用自己的 jianc 三类模板，另两个入口保留原模板。然后读取包内固定原文，使用本地工具一次处理本次全部新资产。禁止临场默写、摘要、合并或使用旧通用版本。

| 已校验 kind | 唯一正文（UTF-8，无 BOM，LF，结尾一个 LF） |
| --- | --- |
| character | [人物全文](denoise/character.txt)：皮肤、头发、服装与配饰，背景场景原样 |
| scene | [场景全文](denoise/scene.txt)：场景与环境材质，人物服饰原样 |
| prop | [道具全文](denoise/prop.txt)：单件道具与多视图结构板 |

固定版本和 SHA-256 见 [manifest](denoise/manifest.json)。不得按素材名称、文件名或提示词关键词猜类型。正文中的“原图”、Markdown、正负提示词、标点和段落逐字保留；不要求额外原图、不虚构参考、不先生成底图、不调用第二次去噪接口。

在本故事新的 `.metasocli/drafts/<本次UUID>/` 工作目录准备辅助输入；调用者负责筛出真正的新配方，不能把 reused、已导入、已有 preparation/plan/job 或正在恢复的提示词传入。工具不读取故事/账本推测是否为新资产，也不修改旧文件。输入不是 Core ImportDraft：

```json
{"schemaVersion":1,"entrySkill":"metasoclitk","items":[{"assetId":"lead-new-v1","kind":"character","prompt":"已经按人物完整模板展开的全部基础提示词"}]}
```

以本正文所在安装的实际 INSTALL_ROOT 调用，路径有空格时加引号，不硬编码源设备磁盘：

```text
python -X utf8 -B <INSTALL_ROOT>/skills/metasocli-reference-images/scripts/append_asset_denoise.py compose --input <new-recipes.json> --output <final-prompts.json>
python -X utf8 -B <INSTALL_ROOT>/skills/metasocli-reference-images/scripts/append_asset_denoise.py check --input <final-prompts.json>
```

两条使用同一份 [本地组装工具](../scripts/append_asset_denoise.py)，不加载 Key、不联网、不创建或重试任务。由入口执行，不要求用户手写这些辅助文件。输出保留 entrySkill、assetId、kind、basePrompt、最终 prompt、recipeSha256、policyVersion 和 denoise.textSha256；辅助元数据不添加到 Core 严格 schema。

最终文本是原完整基础文本 + 两个 LF + 对应正文全文，正文必须位于最后。只允许既有 BOM/CRLF/CR→LF 规范化，不删基础文本的空白和内容。已包含同种全文一次且在末尾时复用，EOF 的 LF 数可规范为固定正文的一个 LF；重复调用或对辅助输出再次 compose 不叠加。同种全文重复、错种全文、尾段后还有文字会报具体 assetId，先在尚未冻结的新配方中核对并修正，完整保留基础配方，不新增生成授权询问。未知 kind 拒绝；first_frame、narration 若用于检查输入则原样返回、denoise.applied=false，旁白仍排除于真实图片交接和请求。

工具先追加和核对，再按现有规范化方式计算 recipeSha256；最终含尾段最多 32000 UTF-16 单元，超出则报错，不截断或改写。输出文件不存在才创建；已存在且字节一致复用，否则拒绝覆盖，输入始终只读，不能原地改输入或旧草稿/计划。写入中断留下的不完整辅助输出不得当作成功结果，应选新的准备输出文件，保留旧证据。

将输出的同一 prompt 填入 reference-image-recipe.json 的 generationPrompt 和 draft.json 的 recipes[].prompt，recipeSha256 直接使用输出值。assetId/kind、exactText、依赖顺序、requiredBySegments、视频原文及 narration 原样保留。recipeSha256 是提示词哈希，Core recipeHash 是完整配方对象哈希，两者不能混用。接着运行原 handoff 校验及 [images prepare/run/collect](image-workflow.md)，不在 client 或 HTTP 发送时另加文字。

API 与用户明确选择的 built_in 使用同一最终保存文本。built_in 读取文件后完整传给工具，不再缩写、优化或在尾段后补技术说明。原模型、尺寸、超时、all-ready、依赖解锁、登记和授权规则均不变。

旧 ready 图片按原配方和真实文件哈希复用，不自动重画。旧 preparation、plan、job、未知任务、下载待恢复项及保持原请求的重试继续用原冻结文本、operationId 和回执，不补尾段、不重算旧哈希、不清账本；此检查不是全局历史计划门槛。用户明确要求旧素材采用新配方时按原规则建立新资产版本/ID并更新引用，保留旧记录。未获生成授权仍停在原收费阶段之前。
