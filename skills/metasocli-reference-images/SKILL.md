---
name: metasocli-reference-images
description: 为 metasocli 按完整人物多视图、场景空间、道具结构材质和首帧模板准备参考图片，保留上游素材身份、分段分配和完整配方，供两个成品提示词入口共同调用。
---

# 参考图片准备

由 `metasocli`、`metasocli-video-prompts` 或 `metasocli-video-prompts-旁白` 在同一任务中调用；也可以针对已有故事和明确的图片请求单独调用。使用宿主原生生图或用户指定的现有图片，H3 只负责后续视频。所有模板、校验器和登记命令都来自本包，不读取旧 Skill、不调用 LibTV 补图。

## 素材边界与必读资料

上游负责完整阅读原文、决定素材 ID、类型、是否必需、逐段引用及图序。本技能只为这些已声明的素材组织图片配方和准备文件，不增删、合并、改名或重新分配素材，不改视频正文。只有原始剧本或提示词时，先交回对应上游整理，不能独立再做一套素材划分。`kind: narration` 不进入图片请求，也不作为图片依赖。

完整读取 [图片交接契约](references/handoff-contract.md) 和 [共用视觉规则](references/shared-visual-policy.md)，再按实际素材类型读取完整模板：

- 人物 `character`：[人物多视图板](references/character-board.md)。每个 assetId 锁定同一人物的一套造型；面部正侧特写、全身正侧背视图、名字及资料区。多人不能合并成一份人物身份资产。
- 场景 `scene`：[场景空间结构板](references/scene-board.md)。全景、细节、六类信息栏和平面/机位关系；通常不画人物。
- 道具 `prop`：[道具结构材质板](references/prop-board.md)。主体、多视图、细节、材质，以及原文明示的使用、状态或归属关系。
- 首帧 `first_frame`：[单幅首帧](references/first-frame.md)。只在上游明确需要时制作，锁定该段开场瞬间，不把设计板当成首帧。

模板规定的标题、资料、视图标签、材质和状态说明均需落实到完整生图提示词。`exactText: []` 只表示没有额外逐字文案要求，不表示禁止板内文字。不能用“按模板”“三视图”几句摘要代替完整布局和本故事的具体内容。

## 第一阶段：配方，先于导入与生图

上游按交接契约保存 `reference-image-request.json`，包含 `sourceFacts`、外观、连续性、依赖及 `requiredBySegments`；逐集处理，共享素材保持同一 ID。读取当前故事的 `metasocli.yaml` 与 `assets list --root <story>`，按精确 ID、已登记配方、实际文件及哈希判断。已有故事缺失的文件先恢复；不能仅凭文件名相近复用。

1. 已登记且 `ready` 的准确素材返回 `reused`，不重新编写或套模板覆盖原配方。用户明确提供的图片先用其准确 ID 声明配方并以 `--provenance user` 登记，再按已验证文件复用。
2. 缺失且必需的素材返回 `planned`：本技能根据完整类型模板、上游事实和指定依赖，组织一份完整生图提示词，保存原样文本及规范化 SHA-256。普通未指定外观明确为生成设定，不冒充原文事实或编造伤痕、测量数据和归属。
3. 缺失且可选的素材返回 `skipped_optional`。身份不明、文件变化或与已有配方冲突的返回 `blocked`，写明受影响素材和段落，继续独立项。已有 assetId 的配方不能原地更换；需要修订时由上游依据用户要求建立新 ID 并显式更新引用。

保存 `reference-image-recipe.json`，一项对应一个请求，依赖先于被依赖项。将 `planned` 的完整提示词原样写入 CLI 草稿 `recipes[].prompt`；精确文字和依赖也原样映射。`recipeSha256` 是提示词哈希，CLI 的 `recipeHash` 是整个配方对象哈希，两者不能混用。两份记录和草稿均放在本故事 `.metasocli/drafts/<本次UUID>/`，使用新目录保留旧记录。

本包提供仅使用标准库的 Python 3.10+ 校验器。优先用宿主提供的 Python，或已验证的本机 Python；所有路径以本技能目录解析：

```text
python -B scripts/validate_handoff.py request <request.json> --draft <draft.json>
python -B scripts/validate_handoff.py recipe <recipe.json> --request <request.json> --draft <draft.json>
```

第一条核对素材与本集的实际引用/依赖，第二条还核对传入 CLI 的完整配方，防止中间摘要、改名或漏绑定。CLI 随后执行 `import --root <story> --draft <draft.json>`。若宿主没有 Python，按同一契约核对并明确说明未运行确定性校验，不因此增加新的批准环节。校验通过不代替对原文语义的完整阅读。

## 第二阶段：原样生图与登记

导入后重新读取状态；仅对仍缺失的 `planned` 必需项调用宿主原生生图。读取当前可用的 `imagegen` Skill，**一份独立素材一次调用**，把已保存的完整提示词原样交给工具，仅允许 BOM/换行规范化，不能再做缩写或第二次优化。依赖图片先准备，声明其身份、风格或布局角色并传入真实文件；示例图不提供本故事的人名、服装或剧情。

保存并展示首次返回图片。用户判断是否满意；本流程不进行额外视觉检查、OCR、评分、自动退图、自动重画或逐图确认。工具使用规则仍适用；这条限定图片返回后的审美复核与重画。原生调用失败时先恢复已有输出和登记；确实没有文件则标记失败，报告缺图并继续独立项，不自动再调用生图或切换到旧平台。

生成图片以新 UUID 保存至当前故事 `.metasocli/drafts/assets/<operationId>/<portable-name>.png`（也可为实际 JPEG/WebP）。不覆盖已有文件，不把工具缓存当作最终项目文件。按契约保存 `reference-image-result.json`；另保存实际调用提示词、参考角色/顺序、文件格式/尺寸和哈希等执行事实，不写视觉合格凭证。

```text
python -B scripts/validate_handoff.py result <result.json> --request <request.json> --recipe <recipe.json> --project-root <story>
node <package-root>/dist/cli/main.js assets register --root <story> --id <asset-id> --file <staged-image> --provenance imagegen --expected-sha256 <contentSha256>
node <package-root>/dist/cli/main.js assets list --root <story>
```

登记只通过本包 CLI，由它独立复制、验证并更新状态，不直接编辑 `metasocli.yaml` 或伪造 ready。PNG/JPEG/WebP 单图最多 30 MiB，宽高 256–5760、宽高比 0.4–2.5；以实际文件为准，不以提示词中的“4K”认定像素尺寸。工具未提供可验证模型证据时不承诺确切生图型号；`requireExactModel: true` 会在调用前报告无法核实。

大素材可按原有 `assets register --url <public-https-url>` 登记，CLI 下载核验并在提交前复核；不自动上传云存储。图片完成后返回上游继续 H3 计划和旁白音频处理。本技能不调用视频生成，两个成品提示词入口在未获视频生成授权时仍停在本地计划。
