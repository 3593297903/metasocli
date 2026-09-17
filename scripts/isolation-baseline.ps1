param([ValidateSet('capture','verify')][string]$Mode = 'verify')
$ErrorActionPreference = 'Stop'
$env:GIT_OPTIONAL_LOCKS = '0'
$workspace = Split-Path -Parent $PSScriptRoot
$output = Join-Path $workspace '.work/isolation-baseline.json'
$oldRoot = 'E:\libcli'
$snapshot = Join-Path $oldRoot '.story2libtv-work/video-prompt-entry-0.2.22-20260916/source'
$globalRoot = Join-Path $env:APPDATA 'npm'
$skillNames = @('story-to-libtv','video-prompt-to-libtv','seedance-segment-prompt-engine','story-reference-image-builder')
$paths = [System.Collections.Generic.List[string]]::new()
$commands = @(Get-Command story2libtv -All | ForEach-Object { $_.Source })
foreach ($item in $commands) { $paths.Add($item) }
foreach ($item in @((Join-Path $globalRoot 'node_modules/story-to-libtv/package.json'),(Join-Path $snapshot 'package.json'),(Join-Path $env:USERPROFILE '.codex/config.toml'))) {
  if (Test-Path -LiteralPath $item -PathType Leaf) { $paths.Add($item) }
}
foreach ($base in @('.codex/skills','.agents/skills')) {
  foreach ($skill in $skillNames) {
    $dir = Join-Path $env:USERPROFILE "$base/$skill"
    if (Test-Path -LiteralPath $dir) { Get-ChildItem -LiteralPath $dir -Recurse -File | ForEach-Object { $paths.Add($_.FullName) } }
  }
}
foreach ($dir in @((Join-Path $env:USERPROFILE '.story2libtv-runtime'),(Join-Path $env:USERPROFILE '.libtv'))) {
  if (Test-Path -LiteralPath $dir) { Get-ChildItem -LiteralPath $dir -Recurse -File | ForEach-Object { $paths.Add($_.FullName) } }
}
$gitState = @(git -c safe.directory=E:/libcli -C $oldRoot status --porcelain=v1)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect old Git state' }
foreach ($line in $gitState) {
  $relative = $line.Substring(3)
  $item = Join-Path $oldRoot $relative
  if (Test-Path -LiteralPath $item -PathType Leaf) { $paths.Add($item) }
}
$files = @($paths | Sort-Object -Unique | ForEach-Object { @{ path=$_; sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash } })
$state = @{ gitStatus=$gitState; commands=$commands; files=$files }
$json = $state | ConvertTo-Json -Depth 8
if ($Mode -eq 'capture') {
  New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
  [IO.File]::WriteAllText($output,$json)
  Write-Output "Captured $($files.Count) file hashes and old Git/command state."
} else {
  if (-not (Test-Path -LiteralPath $output)) { throw 'Capture baseline first' }
  if ((Get-Content -LiteralPath $output -Raw) -ne $json) { throw 'Isolation baseline changed; inspect before proceeding' }
  Write-Output "Verified: $($files.Count) file hashes, old Git state and global command paths unchanged."
}
