# Desktop release guide

Every installer bundles Electron, the Rust backend, MuJoCo 3.12.0, and UI assets.

| System | Output |
|---|---|
| Linux x64 and ARM64 | DEB and RPM |
| macOS ARM64 | DMG |
| Windows x64 | NSIS EXE |

The release also contains a macOS ZIP for automatic updates, updater manifests
(`latest*.yml`), block maps, and `SHA256SUMS` for all seven payloads. There is no
AppImage or macOS x64 target. Windows ARM64 is omitted because MuJoCo 3.12.0
does not publish a Windows ARM64 library.

## Publish

1. Match versions in `Cargo.toml` and `electron/package.json`; update both
   lockfiles and commit.
2. Let [unit tests](../.github/workflows/tests.yml) pass on `main`.
3. Push `vX.Y.Z`. The [release workflow](../.github/workflows/release.yml)
   builds all four variants, verifies checksums, and publishes the release.

## Build locally

Build on the target OS. On Linux and Windows, set `MUJOCO_DOWNLOAD_DIR` to
`.tools/mujoco` for Cargo to download the pinned SDK. On macOS, copy the
versioned dylib from the MuJoCo DMG into `.tools/mujoco/mujoco-3.12.0/lib`,
add a `libmujoco.dylib` symlink, and set `MUJOCO_DYNAMIC_LINK_DIR` there. CI
handles this. RPM packaging needs `rpmbuild` (the `rpm` package).

```sh
cargo build --locked --release
cd electron
npm ci
npm run check
npm run package:installers
```

Find installers and individual checksums in `dist-electron/`; publication
combines the checksums into `SHA256SUMS`.

## Updates

All platforms use [electron-updater](https://www.electron.build/v26/docs/features/auto-update/):
NSIS on Windows, Squirrel.Mac on macOS, and the DEB/RPM package-manager backends
on Linux. Builder generates the installed `app-update.yml`, Linux package-type
markers, release metadata, and Windows elevation helper. Installer builds use
the normal builder packaging path so signing and these resources are included.
The NSIS `customInit` hook selects the registration matching the updater's
installation directory, preserving user/system scope when both copies exist.
Its supported process-check hook waits for other app/backend processes to close
normally and aborts after 30 seconds; it never force-stops a motor operation.

Updates run only through **Settings → Check for update → Install update**.
Automatic downloading and installation on ordinary app exit are disabled.
The library validates download hashes and handles installation and restart.
Motor activity blocks installation, including a second check after downloading.
Diagnostics are in `update.log` in the app's user data folder; the restarted app
verifies its version against `pending-update.json`.

Existing Windows releases with the broken PowerShell updater need one manual
installation to obtain the maintained updater. Switching NSIS to MSIX is not
required; MSIX would need a trusted Windows signing certificate or Store setup.

### macOS signing setup

macOS auto-updates require Developer ID signing and notarization. Releases use
ad-hoc signing until a certificate is configured; install those DMGs manually.
If macOS blocks launch, open **System Settings → Privacy & Security → Open Anyway**
after attempting to launch the app.

Configure these GitHub repository secrets to enable Developer ID releases:

- `MAC_CSC_LINK`: base64-encoded Developer ID Application `.p12` certificate.
- `MAC_CSC_KEY_PASSWORD`: certificate password.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: notarization credentials.

Once `MAC_CSC_LINK` is configured, tagged macOS builds require signing and
notarization and fail if the remaining credentials are missing. Local builds
and manual workflow runs without a certificate also use ad-hoc signing.
The macOS ZIP and `latest-mac.yml` must be published alongside the DMG.
The first signed build must be installed manually over the existing ad-hoc app.

Sign the bundled MuJoCo library and Rust executable after all Mach-O changes,
then sign the outer app. `codesign --deep` alone does not repair binaries under
`Contents/Resources/backend`. Packaging verifies each signature separately and
runs the final bundled backend's self-check without `DYLD_LIBRARY_PATH`.
