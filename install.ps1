#Requires -Version 5.1
<#
.SYNOPSIS
    Installs or updates Vencord with the PgpEncrypt userplugin. Safe to re-run.

.DESCRIPTION
    Installs any missing prerequisites (Git, Node.js 22+, pnpm), then clones or
    updates Vencord and this plugin, installs dependencies, builds, and injects
    into Discord. Every step is skipped when it is already done.

.PARAMETER VencordDir
    Folder of the Vencord checkout. Defaults to the checkout this script sits
    inside, or "$HOME\Vencord" otherwise.
#>
[CmdletBinding()]
param(
    [string]$VencordDir
)

$ErrorActionPreference = "Stop"

$VencordRepo = "https://github.com/Vendicated/Vencord"
$PluginRepo = "https://github.com/Alex7k/DiscordPgpEncryption"
$PluginPath = "src/userplugins/pgpEncrypt"
$PnpmVersion = "11.9.0"
$NodeMajorRequired = 22

function Exec {
    param([scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code ${LASTEXITCODE}: $Command" }
}

function Test-Command {
    param([string]$Name)
    [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# picks up PATH additions made by winget/corepack without a new shell
function Update-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [Environment]::GetEnvironmentVariable("Path", "User")
}

function Install-WingetPackage {
    param([string]$Id)
    if (-not (Test-Command winget)) {
        throw "winget is not available. Install '$Id' manually, then re-run this script."
    }
    Exec { winget install --id $Id -e --accept-source-agreements --accept-package-agreements }
    Update-SessionPath
}

# --- Prerequisites -----------------------------------------------------------

if (Test-Command git) {
    Write-Host "Git found: $(git --version)"
}
else {
    Write-Host "Installing Git..."
    Install-WingetPackage "Git.Git"
}

$nodeOk = $false
if (Test-Command node) {
    $nodeMajor = [int](node --version).TrimStart("v").Split(".")[0]
    $nodeOk = $nodeMajor -ge $NodeMajorRequired
    if ($nodeOk) { Write-Host "Node.js found: $(node --version)" }
    else { Write-Host "Node.js $(node --version) is older than v$NodeMajorRequired, upgrading..." }
}
else {
    Write-Host "Installing Node.js LTS..."
}
if (-not $nodeOk) { Install-WingetPackage "OpenJS.NodeJS.LTS" }

if (Test-Command pnpm) {
    Write-Host "pnpm found: $(pnpm --version)"
}
else {
    Write-Host "Activating pnpm $PnpmVersion via corepack..."
    # corepack enable needs write access to the Node.js install dir; fall back
    # to a per-user npm global install when that is denied (non-admin shell)
    try {
        Exec { corepack enable }
        Exec { corepack prepare "pnpm@$PnpmVersion" --activate }
    }
    catch {
        Write-Host "corepack failed ($_), falling back to npm..."
        Exec { npm install -g "pnpm@$PnpmVersion" }
    }
    Update-SessionPath
    if (-not (Test-Command pnpm)) {
        throw "pnpm was installed but is not on PATH yet. Open a new terminal and re-run this script."
    }
}

# --- Vencord + plugin checkouts ----------------------------------------------

if (-not $VencordDir) {
    # when the script runs from inside the plugin checkout, update that
    # Vencord instead of cloning a new one
    $candidate = if ($PSScriptRoot) { Resolve-Path (Join-Path $PSScriptRoot "..\..\..") -ErrorAction SilentlyContinue } else { $null }
    $VencordDir = if ($candidate -and (Test-Path (Join-Path $candidate "package.json")) -and
        ((Get-Content (Join-Path $candidate "package.json") -Raw | ConvertFrom-Json).name -eq "vencord")) {
        "$candidate"
    }
    else {
        # fixed default so running the one-liner from any directory always
        # finds (or creates) the same install
        Join-Path $env:USERPROFILE "Vencord"
    }
}

if (Test-Path (Join-Path $VencordDir ".git")) {
    Write-Host "Updating Vencord in $VencordDir..."
    Exec { git -C $VencordDir pull --rebase --autostash }
}
else {
    Write-Host "Cloning Vencord into $VencordDir..."
    Exec { git clone $VencordRepo $VencordDir }
}

$pluginDir = Join-Path $VencordDir $PluginPath
if (Test-Path (Join-Path $pluginDir ".git")) {
    Write-Host "Updating PgpEncrypt plugin..."
    Exec { git -C $pluginDir pull --rebase --autostash }
}
else {
    Write-Host "Cloning PgpEncrypt plugin..."
    Exec { git clone $PluginRepo $pluginDir }
}

# --- Dependencies, build, inject ---------------------------------------------

Push-Location $VencordDir
try {
    Write-Host "Installing dependencies..."
    Exec { pnpm install }

    # stock Vencord does not ship the OpenPGP dependencies this plugin uses
    $package = Get-Content "package.json" -Raw | ConvertFrom-Json
    if (-not $package.dependencies.openpgp) {
        Write-Host "Adding openpgp..."
        Exec { pnpm add -w openpgp }
    }
    if (-not $package.devDependencies.'@openpgp/web-stream-tools') {
        Write-Host "Adding @openpgp/web-stream-tools..."
        Exec { pnpm add -Dw "@openpgp/web-stream-tools" }
    }

    Write-Host "Building Vencord..."
    Exec { pnpm build }

    # also build the browser extension (dist/chromium-unpacked); costs a few
    # seconds and saves a manual step for anyone using Discord in a browser
    Write-Host "Building browser extension..."
    Exec { pnpm buildWeb }

    # interactive: asks which Discord install to patch; already-injected
    # installs are detected and left alone
    Write-Host "Injecting into Discord..."
    Exec { pnpm inject }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Done. Applies after next full Discord reopen." -ForegroundColor Green
