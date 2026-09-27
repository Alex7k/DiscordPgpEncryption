#Requires -Version 5.1
<#
.SYNOPSIS
    Installs or updates Vencord or Equicord with the PgpEncrypt userplugin.
    Safe to re-run.

.DESCRIPTION
    Installs any missing prerequisites then clones or
    updates the selected client and this plugin, installs dependencies, builds,
    and injects into Discord. Every step is skipped when it is already done.

.PARAMETER Client
    Select Vencord or Equicord.

.PARAMETER InstallDir
    Folder of the Vencord checkout. Defaults to the checkout this script sits
    inside, or "$HOME\Vencord" otherwise.
#>
[CmdletBinding()]
param(
    [ValidateSet("Vencord", "Equicord")]
    [string]$Client,
    [string]$InstallDir
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $scriptPath = $PSCommandPath
    $temporaryScript = $false
    if (-not $scriptPath) {
        $scriptPath = Join-Path $env:TEMP "DiscordPgpEncryption-install-$PID.ps1"
        Invoke-WebRequest -UseBasicParsing `
            -Uri "https://raw.githubusercontent.com/Alex7k/DiscordPgpEncryption/main/install.ps1" `
            -OutFile $scriptPath
        $temporaryScript = $true
    }

    $powerShellExe = if ($PSVersionTable.PSEdition -eq "Core") {
        Join-Path $PSHOME "pwsh.exe"
    }
    else {
        Join-Path $PSHOME "powershell.exe"
    }
    $argumentList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$scriptPath`"")
    if ($PSBoundParameters.ContainsKey("Client")) {
        $argumentList += @("-Client", $Client)
    }
    if ($PSBoundParameters.ContainsKey("InstallDir")) {
        $argumentList += @("-InstallDir", "`"$InstallDir`"")
    }

    try {
        Start-Process -FilePath $powerShellExe -Verb RunAs -ArgumentList $argumentList -Wait | Out-Null
    }
    finally {
        if ($temporaryScript -and (Test-Path $scriptPath)) {
            Remove-Item $scriptPath -Force
        }
    }
    return
}

$VencordRepo = "https://github.com/Vendicated/Vencord"
$EquicordRepo = "https://github.com/Equicord/Equicord"
$PluginRepo = "https://github.com/Alex7k/DiscordPgpEncryption"
$PluginPath = "src/userplugins/pgpEncrypt"
$NodeMajorRequired = 22

if (-not $Client) {
    $selection = Read-Host "Choose client to install: [1] Vencord, [2] Equicord"
    switch ($selection.Trim().ToLowerInvariant()) {
        { $_ -in "1", "v", "vencord" } { $Client = "Vencord" }
        { $_ -in "2", "e", "equicord" } { $Client = "Equicord" }
        default { throw "Invalid choice. Run the script again and select 1 (Vencord) or 2 (Equicord)." }
    }
}

switch ($Client) {
    "Vencord" { $ClientRepo = $VencordRepo; $ClientPackageName = "vencord" }
    "Equicord" { $ClientRepo = $EquicordRepo; $ClientPackageName = "equicord" }
}

function Exec {
    param([scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code ${LASTEXITCODE}: $Command" }
}

function Invoke-Pnpm {
    param([string[]]$Arguments)
    & npm exec --yes --package "pnpm@$PnpmVersion" -- pnpm @Arguments
    if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') failed with exit code ${LASTEXITCODE}." }
}

function Test-Command {
    param([string]$Name)
    [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

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

# checks for prerequisites

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

if (-not $InstallDir) {
    $candidate = if ($PSScriptRoot) { Resolve-Path (Join-Path $PSScriptRoot "..\..\..") -ErrorAction SilentlyContinue } else { $null }
    $InstallDir = if ($candidate -and (Test-Path (Join-Path $candidate "package.json")) -and
        ((Get-Content (Join-Path $candidate "package.json") -Raw | ConvertFrom-Json).name -eq $ClientPackageName)) {
        "$candidate"
    }
    else {
        Join-Path $env:USERPROFILE $Client
    }
}

if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "Updating $Client in $InstallDir..."
    Exec { git -C $InstallDir pull --rebase --autostash }
}
else {
    Write-Host "Cloning $Client into $InstallDir..."
    Exec { git clone $ClientRepo $InstallDir }
}

$clientPackage = Get-Content (Join-Path $InstallDir "package.json") -Raw | ConvertFrom-Json
if ($clientPackage.packageManager -match '^pnpm@(.+)$') {
    $PnpmVersion = $Matches[1]
}
else {
    throw "Could not determine the required pnpm version from '$InstallDir\package.json'."
}

Write-Host "Using pnpm $PnpmVersion for $Client via npm."

$pluginDir = Join-Path $InstallDir $PluginPath
if (Test-Path (Join-Path $pluginDir ".git")) {
    Write-Host "Updating PgpEncrypt plugin..."
    Exec { git -C $pluginDir pull --rebase --autostash }
}
else {
    Write-Host "Cloning PgpEncrypt plugin..."
    Exec { git clone $PluginRepo $pluginDir }
}

# all the dependencies, build n inject

Push-Location $InstallDir
try {
    Write-Host "Installing dependencies..."
    Invoke-Pnpm "install"

    $package = Get-Content "package.json" -Raw | ConvertFrom-Json
    if (-not $package.dependencies.openpgp) {
        Write-Host "Adding openpgp..."
        Invoke-Pnpm @("add", "-w", "openpgp")
    }
    if (-not $package.devDependencies.'@openpgp/web-stream-tools') {
        Write-Host "Adding @openpgp/web-stream-tools..."
        Invoke-Pnpm @("add", "-Dw", "@openpgp/web-stream-tools")
    }

    Write-Host "Building $Client..."
    Invoke-Pnpm "build"
    Write-Host "Building browser extension..."
    Invoke-Pnpm "buildWeb"
    Write-Host "Injecting into Discord..."
    Invoke-Pnpm "inject"
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Done. Applies after next full Discord reopen." -ForegroundColor Green
