[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$agentRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = Split-Path -Parent $agentRoot
$signingRoot = Join-Path $repositoryRoot 'VorionSign'
$pfxPath = Join-Path $signingRoot 'VorionSign.pfx'
$cerPath = Join-Path $signingRoot 'VorionPublic.cer'

if ((Test-Path -LiteralPath $pfxPath) -or (Test-Path -LiteralPath $cerPath)) {
    throw "Signing files already exist. Move or remove them explicitly before creating a replacement certificate."
}

New-Item -ItemType Directory -Path $signingRoot -Force | Out-Null
$password = Read-Host 'Create a password for VorionSign.pfx' -AsSecureString
if ($password.Length -eq 0) { throw 'The PFX password cannot be empty.' }

$certificate = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject 'CN=Vorion Systems, O=Vorion Systems' `
    -FriendlyName 'Vorion Agent Code Signing' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -NotAfter (Get-Date).AddYears(15) `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -KeyUsage DigitalSignature

try {
    Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $password -ChainOption EndEntityCertOnly | Out-Null
    Export-Certificate -Cert $certificate -FilePath $cerPath -Type CERT | Out-Null
} catch {
    Remove-Item -LiteralPath $pfxPath,$cerPath -Force -ErrorAction SilentlyContinue
    throw
}

Write-Host "Private signing key: $pfxPath"
Write-Host "Public certificate: $cerPath"
Write-Host "Back up the PFX and its password securely. The entire VorionSign folder is excluded from Git."
