# Manual self-signed code signing

Vorion Agent uses electron-builder with the NSIS target. This local workflow creates one long-lived self-signed certificate, packages its public certificate with the application, and signs each finished installer manually. It does not use CI, environment variables, or a cloud secret store.

## One-time setup

Open PowerShell in the `agent` directory and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create-signing-cert.ps1
```

Enter a strong password when prompted. The script creates:

- `../VorionSign/VorionSign.pfx`: private certificate and signing key. Back up the file and password securely and never distribute or commit it.
- `../VorionSign/VorionPublic.cer`: public certificate bundled by electron-builder during the local build.

The repository-level `VorionSign` directory is gitignored. Keep both local files there; electron-builder reads only the public CER.

The certificate is valid for 15 years. Do not recreate it for each release because installed computers trust this specific certificate.

## Build and sign a release

Build the installer normally:

```powershell
npm run build
```

The build prints the generated installer path, for example `artifacts-123456789/VorionTrackerSetup.exe`. Sign that exact file:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\sign-release.ps1 .\artifacts-123456789\VorionTrackerSetup.exe
```

The script prompts for the PFX password and invokes this command through a safely constructed PowerShell argument list:

```text
signtool sign /f <repository\VorionSign\VorionSign.pfx> /p <prompted-password> /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 <installer.exe>
```

`signtool.exe` is provided by the free [Windows SDK](https://developer.microsoft.com/en-us/windows/downloads/windows-sdk/). In the SDK installer, select **Windows SDK Signing Tools for Desktop Apps**. The script searches `PATH` and the versioned Windows 10 SDK `x64` directories, so adding it to `PATH` is optional.

Verify the final file before distributing it:

```powershell
Get-AuthenticodeSignature .\artifacts-123456789\VorionTrackerSetup.exe | Format-List Status,StatusMessage,SignerCertificate
```

## What happens on an employee computer

The first installation can still show a SmartScreen warning because Windows evaluates the installer before any installer code runs. After the employee chooses **More info > Run anyway** and approves UAC, the NSIS installer runs:

```text
certutil.exe -addstore -f "Root" "<install-dir>\resources\VorionPublic.cer"
certutil.exe -addstore -f "TrustedPublisher" "<install-dir>\resources\VorionPublic.cer"
```

`Root` establishes trust for the self-signed certificate and `TrustedPublisher` trusts software signed by it. Later installers signed with the same PFX can be validated on that computer. The installer aborts if either certificate operation fails.

This free approach establishes trust only on computers where the public certificate has been installed. It does not create public SmartScreen reputation and is not equivalent to a certificate issued by a trusted public certificate authority.
