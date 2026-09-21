# Handoff contract

Read this file for every run. It is the image handoff between `metasocli-prompt-engine`, either `metasocli-video-prompts` entry, and `metasocli-reference-images`. All three use the same contract; finished video text is not an image-generation recipe. These JSON records live inside the current story and do not replace `metasocli.yaml`.

## Request

UTF-8 JSON, maximum 4 MiB:

```json
{
  "schemaVersion": "1.0.0",
  "episodeId": "episode-06",
  "modelPreference": null,
  "requireExactModel": false,
  "assets": [
    {
      "assetId": "father-main-look",
      "version": "v1",
      "order": 1,
      "kind": "character",
      "name": "父亲主要造型人物参考图",
      "required": true,
      "requiredBySegments": ["s01", "s03"],
      "visualDescription": "52岁中国男性；写明上游已经锁定的五官、发型、体型、固定服装和鞋子。",
      "sourceFacts": ["只有剧本或用户材料已经确定的事实"],
      "continuityRequirements": ["所有使用段保持同一脸部、体型和服装"],
      "exclude": [],
      "dependencyAssetIds": [],
      "exactText": []
    }
  ]
}
```

Rules:

- `episodeId`, `assetId` and every segment/dependency ID match `^[a-z0-9][a-z0-9_-]*$`, are at most 80 characters and are not Windows device names. Do not copy old slash-separated IDs.
- `version` is a non-empty local handoff label of at most 100 characters. Core does not use this field to replace a recipe: a changed visual recipe requires a new asset ID and an explicit upstream binding change, preserving the old record.
- `order` is a unique positive integer and preserves the upstream story/first-use order.
- `kind` is exactly `character`, `scene`, `prop`, or `first_frame`.
- `requiredBySegments` contains exactly the current episode's segments using this image, directly or through image dependencies. Such assets are required. An unused optional image has an empty list and is skipped. Include dependencies in the request before their dependants. Do not add every character to every segment merely because they occur somewhere in the story.
- `visualDescription` contains the complete asset-local appearance and state. It must not contain placeholders such as “同上” or “见前文”.
- `sourceFacts` distinguishes locked story facts from generation styling.
- `continuityRequirements` states what must remain stable across all linked segments.
- `exclude` carries explicit user exclusions or concrete story-specific limits, not automatically appended creative prohibition lists. Describe the requested appearance and effect positively.
- `dependencyAssetIds` refers only to earlier assets in the same request and contains no self-reference or cycles.
- `exactText` contains only content the user explicitly requests verbatim. An empty list means no additional verbatim requirement, not a text ban. Ordinary titles, view labels, information fields, and material/state notes are organized naturally from the original templates and supplied facts. Do not invent measurements or story evidence.
- `modelPreference` is an informational preference. A null preference means use the available default image generator without naming a model. The current contract has no trusted exact-model evidence source, so `requireExactModel: true` fails validation with `EXACT_MODEL_UNVERIFIABLE` before recipe planning or image generation.

The upstream stage owns the values above. This Skill may reject an invalid or underspecified item, but may not rewrite its identity or allocation.

## Recipe plan

The builder creates this JSON before making any image call. It contains one item for every request item in the same order:

```json
{
  "schemaVersion": "1.0.0",
  "episodeId": "episode-06",
  "assets": [
    {
      "assetId": "father-main-look",
      "kind": "character",
      "status": "planned",
      "generationPrompt": "将被实际使用的完整生图提示词",
      "recipeSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "existingRelativePath": null,
      "contentSha256": null,
      "reason": null
    }
  ]
}
```

Recipe statuses:

- `planned`: required and missing; canonical prompt and matching recipe hash are present.
- `reused`: an exact ready file was verified; existing path and content hash are present.
- `skipped_optional`: optional and missing; no recipe or artifact is claimed.
- `blocked`: stale, conflicting, unsafe, duplicated, or missing a required fact; `reason` is present.

The orchestrator maps `planned` items into the metasocli import draft as described below and calls the package CLI `import`. Core persists the complete recipe with `media: null`; this does not claim an image exists. Never write `metasocli.yaml` or an asset index directly.

## Result

UTF-8 JSON, one result for every request item in the same order:

```json
{
  "schemaVersion": "1.0.0",
  "episodeId": "episode-06",
  "assets": [
    {
      "assetId": "father-main-look",
      "kind": "character",
      "status": "generated",
      "operationId": "00000000-0000-4000-8000-000000000001",
      "stagedRelativePath": ".metasocli/drafts/assets/00000000-0000-4000-8000-000000000001/father-main.png",
      "existingRelativePath": null,
      "contentSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "generationPrompt": "实际使用的完整生图提示词",
      "recipeSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "generationMode": "built_in",
      "reportedModel": null,
      "reason": null
    }
  ]
}
```

Allowed statuses and invariants:

- `generated`: required asset; UUID, staged path, content hash, complete prompt, prompt hash, and actual mode are present. No visual receipt is required or produced.
- `reused`: exact verified existing path and content hash are present; no staging operation is created.
- `skipped_optional`: request was optional and missing; all paths and hashes are null, mode is `not_run`.
- `blocked`: a precondition, conflict, stale asset, model requirement, or missing fact prevented safe execution; `reason` is non-empty.
- `failed`: an authorized generation attempt returned no usable file or failed file/integrity validation; `reason` is non-empty. Visual observations alone do not make a returned image `failed`.

`generationMode` is `built_in` or `not_run`. There is no legacy image CLI fallback. `reportedModel` is null unless the actual tool reports a model name, and remains informational even when it equals `modelPreference`; it is never proof of exact model execution. `recipeSha256` is the lowercase SHA-256 of the UTF-8 generation prompt after BOM removal and CRLF/CR normalization to LF; its trailing newline is preserved.

For `generated`, the result prompt and recipe hash must equal the corresponding `planned` recipe. For `reused` and `skipped_optional`, the result must preserve the recipe-plan decision. A `planned` recipe may end as `blocked` or `failed`, but it may not silently use a different prompt.

The result is an execution handoff, not the project truth source. Only the downstream orchestrator may call the project's registration operation and update canonical state.

For every `generated` result, save and display the first returned image, then hand it off directly. The full actual prompt must include the type template's concrete layout and information content, not an orchestrator/script summary. `contentSha256` and `recipeSha256` bind the image and planned prompt; reference roles, output dimensions and actual call metadata can be saved separately as execution facts, never a quality certificate. Ordinary titles, profiles, labels, and explanatory notes are included whether `exactText` is empty or not.

No new `inspectionRelativePath`, `inspectionSha256`, `inspection`, QA receipt, visual-observation file, or `qaEvidence` is produced. Do not perform automatic output inspection, text recognition, scoring, pass/fail assessment, regeneration, or per-image confirmation. The user chooses satisfactory images and requests any later edits explicitly. `generated`/registered/ready mean produced and technically usable, not visually approved.

No legacy handoff or QA records are imported. Do not clear historical problems, fabricate passed=true, write empty receipts, or add a replacement quality proof. Image format, contained paths, asset identity, actual bytes, image/recipe hashes and formal registration remain mandatory. The handoff validator checks identity, recipe correspondence, contained paths and file hashes; the package `assets register` command additionally checks supported byte format, dimensions and size.

## metasocli 草稿映射与调用顺序

1. 上游确定原文分段及每段 `references`，记录每个素材的原文事实、外观、连续性和依赖。人物按一个人的一套造型拆分，换装/状态变化按用户原文分别锁定；明确引用优先，不把台词中只提及的对象自动当出镜素材。不要重写成品视频正文来配合图片模板。
2. 图片 Skill 先输出 recipe plan。每个 `planned` 项按以下对应关系写入本项目 [ImportDraft](../../../docs/INPUT_FORMAT.md) 的 `recipes`：

| CLI recipes 字段 | 图片交接来源 |
| --- | --- |
| `assetId`、`kind` | 请求的同名字段，原样保持 |
| `prompt` | recipe plan 的完整 `generationPrompt`，只规范 BOM/换行 |
| `exactText` | 请求中的 `exactText`，原顺序 |
| `dependencies` | 请求中的 `dependencyAssetIds`，原顺序 |

`sourceFacts`、`requiredBySegments`、`version` 等交接字段保留在请求 JSON，不塞进 CLI 严格配方结构。单份配方 `prompt` 最多 32000 个 UTF-16 单元。`recipeSha256` 只对提示词计算；CLI 的 `recipeHash` 对完整配方对象计算，不应相等比较。

3. `reused` 素材已在当前故事登记，可以不重复放入草稿 recipes；若放入，必须使用原配方，不能按新模板改写。`skipped_optional` 不生成，也不新增到草稿。`blocked` 先解决对应依赖，不擅自删掉段落引用来绕过阻塞。只针对当前集及其依赖生成请求；跨集共享资产使用同一 ID，并以项目状态复用。
4. `request ... --draft <draft.json>` 检查本集段 ID、图片引用/依赖、是否必需及 requiredBySegments 的一致性。`recipe ... --request ... --draft ...` 还检查写进 CLI 的配方未被缩写、改序或改名。未指定 `--draft` 时仅做图片交接内部检查；实际导入前要带该参数。旁白配方不进入图片交接，检查器不改旁白字段。
5. 调用 `node <package-root>/dist/cli/main.js import --root <story> --draft <draft.json>`。用清单和 `assets list` 确认实际落盘的配方与状态，再进入图片生成。既有尚未生成的简化配方也不能由图片 Skill 偷偷改写；向上游报告配方冲突，按用户授权修订素材 ID。
6. 每个必要素材仅使用其已保存的完整提示词和明确依赖文件调用原生生图。保存首次图片和真实执行记录，运行 `result ... --project-root <story>` 后，通过本项目 `assets register --provenance imagegen --expected-sha256 ...` 登记，再读回状态。

文件记录放在 `.metasocli/drafts/<本次UUID>/reference-image-{request,recipe,result}.json`；各次图片文件使用 `.metasocli/drafts/assets/<operationId>/`。上下游之间只有文件交接和本包 CLI，不调用旧程序、旧 Skill 或远端画布。

已有图片由用户指定时，使用准确素材 ID，以 `--provenance user` 正式登记并验证后复用；不要为了套设计板模板重生成用户图片。若没有 Python 3.10+，可以按契约逐项核对并说明未运行校验器，CLI 的导入和媒体检查仍需执行。确定性检查不判断人物是否真的应该出镜，也不证明图中文字或外观正确。
