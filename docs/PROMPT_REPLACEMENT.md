# 指定段提示词一次替换

三个入口 `metasoclitk`、`metasocli-video-prompts`、`metasocli-video-prompts-旁白` 共用本路径。用户说“把第16集第一段换成这份完整新稿，其他不变”，且故事、原集 ID、原段 ID 和完整新稿已经确定时，只执行一次 `prompts replace`，核对回执后结束。先于全文导入、图片授权/模板/工作流、视频计划等文档读取判断本路径。不要让继承的 Skill 再执行一遍。

尚需创作时先完成用户要求的改写，定稿后调用本入口。程序不缩写、翻译、改对白、改美术描述或追加去噪词。没有明确目标时只澄清该目标，不按文件名猜 ID。仅支持现有 `kind: video-prompts`；剧本保持原流程。

## 本地命令

```text
node <INSTALL_ROOT>/dist/cli/main.js prompts replace --root <story> --episode <existing-episode-id> --segment <existing-segment-id> --file <完整新稿.txt>
  [--expected-sha256 <输入原始字节SHA256>] [--expected-prompt-hash <旧段规范正文SHA256>] [--narration-cues <新旁白范围.json>]
```

无需 `--confirm`。不加载 Key、不访问网络或共享账本、不读图片/音频字节。选定文件有界且稳定读取，只有开头 BOM 和 CRLF/CR 换行规范化，空格、标点、台词和末尾换行全部保留。`expected-sha256` 对原始字节，`expected-prompt-hash` 对旧规范正文，不混用。有可信旧 hash 就传；没有则由同次调用内部捕获并检查目标快照，不另发获取 hash 命令。

以 Skill 正文向上两级确定安装根，验证包名为 metasocli。下面输入变量为 `$storyRoot`、`$episodeId`、`$segmentId`、`$selectedPromptFile`、`$installRoot`、`$nodeExe`；可选已知变量 `$expectedPromptHash`、`$narrationCueFile` 没有时设为 `$null`。文件已存在就直接用原文件；聊天中的定稿完整保存为 UTF-8 文件，可与以下整个块在同一次宿主调用中顺序完成。正文只作为文件数据，不拼进 shell 代码或命令行，不动态执行字符串。

```powershell
$ErrorActionPreference = 'Stop'
$cli = Join-Path $installRoot 'dist/cli/main.js'
$expected = (Get-FileHash -LiteralPath $selectedPromptFile -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
$replaceArgs = @(
    $cli, 'prompts', 'replace', '--root', $storyRoot,
    '--episode', $episodeId, '--segment', $segmentId,
    '--file', $selectedPromptFile, '--expected-sha256', $expected
)
if (-not [string]::IsNullOrWhiteSpace($expectedPromptHash)) {
    $replaceArgs += @('--expected-prompt-hash', $expectedPromptHash)
}
if (-not [string]::IsNullOrWhiteSpace($narrationCueFile)) {
    $replaceArgs += @('--narration-cues', $narrationCueFile)
}
$raw = & $nodeExe @replaceArgs
$code = $LASTEXITCODE
if ($code -ne 0) {
    $raw | Write-Output
    throw ("提示词替换退出码 " + $code)
}
$receipt = ($raw -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
if ($receipt -isnot [pscustomobject] -or $receipt.schemaVersion -ne 1 -or
    $receipt.episodeId -cne $episodeId -or $receipt.segmentId -cne $segmentId -or
    $receipt.inputSha256 -cne $expected -or $receipt.promptHash -cnotmatch '^[a-f0-9]{64}$' -or
    @('replaced', 'unchanged') -cnotcontains $receipt.state -or $receipt.changed -isnot [bool] -or
    $receipt.changed -ne ($receipt.state -ceq 'replaced')) {
    throw '提示词回执与集段、输入 SHA-256 或结果状态不符，请保留现场核对。'
}
$receipt | ConvertTo-Json -Depth 8 -Compress
```

成功只交付集段、新 hash 和是否变化。回执含前后 revision/source、实际 inputSha256、旁白处理方式、紧凑计时和实际变化的依据记录路径，不含全文或全部资产。命令失败、非 JSON 或回执字段不符则报告实际错误，禁止盲目重试。不要随后调用 import、assets list、doctor、plan、逐图哈希、图库/ZIP/全剧 TXT 导出或一串复查脚本。

## 旁白与保留范围

保留原集段 ID、顺序、数量、kind，所有资产配方/图片/音频、引用角色与顺序、实际时长及小数目标、参数和其他段正文。只更新选中段 prompt/hash、所在集 source、目标 end 和后续段 start/end、必要 cues；真实变化 revision 只加 1。共享清单 `metasocli.yaml` 仍整文件原子保存，不声称仅修改几个物理字节。

没有旁白时保持原来的 null/undefined，不加载默认 MP3。已绑定旁白的完整正文不变则保留 cues；正文变化时，完全相同的旧旁白文字在新稿中各只有唯一匹配且顺序不变才自动重定位。重复、缺失、乱序或重叠返回 `NARRATION_REMAP_REQUIRED`，说明 cue 序号与原因。声音 assetId 永远不变。

旁白文本确实变化时，在准备新稿时完成语义判断，一并给出显式 JSON，不额外运行预检命令。确有语义歧义才询问具体一句归属。契约为 `{"schemaVersion":1,"promptHash":"新规范正文SHA256","cues":[{"start":0,"end":4,"text":"完整旁白"}]}`。索引用程序按 UTF-16 计算；text 必须逐字匹配切片，非空、有序、不重叠、不切开代理对，禁止 assetId 等额外字段。无原旁白不得借此新建绑定。渲染验证使用 Unicode 码点的 7000 字限制，包括自动旁白技术说明；技术说明不写回原文。

## 保存、恢复及其他请求

校验失败零业务写入。当前集 raw/text 快照哈希、规范关系、连续覆盖和逐段正文/hash 必须完整；损坏时即使新稿相同也不得返回 unchanged。清单中的绑定/角色仍校验，但素材文件缺失不阻止纯文字编辑，正式视频提交仍按原完整校验执行。

输入原字节及新整集源文用内容寻址快照保存，旧快照不覆盖。`.metasocli/prompt-replacements/<hash>.json` 仅是 prepared 变更依据，不能单凭它证明已生效；清单是唯一提交点。清单前中断可留下未引用快照，原故事仍完整；清单后输出前中断，再运行同一命令返回 unchanged，不再增加 revision。相同正文和旁白绑定（包括只差 BOM/CRLF）不写快照/记录；回执 inputSha256 仍反映本次实际输入。已达到完整结果时允许携带旧 expected-prompt-hash 幂等重放。

只用本故事短写锁，沿用有界等待、损坏/所有权保护。目标在同次调用中被别人改过且不是本次完整期望结果时返回 `PROMPT_REPLACEMENT_STALE`，保留现状；其他段、集或资产的并发更新从锁内最新清单合并，绝不用旧整份清单覆盖。快照内容损坏报错保留，不自动清理或回滚。

同 ID 纯换图仍走[选定图片入口](../skills/metasocli-reference-images/references/selected-local-image.md)。用户同时要求换图时分别调用对应入口；本函数不能改图或引用。时长、拆合段、引用、更换配方和新增旁白音频超出纯文本范围，沿原相应流程处理。

旧未提交计划因 revision 变化失效，按最新正式 Story 重新冻结；本命令不建计划、不改旧 Plan/Batch/Job/Receipt。已受理任务仍按原 operationId/taskId 查询下载，不能把新稿套进旧请求。辅助 current-*.json、导出 TXT 不是 Core 真相，不可用它们覆盖新稿；只在用户另要求时刷新导出。

用户同时明确要求视频时，换稿回执后按原 [video execute](VIDEO_EXECUTE.md) 授权和范围冻结最新 Story，不重复询问同一目的地授权。只有换稿时到此结束，不生图、不视频、不整理图库。本功能离线可验，不代表真实供应商生成验收。
