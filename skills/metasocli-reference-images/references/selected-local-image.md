# 已选本机图片沿用原 ID

`metasoclitk`、`metasocli-video-prompts`、`metasocli-video-prompts-旁白` 在全文导入、配方准备、生图和图库导出前，先判断是否只换图片。用户说“把薇拉的资产图换成这张”，默认让该故事中原资产 ID 的所有引用今后采用这张图，沿用已有配方。人物（character）、场景（scene）和道具（prop）均按此办理。

目标取用户明确指定的原资产 ID。仅给名称时，在当前故事的实际引用中定位；目标唯一就执行。若多个活跃造型确实无法区分，或名称无法对应到已声明资产，先保持零写入，只问一次具体要换哪个 ID。选图的文件名、登记时间和它所属的另一个 ID 都不能作为目标选择依据。

例如 11 段都引用 `vera-red`，用户选的是 `vera-black` 已登记的正式图片。以 `vera-red` 为目标 ID，以 `vera-black` 的文件为输入；成功后两个 ID 可以有相同的图片哈希。原句仍写“红发”、选图是黑棕发，也直接完成纯换图。提示词、配方、图序和旁白归属沿用原文，无需遍历各集查找外观差异。

## 执行一次本地登记

输入为已核对的故事根 `$storyRoot`、目标 `$originalAssetId`、本机文件 `$selectedFile`、本安装根 `$installRoot` 和 Node 可执行文件 `$nodeExe`。来源 `$provenance` 依据选图本身：用户提供的图片填 `user`，有对应生成来源证据才填 `imagegen`。旧配方只描述该 ID 的原生成设定。已有可信选图回执时将其 SHA-256 赋给 `$trustedSelectedHash`，否则该变量设为 `$null`。在同一次宿主调用中执行整个代码块，按独立参数传入文件和 ID：

```powershell
$ErrorActionPreference = 'Stop'
$cli = Join-Path $installRoot 'dist/cli/main.js'
if ([string]::IsNullOrWhiteSpace($trustedSelectedHash)) {
    $expected = (Get-FileHash -LiteralPath $selectedFile -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
} else {
    $expected = $trustedSelectedHash.ToLowerInvariant()
}
$registerArgs = @(
    $cli, 'assets', 'register', '--root', $storyRoot, '--id', $originalAssetId,
    '--file', $selectedFile, '--expected-sha256', $expected, '--provenance', $provenance
)
$raw = & $nodeExe @registerArgs
$code = $LASTEXITCODE
if ($code -ne 0) {
    $raw | Write-Output
    throw ("素材登记退出码 " + $code)
}
$receipt = ($raw -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
if ($receipt -isnot [pscustomobject] -or $receipt.assetId -cne $originalAssetId -or $receipt.sha256 -cne $expected) {
    throw '登记回执与原资产 ID 或选图 SHA-256 不符，请保留现场核对。'
}
$receipt | Select-Object assetId,sha256,recipeHash | ConvertTo-Json -Compress
```

成功后只交付原资产 ID 和新图 SHA-256，到此结束。影响集段数只在已有准确统计时附上。登记失败、回执无法解析或 ID/哈希不符时，报告实际错误并停止；禁止自动重试或改绑其他 ID。纯换图无需逐集导入、重做计划或更新图库、预览和 ZIP。

## 其他明确请求

- 用户要求只改部分段（如只改某个镜头），或让两版分别供不同镜头使用时，沿用新 ID、定向引用的流程。明确要求改提示词或改配方时，按选定范围修订并导入。
- 明确要求作图、重画或导出图库时，执行所要求的对应流程。从图库选图本身只表示选中了本机文件。
- 首帧和旁白音频沿用各自的绑定规则。认领历史未知图片请求的指定结果，走 `images attach-result` 及正式恢复入口，保留未知占位。
- 同时明确要求换图和生成指定段视频时，先核对登记回执，再按覆盖新版素材和选段的视频授权执行；历史已受理的视频按原任务号恢复。
