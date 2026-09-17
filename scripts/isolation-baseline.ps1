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
  $before = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json
  $oldLines = @('git=' + ($before.gitStatus -join "`n"), 'commands=' + ($before.commands -join "`n")) + @($before.files | ForEach-Object { $_.path + '=' + $_.sha256 } | Sort-Object)
  $newLines = @('git=' + ($gitState -join "`n"), 'commands=' + ($commands -join "`n")) + @($files | ForEach-Object { $_.path + '=' + $_.sha256 } | Sort-Object)
  $difference = Compare-Object -ReferenceObject $oldLines -DifferenceObject $newLines -CaseSensitive
  $report = [ordered]@{ checkedAtUtc=[DateTime]::UtcNow.ToString('o'); fileCount=$files.Count; gitUnchanged=(($before.gitStatus -join "`n") -ceq ($gitState -join "`n")); commandPathsUnchanged=(($before.commands -join "`n") -ceq ($commands -join "`n")); differences=@($difference) }
  [IO.File]::WriteAllText((Join-Path $workspace '.work/isolation-check.json'),($report | ConvertTo-Json -Depth 8))
  if ($difference) { $difference | Format-Table; throw 'Isolation baseline changed; see .work/isolation-check.json. Do not overwrite shared configuration.' }
  Write-Output "Verified: $($files.Count) file hashes, old Git state and global command paths unchanged."
}
