# Desktop release guide

Every installer bundles Electron, the Rust backend, MuJoCo 3.12.0, and UI assets.

| System | Output |
|---|---|
| Linux x64 and ARM64 | DEB and RPM |
| macOS ARM64 | DMG |
| Windows x64 | NSIS EXE |

The release also contains `SHA256SUMS` for all six installers. There is no
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

**Settings → Check for update** shows **Install** when the latest release has a
matching installer and `SHA256SUMS`. It verifies the download before installing.
On Linux, the app asks for system authorization, installs the DEB/RPM, and
restarts. On Windows, it closes, runs the NSIS installer silently, and restarts;
installation errors appear in Settings on the next launch. On macOS, the DMG
opens for manual installation. Updates wait for motor operations to end.
