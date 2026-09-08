[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$agentRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = Split-Path -Parent $agentRoot
$pfxPath = Join-Path $repositoryRoot 'VorionSign\VorionSign.pfx'
$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path

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
Write-Host "Signed installer: $resolvedInstaller"
Write-Host "Signer: $($signature.SignerCertificate.Subject)"
Write-Host "Signature status on this build computer: $($signature.Status)"
