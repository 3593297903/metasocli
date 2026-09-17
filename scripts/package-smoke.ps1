$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe).Source
$npmPath = Join-Path (Split-Path -Parent $nodePath) 'node_modules/npm/bin/npm-cli.js'
if (-not (Test-Path -LiteralPath $npmPath)) { throw 'Cannot locate npm next to the selected Node runtime' }
$registry = (& $nodePath $npmPath config get registry | Select-Object -Last 1).Trim()
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('metasocli-package-' + [guid]::NewGuid().ToString('N'))
$sourceRoot = Join-Path $testRoot 'source'
$prefix = Join-Path $testRoot 'prefix'
$cache = Join-Path $projectRoot '.npm-cache'
$originalLocation = Get-Location
$savedEnvironment = @{}
foreach ($name in @('PATH','USERPROFILE','HOME','APPDATA','METASO_API_KEY')) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
function Invoke-Npm([string[]]$Arguments) {
  & $nodePath $npmPath @Arguments --registry $registry
  if ($LASTEXITCODE -ne 0) { throw "npm failed: $($Arguments[0])" }
}
try {
  New-Item -ItemType Directory -Path $sourceRoot,$prefix,(Join-Path $testRoot 'home'),(Join-Path $testRoot 'appdata') | Out-Null
  foreach ($dir in @('src','tests','skills','docs','examples','scripts')) { Copy-Item -LiteralPath (Join-Path $projectRoot $dir) -Destination $sourceRoot -Recurse }
  foreach ($file in @('package.json','package-lock.json','tsconfig.json','vitest.config.mjs','README.md','.npmrc')) { Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $sourceRoot }
  $env:PATH = (Split-Path -Parent $nodePath) + ';' + (Join-Path $env:SystemRoot 'System32')
  $env:USERPROFILE = Join-Path $testRoot 'home'
  $env:HOME = $env:USERPROFILE
  $env:APPDATA = Join-Path $testRoot 'appdata'
  [Environment]::SetEnvironmentVariable('METASO_API_KEY',$null,'Process')
  if (Get-Command story2libtv,libtv -ErrorAction SilentlyContinue) { throw 'Old CLI unexpectedly visible in isolated PATH' }
  Set-Location -LiteralPath $sourceRoot
  Invoke-Npm @('ci','--offline','--ignore-scripts','--cache',$cache)
  Invoke-Npm @('run','check')
  $packText = & $nodePath $npmPath pack --ignore-scripts --json --cache $cache
  if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }
  $pack = ($packText -join "`n" | ConvertFrom-Json)[0]
  $tarball = Join-Path $sourceRoot $pack.filename
  if ($pack.files.path | Where-Object { $_ -match '(^|/)(\.work|node_modules|\.metasocli|\.env)(/|$)' }) { throw 'Private/development files included in package' }
  $skillFiles = @($pack.files.path | Where-Object { $_ -match '^skills/[^/]+/SKILL.md$' })
  if ($skillFiles.Count -ne 4) { throw 'Expected exactly four new bundled Skills' }
  $sentinels = @('story2libtv.cmd','node_modules/story-to-libtv/package.json','.codex/config.toml','.story2libtv-runtime/owner.json')
  foreach ($skill in @('story-to-libtv','video-prompt-to-libtv','seedance-segment-prompt-engine','story-reference-image-builder')) { $sentinels += ".codex/skills/$skill/SKILL.md" }
  $hashes = @{}
  foreach ($file in $sentinels) {
    $target = Join-Path $prefix $file
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    if ($file -like '*package.json') { [IO.File]::WriteAllText($target,'{"name":"story-to-libtv","version":"0.2.22"}') }
    else { [IO.File]::WriteAllText($target,'old-install-sentinel') }
    $hashes[$target] = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
  }
  Invoke-Npm @('install','--global','--prefix',$prefix,'--offline','--ignore-scripts','--cache',$cache,$tarball)
  & $nodePath (Join-Path $prefix 'node_modules/metasocli/dist/cli/main.js') --version
  if ($LASTEXITCODE -ne 0) { throw 'Installed CLI did not start' }
  if (-not (Test-Path -LiteralPath (Join-Path $prefix 'metasocli.cmd'))) { throw 'New command shim was not installed' }
  Invoke-Npm @('install','--global','--prefix',$prefix,'--offline','--ignore-scripts','--cache',$cache,$tarball)
  Invoke-Npm @('uninstall','--global','--prefix',$prefix,'--offline','--ignore-scripts','--cache',$cache,'metasocli')
  if (Test-Path -LiteralPath (Join-Path $prefix 'metasocli.cmd')) { throw 'New command shim remains after uninstall' }
  foreach ($target in $hashes.Keys) { if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $hashes[$target]) { throw 'An old installation sentinel changed' } }
  Write-Output 'PASS independent offline npm ci/build/tests; packaged CLI install/reinstall/uninstall in temporary prefix; 8 old installation sentinels unchanged.'
} finally {
  Set-Location -LiteralPath $originalLocation
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name,$savedEnvironment[$name],'Process') }
  if (Test-Path -LiteralPath $testRoot) {
    $actual = (Resolve-Path -LiteralPath $testRoot).Path
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $actual.StartsWith($tempBase,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $actual) -notlike 'metasocli-package-*') { throw 'Unsafe cleanup target' }
    Remove-Item -LiteralPath $actual -Recurse -Force
  }
}
