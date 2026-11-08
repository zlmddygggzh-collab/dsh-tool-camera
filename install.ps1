<#
.SYNOPSIS
    安装 dsh-tool-camera 到指定的 DeepSeek Harness profile。

.DESCRIPTION
    做两件市场安装会做的事：
      1) 把包加进 profile 的 dependencies（pnpm add）
      2) 把包名登记进 package.json 的 dsh.profile.bundles
    登记完重启 DSH，工具 camera_snapshot / camera_devices 才会出现。

    本脚本不下载 ffmpeg —— 那是插件第一次抓帧时自己做的事。

.PARAMETER Tgz
    本地 .tgz 安装包路径（离线/内网用这个）。

.PARAMETER FromNpm
    从 npm 按包名安装（发布后可用），例如 -FromNpm dsh-tool-camera。

.PARAMETER Profile
    profile 目录。默认依次尝试 $env:DSH_HOME\profiles\desktop、
    %USERPROFILE%\.dsh\profiles\desktop。

.PARAMETER Pnpm
    指定 pnpm 可执行文件 / pnpm.cjs 路径。默认从 PATH、corepack、npx 里找。

.EXAMPLE
    pwsh -File install.ps1 -Tgz .\dsh-tool-camera-1.0.0.tgz

.EXAMPLE
    pwsh -File install.ps1 -FromNpm dsh-tool-camera
#>
[CmdletBinding(DefaultParameterSetName = 'Tgz')]
param(
    [Parameter(ParameterSetName = 'Tgz', Mandatory = $true)]
    [string]$Tgz,

    [Parameter(ParameterSetName = 'Npm', Mandatory = $true)]
    [string]$FromNpm,

    [string]$Profile,
    [string]$Pnpm
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-tool-camera'

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

# ---------- 1. 定位 profile -------------------------------------------------
if (-not $Profile) {
    $candidates = @()
    if ($env:DSH_HOME) { $candidates += (Join-Path $env:DSH_HOME 'profiles\desktop') }
    $candidates += (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
    foreach ($candidate in $candidates) {
        if (Test-Path (Join-Path $candidate 'package.json')) { $Profile = $candidate; break }
    }
}
if (-not $Profile -or -not (Test-Path (Join-Path $Profile 'package.json'))) {
    throw "找不到 DSH profile 目录。用 -Profile <path> 明确指定（里面有 package.json 的那一层）。"
}
$Profile = (Resolve-Path $Profile).Path
Write-Step "profile: $Profile"

# ---------- 2. 定位 pnpm ----------------------------------------------------
function Resolve-Pnpm {
    if ($Pnpm) {
        if (-not (Test-Path $Pnpm)) { throw "指定的 pnpm 不存在：$Pnpm" }
        if ($Pnpm -like '*.cjs') { return @{ File = 'node'; Prefix = @($Pnpm) } }
        return @{ File = $Pnpm; Prefix = @() }
    }
    $onPath = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($onPath) { return @{ File = $onPath.Source; Prefix = @() } }

    $corepack = Get-Command corepack -ErrorAction SilentlyContinue
    if ($corepack) { return @{ File = $corepack.Source; Prefix = @('pnpm') } }

    # DSH 桌面版自带 pnpm（Electron 资源目录里）
    $roots = @(
        "$env:LOCALAPPDATA\Programs",
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)}
    ) | Where-Object { $_ -and (Test-Path $_) }
    foreach ($root in $roots) {
        $hit = Get-ChildItem -Path $root -Filter 'pnpm.cjs' -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match 'runtime\\primary-runtime\\dependencies\\pnpm\\bin' } |
            Select-Object -First 1
        if ($hit) { return @{ File = 'node'; Prefix = @($hit.FullName) } }
    }

    $npx = Get-Command npx -ErrorAction SilentlyContinue
    if ($npx) { return @{ File = $npx.Source; Prefix = @('-y', 'pnpm@11') } }

    throw "找不到 pnpm。装一个 pnpm，或用 -Pnpm 指定（可以是 pnpm.cmd，也可以是 pnpm.cjs 的完整路径）。"
}

$pnpmInfo = Resolve-Pnpm
Write-Step "pnpm: $($pnpmInfo.File) $($pnpmInfo.Prefix -join ' ')"

# ---------- 3. 备份 ---------------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($file in @('package.json', 'pnpm-lock.yaml')) {
    $full = Join-Path $Profile $file
    if (Test-Path $full) {
        Copy-Item $full "$full.bak-camera-$stamp"
        Write-Ok "已备份 $file"
    }
}

# ---------- 4. pnpm add -----------------------------------------------------
if ($PSCmdlet.ParameterSetName -eq 'Tgz') {
    if (-not (Test-Path $Tgz)) { throw "安装包不存在：$Tgz" }
    $spec = (Resolve-Path $Tgz).Path
} else {
    $spec = $FromNpm
}

Write-Step "安装 $spec"
Push-Location $Profile
try {
    $arguments = @()
    if ($pnpmInfo.Prefix.Count -gt 0 -and $pnpmInfo.File -eq 'node') {
        $arguments = $pnpmInfo.Prefix + @('add', $spec)
    } elseif ($pnpmInfo.Prefix.Count -gt 0) {
        $arguments = $pnpmInfo.Prefix + @('add', $spec)
    } else {
        $arguments = @('add', $spec)
    }
    & $pnpmInfo.File @arguments
    if ($LASTEXITCODE -ne 0) { throw "pnpm add 失败（exit $LASTEXITCODE）" }
} finally {
    Pop-Location
}
Write-Ok "依赖已写入"

# ---------- 5. 登记 bundle --------------------------------------------------
Write-Step "登记到 dsh.profile.bundles"
$manifestPath = Join-Path $Profile 'package.json'
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $manifest.dsh) { throw "package.json 里没有 dsh 字段，这看起来不是一个 DSH profile。" }
if (-not $manifest.dsh.profile) { $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
if (-not $manifest.dsh.profile.bundles) {
    $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
}
$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -contains $PackageName) {
    Write-Warn2 "已经在 bundles 里，跳过"
} else {
    $bundles += $PackageName
    $manifest.dsh.profile.bundles = $bundles
    ($manifest | ConvertTo-Json -Depth 32) | Set-Content $manifestPath -Encoding UTF8
    Write-Ok "已加入 bundles（共 $($bundles.Count) 项）"
}

# ---------- 6. 收尾 --------------------------------------------------------
Write-Host ''
Write-Host "完成。重启 DeepSeek Harness 后，agent 会多出两个工具：" -ForegroundColor Cyan
Write-Host "  camera_snapshot   抓一帧摄像头画面并直接交给模型" -ForegroundColor Gray
Write-Host "  camera_devices    列出设备、ffmpeg 状态、采集后端" -ForegroundColor Gray
Write-Host ''
Write-Host "首次抓帧时插件会自动下载对应平台的 ffmpeg（约 22MB，走 npmmirror）。" -ForegroundColor Gray
Write-Host "回滚：把上面生成的 *.bak-camera-$stamp 文件改回原名，再重启。" -ForegroundColor DarkGray
