# 内容草稿与素材契约

两个入口使用相同的原文追溯、素材和请求计划模块，`kind` 明确区分行为。

简单单段导入可用 README 命令。多段或带参考图时使用 `import --root <story> --draft <draft.json>`。`source` 相对草稿文件目录解析，其他写入都只进入 `--root`。

```json
{
  "episodeId": "ep-1",
  "kind": "video-prompts",
  "source": "prompts.md",
  "segments": [
    {
      "id": "s1", "start": 0, "end": 20, "duration": 6,
      "references": [{ "assetId": "hero", "role": "reference_image" }],
      "parameters": { "resolution": "768P", "ratio": "9:16", "contextIr": false, "watermark": false }
    }
  ],
  "recipes": [
    { "assetId": "hero", "kind": "character", "prompt": "完整的人物造型图片配方", "exactText": [], "dependencies": [] }
  ]
}
```

示例 `end: 20` 只是结构示意，实际值由来源计算。源码包的 [多图示例](../examples/references.draft.json) 可直接导入；先准备其图片，再计划。

- 来源只接受严格 UTF-8；移除最多一个开头 BOM，将 CRLF/CR 规范为 LF。其他空白、标点和尾部换行保持。原始字节及规范文本分别保存并记录 SHA-256。
- `start/end` 为规范文本的 JavaScript UTF-16 索引，半开区间 `[start,end)`；相邻段范围连续，禁止遗漏、重排、重叠、重复 ID 和拆开 Unicode 代理对。保存规范源后可用 `text.slice(start,end)`核对。完整覆盖确保所有台词与说话人保留，CLI 不自动估计台词时长。
- `video-prompts` 的正文必须与来源范围逐字一致，通常省略 `prompt` 让程序取原文。`script` 可写 `prompt` 添加视觉说明，但必须包含完整原文范围。未给 `prompt` 时直接使用来源原文。初版不内置 LLM 自动分镜。
- 所有段时长必须为 4–15 秒整数。提示词按 H3 契约最多 7000 字符，超限明确拒绝，不截断。计划记录原始提示词哈希、渲染后哈希及完整渲染文本。
- ID 最长 80 字符，仅小写字母、数字、`_`、`-`，避免 Windows 设备名。旧层级 assetId 必须显式转为新 ID 并同步引用，CLI 不猜测映射。
- `references` 是有序数组，ID 不可重复，最多 9 个。`role` 仅 `reference_image/first_frame`，首帧独占。人物/场景/道具用 reference_image；首帧配方 `kind` 为 first_frame。未登记图片直接阻止依赖段计划。
- `{{ref:hero}}` 按显式图序渲染为“参考图1”等自然语言描述；首帧渲染为“首帧图片”。这是本地明确展示的文本适配，不声称是供应商专用机器标记。普通“图1”、姓名和正文不替换。`{{Node ...}}` 明确拒绝。
- 配方保存完整 `prompt`、`exactText`、有序 `dependencies` 与哈希。依赖需存在且无重复、无循环。同一 assetId 的配方发生变化需新 ID。重新登记文件产生新 revision，旧计划失效；已提交任务仍可凭原 ID 恢复。
- 重复导入相同内容无变化；同一集内容更新需要 `--replace`。追加内容用新 episodeId。历史计划与任务保留。

原文件和图片可以从用户明确指定的旧内容路径单向读取复制。新故事根必须为空且独立，不导入旧清单、账户凭据、绑定、锁或任务；本版没有旧完整项目自动转换器。
