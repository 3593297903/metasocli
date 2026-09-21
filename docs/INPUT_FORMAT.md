# 内容草稿与素材契约

两个入口使用相同的原文追溯、素材和请求计划模块，`kind` 明确区分行为。

当前业务草稿的 `parameters.contextIr` 明确写 true。默认新计划或显式 `--workflow h3-inline-ir` 均将实际视频请求设为 `context_ir_enabled:true`；历史清单省略该字段或存有 false 不会被原地改写，新计划的 workflow 和请求哈希记录实际覆盖值。生成使用计划，不直接把旧清单中的 false 交给 API。

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
      "parameters": { "resolution": "768P", "ratio": "9:16", "contextIr": true, "watermark": false }
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
- 草稿 `duration` 是原始目标秒数：可填有限正数且不超过 15，例如 `12.378`。导入时程序自动用 `Math.ceil` 得到 H3 的 4–15 秒整数请求时长，并仅在小数目标时保存 `targetDurationSeconds`；`12.378 → duration: 13, targetDurationSeconds: 12.378`，`6.666 → 7`，`6.963 → 7`。整数如 `12` 仍只保存 `duration: 12`，不补字段。正常向上取整不需要逐段确认，不改原文、不改旁白范围或音频媒体时长，也不会在生成后裁剪成片。无法解释的目标、`3`、非正数或超过 15 秒明确拒绝。提示词按 H3 契约最多 7000 字符，超限明确拒绝，不截断。计划记录原始提示词哈希、渲染后哈希及完整渲染文本；H3 请求体只包含实际整数 `duration`。
- ID 最长 80 字符，仅小写字母、数字、`_`、`-`，避免 Windows 设备名。旧层级 assetId 必须显式转为新 ID 并同步引用，CLI 不猜测映射。
- `references` 是有序数组，ID 不可重复，最多 9 个。`role` 仅 `reference_image/first_frame`，首帧独占。人物/场景/道具用 reference_image；首帧配方 `kind` 为 first_frame。未登记图片直接阻止依赖段计划。
- `{{ref:hero}}` 按显式图序渲染为“参考图1”等自然语言描述；首帧渲染为“首帧图片”。这是本地明确展示的文本适配，不声称是供应商专用机器标记。普通“图1”、姓名和正文不替换。`{{Node ...}}` 明确拒绝。
- 配方保存完整 `prompt`、`exactText`、有序 `dependencies` 与哈希。依赖需存在且无重复、无循环。同一 assetId 的配方发生变化需新 ID。重新登记文件产生新 revision，旧计划失效；已提交任务仍可凭原 ID 恢复。
- 重复导入相同内容无变化；同一集内容更新需要 `--replace`。追加内容用新 episodeId。历史计划与任务保留。

Skill 工作流在导入前使用独立的 [图片交接契约](../skills/metasocli-reference-images/references/handoff-contract.md)：上游记录素材原文事实和逐段分配，图片 Skill 依据完整类型模板生成配方，再原样映射到这里的 `recipes`。交接的 `sourceFacts`、`requiredBySegments` 等分析字段留在交接 JSON，不加入 CLI 严格结构；旁白也不进入图片请求。CLI 本身仍可接受用户已确定的配方，不负责读模板或做图片审美判断。

## 可选的统一旁白参考

`metasocli-video-prompts-旁白` 额外逐段判断旁白；原成品提示词入口不自动启用。`references` 仍只放图片、顺序不变，音频单独使用 `narration`。一段中多个镜头有旁白时共用一个音频，`cues` 标注具体旁白原文，不包括人物直接对白：

```json
{
  "episodeId": "ep-voice", "kind": "video-prompts", "source": "voice.txt",
  "segments": [{
    "id": "s1", "start": 0, "end": 18, "duration": 6,
    "narration": { "assetId": "narrator-default", "cues": [{ "start": 3, "end": 7 }] }
  }],
  "recipes": [{
    "assetId": "narrator-default", "kind": "narration",
    "prompt": "用户指定的画外旁白声线参考，不复述录音台词。", "exactText": [], "dependencies": []
  }]
}
```

以上示例对应无末尾换行的来源 `旁白：天亮了。角色对白：我们出发吧！`；实际使用必须由程序计算全文和片段范围。`narration.cues` 使用**该段原始 prompt 内**的 UTF-16 半开区间，与覆盖全文的 `segments.start/end` 不同。范围须非空、有序、不重叠，不可拆开 Unicode 代理对。判断为无旁白时写 `narration: null`；普通入口可完全省略该字段，旧清单和旧图文计划不补默认字段。

语义判断由 Skill 完整阅读镜头、说话人和口型后进行；CLI 校验范围与文件，不用“旁白”关键词猜测归属。语义不清时不能假装已判为无旁白。新 Skill 将判断依据保存为本地 `narration-review.json`。

`kind: narration` 声明的是用户已有录音，不调用生图或 TTS，无图片依赖。`assets register` 同时支持此类 MP3、PCM/浮点 WAV，2–15 秒、最多 15 MiB、单/双声道；检查完整帧/容器结构和元数据，不进行声纹识别或完整音频解码。`--expected-sha256` 可锁定用户选定的音频，变化时拒绝登记。文件独立复制、哈希、缺失恢复、URL 提交前复核与图片使用同一状态机制。

当前每段支持一个旁白音频，与最多 9 张普通参考图组合；不与首帧混用。计划中的音频项为 `role: reference_audio`，包含哈希、时长与本地来源身份，实际原生请求添加 `type: audio_url`、`audio_url: { url }`。文件可用 Data URL 或已校验的公网 HTTPS URL，不自动上传到第三方网盘。

原提示词逐字保留；请求渲染仅在末尾另附旁白规则和圈选范围对应的原句，清楚区分旁白与角色对白。不得照搬参考录音台词，不把整条录音当成后期铺轨，不让旁白驱动人物口型。完整渲染文本仍须满足 7000 字符限制。音频或旁白选择变化会使旧计划失效；已提交任务恢复继续使用原 taskId，不重生成。

原文件和图片可以从用户明确指定的旧内容路径单向读取复制。新故事根必须为空且独立，不导入旧清单、账户凭据、绑定、锁或任务；本版没有旧完整项目自动转换器。
