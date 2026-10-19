# Desktop release guide

The release workflow builds Electron installers for Linux x64/ARM64 (DEB and
RPM), macOS ARM64 (DMG), and Windows x64 (NSIS EXE). Each installer contains
Electron, the Rust backend, MuJoCo 3.12.0, and the UI assets. The release
includes `SHA256SUMS` for all six installers. There is no AppImage or macOS
x64 target. Windows ARM64 is omitted because MuJoCo 3.12.0 does not publish a
Windows ARM64 library.

## Publish

1. Set the same version in `Cargo.toml` and `electron/package.json`, then update
   `Cargo.lock` and commit the changes.
2. Let the unit test workflow pass on `main`.
3. Push a matching `vX.Y.Z` tag. The [release workflow](../.github/workflows/release.yml)
   builds four platform variants, verifies six installers, and publishes the
   GitHub release when every build succeeds.

## Build locally

Build on the target operating system. On Linux and Windows, Cargo downloads
the pinned MuJoCo SDK to `.tools/mujoco` when `MUJOCO_DOWNLOAD_DIR` points
there. On macOS, mount the MuJoCo 3.12.0 DMG, copy its versioned dylib into
`.tools/mujoco/mujoco-3.12.0/lib`, add a `libmujoco.dylib` symlink, and set
`MUJOCO_DYNAMIC_LINK_DIR` to that directory. The release workflow does this
automatically. Linux RPM packaging also needs `rpmbuild` (`rpm` package).

```sh
cargo build --locked --release
cd electron
npm ci
npm run check
npm run package:installers
```

Installers and their individual checksums appear under `dist-electron/`.
The publish job combines the checksums into `SHA256SUMS`.

## Updates

Settings queries the latest GitHub release. The Install button appears only
when that release has the matching installer and `SHA256SUMS`. The app verifies
the download and opens the native installer. The user completes installation
in the system dialog, then restarts the app. A running motor operation must
finish before installation.
