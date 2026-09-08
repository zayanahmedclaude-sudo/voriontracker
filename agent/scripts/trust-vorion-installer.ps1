[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$InstallerPath = (Join-Path $PSScriptRoot 'VorionTrackerSetup.exe')
)

$ErrorActionPreference = 'Stop'
$expectedThumbprint = 'EABAC223190E145442463C71B7BD8E7DD7FAAEAE'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $PSCommandPath),
        ('"{0}"' -f $InstallerPath)
    )
    $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    exit $process.ExitCode
}

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$signature = Get-AuthenticodeSignature -LiteralPath $resolvedInstaller
$certificate = $signature.SignerCertificate
if (-not $certificate) {
    throw 'The installer does not contain an Authenticode signing certificate.'
}
if ($certificate.Thumbprint -ne $expectedThumbprint) {
    throw "The installer signer is not the expected Vorion certificate. Found thumbprint: $($certificate.Thumbprint)"
}

foreach ($storeName in @('Root', 'TrustedPublisher')) {
    $store = [Security.Cryptography.X509Certificates.X509Store]::new($storeName, 'LocalMachine')
    try {
        $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        if (-not ($store.Certificates | Where-Object Thumbprint -eq $expectedThumbprint)) {
            $store.Add($certificate)
        }
    } finally {
        $store.Close()
    }
}

$verified = Get-AuthenticodeSignature -LiteralPath $resolvedInstaller
if ($verified.Status -ne 'Valid') {
    throw "Vorion certificate was installed, but signature validation returned: $($verified.Status)"
}

Write-Host 'Vorion Systems is now trusted on this computer.' -ForegroundColor Green
Write-Host "Verified installer: $resolvedInstaller"
Read-Host 'Press Enter to close'
