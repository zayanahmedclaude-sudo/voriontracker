# Updating employee trackers

Build and publish one newer version to the existing GitHub release feed:
`VorionDevTeam/tracker-download`.

The installed agent checks 15 seconds after startup and every four hours,
then downloads a newer release automatically. Employees can also use
Check for Updates. A downloaded update remains available through the
Restart and Update button. Background downloads do not open a modal or
restart an active shift.

## Release checklist

1. Increase the version in agent/package.json and agent/package-lock.json.
2. Build the Windows installer, including the updated supervisor.
3. Sign using the existing release signing process. Signing must refresh
   latest.yml because it changes the installer hash and size.
4. Publish a non-draft, non-prerelease GitHub release with the matching
   VorionTrackerSetup.exe, latest.yml, and installer blockmap produced by
   that release. Keep the same signing identity and application ID.
5. Test an upgrade on one enrolled PC before wider rollout: confirm the
   same dashboard device ID and employee assignment, restored attendance,
   successful screenshots, and the supervisor running after restart.

## Device enrollment survives an upgrade

Do not delete or revoke dashboard devices when shipping an agent release.
Install the update over the current installation; do not uninstall first.
The new installer backs up the encrypted machine enrollment and screenshot
queue before running the old uninstaller, then restores them before service
installation. This also handles the transition from older uninstallers that
delete enrollment. Subsequent upgrades preserve enrollment directly.

A fresh computer, a deliberately uninstalled agent, or a device whose
credential was revoked still requires enrollment. Lost credentials cannot be
recovered from the dashboard's one-way token hash.

## Windows administrator approval

Automatic download is implemented. Fully unattended privileged installation
is not: this is a per-machine installer that replaces a Windows service, and
Windows may request administrator credentials. Existing clients can receive
the transition release through their current updater, but need approval if
Windows requires elevation. For centrally managed PCs, IT can deploy the
installer using its existing elevated software-deployment system.

A future fully unattended updater should be a separate privileged updater
service with a fixed release origin, pinned publisher verification, version
and downgrade checks, a protected staging directory, rollback, and an
explicit allowlist of installer operations. Do not expose arbitrary installer
paths or shell commands through the employee-accessible supervisor pipe.

This source change has not been packaged, published, or tested through an
installed Windows upgrade. Local source tests do not replace the pilot upgrade.

## Duplicate Windows Installed Apps entries

Older releases used per-user installation; current releases use per-machine
installation. These have separate uninstall records. If setup is elevated
using another administrator account, HKEY_CURRENT_USER belongs to that
administrator, not the employee who installed the older copy. The installer
cannot assume that deleting one registry entry removes the other app.

Identify both uninstall records and their paths before cleanup. Do not delete
all Vorion folders, clear app data, or revoke dashboard devices. The updated
installer stops if the detected old uninstaller fails to launch or fails to
complete. This does not automatically migrate installations belonging to a
different Windows account. Such legacy installs need a migration in the
original employee's user context, coordinated with the per-machine upgrade.
