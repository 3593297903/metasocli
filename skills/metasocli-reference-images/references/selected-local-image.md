# 已选本机图片沿用原 ID

仅 metasoclitk、metasocli-video-prompts 和 metasocli-video-prompts-旁白 在分析新图片配方之前使用此路由。先核对真实故事根、用户选中的实际本机文件、其来源、当前引用的唯一 ID，以及是否希望所有引用采用新版。查故事素材和引用来区分同名版本，仍有歧义时只询问有分歧的那一项。

用户希望保留已有 character、scene 或 prop 的生成配方，所有引用以后都使用选中的图片时，只调用一次现有登记命令。已有新文件哈希或可信回执时使用该哈希，否则在同一次宿主调用内读取新文件、计算 SHA-256、登记。以下参数须按独立参数传入：

```powershell
$newHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $selectedFile -ErrorAction Stop).Hash.ToLowerInvariant()
& node $cli assets register --root $story --id $assetId --file $selectedFile --expected-sha256 $newHash --provenance $provenance
if ($LASTEXITCODE -ne 0) { throw '素材登记失败，请检查原始错误。' }
```

来源由实际文件证据决定：用户文件为 user，已生成的图片有生成来源证据时用 imagegen。交付登记返回的 assetId 与 sha256。旧配方描述的是该 ID 原有的生成设定。纯换图到此结束；只有另有明确授权才按更新后的清单执行指定视频段。影响范围根据实际引用统计，需要图库导出时按单独要求执行。

只改部分段、需要两版并存或以后重画也要改配方，走原新 ID、定向引用、修订导入流程。实际要求生图用原准备/生成流程。认领历史未知请求的指定结果用 images attach-result 及正式恢复入口。一次本地登记保留历史未知占位和已接受视频任务。
