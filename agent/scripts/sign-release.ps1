[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$agentRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = Split-Path -Parent $agentRoot
$pfxPath = Join-Path $repositoryRoot 'VorionSign\VorionSign.pfx'
$normalizedInstallerPath = ($InstallerPath -replace '[\x00-\x1F\u00A0]', '').Trim()
if ($normalizedInstallerPath -match '(?i)([A-Z]:\\.*?\.exe)') {
    $normalizedInstallerPath = $Matches[1]
} elseif ($normalizedInstallerPath -match '(?i)(.*?\.exe)') {
    $normalizedInstallerPath = $Matches[1].Trim().Trim('"')
} else {
    throw 'InstallerPath must point to a .exe installer.'
}
$resolvedInstaller = (Resolve-Path -LiteralPath $normalizedInstallerPath).Path

if (-not (Test-Path -LiteralPath $pfxPath)) {
    throw "Signing certificate not found at $pfxPath. Run scripts/create-signing-cert.ps1 first."
}

$signToolCommand = Get-Command 'signtool.exe' -ErrorAction SilentlyContinue
if ($signToolCommand) {
    $signTool = $signToolCommand.Source
} else {
    $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $signTool = Get-ChildItem -LiteralPath $kitsRoot -Filter 'signtool.exe' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signTool) { throw 'signtool.exe was not found. Install the Windows SDK Signing Tools feature.' }

$securePassword = Read-Host 'Enter the VorionSign.pfx password' -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    & $signTool sign /f $pfxPath /p $plainPassword /fd SHA256 /tr 'http://timestamp.digicert.com' /td SHA256 $resolvedInstaller
    if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE." }
} finally {
    if ($passwordPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }
    $plainPassword = $null
}

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedInstaller
if (-not $signature.SignerCertificate) { throw 'The installer does not contain an Authenticode signer certificate.' }

# Signing changes the installer bytes. electron-builder creates latest.yml
# before this manual signing step, so refresh its checksum and size or
# electron-updater will reject the correctly signed installer.
$artifactDirectory = Split-Path -Parent $resolvedInstaller
$latestYmlPath = Join-Path $artifactDirectory 'latest.yml'
if (Test-Path -LiteralPath $latestYmlPath) {
    $stream = [System.IO.File]::OpenRead($resolvedInstaller)
    try {
        $sha512 = [System.Security.Cryptography.SHA512]::Create()
        try {
            $installerSha512 = [Convert]::ToBase64String($sha512.ComputeHash($stream))
        } finally {
            $sha512.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
    $installerSize = (Get-Item -LiteralPath $resolvedInstaller).Length
    $metadata = [System.IO.File]::ReadAllText($latestYmlPath)
    $metadata = [regex]::Replace($metadata, '(?m)^(\s*sha512:\s*).+$', "`${1}$installerSha512")
    $metadata = [regex]::Replace($metadata, '(?m)^(\s*size:\s*)\d+\s*$', "`${1}$installerSize")
    [System.IO.File]::WriteAllText($latestYmlPath, $metadata, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Updated updater metadata: $latestYmlPath"
    Write-Host "Installer size: $installerSize"
    Write-Host "Installer SHA-512: $installerSha512"
} else {
    Write-Warning "latest.yml was not found beside the installer. The signed EXE is valid for manual distribution, but do not publish it for auto-update without regenerated metadata."
}

Write-Host "Signed installer: $resolvedInstaller"
Write-Host "Signer: $($signature.SignerCertificate.Subject)"
Write-Host "Signature status on this build computer: $($signature.Status)"
