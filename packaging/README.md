# Desktop release guide

The release workflow builds Electron bundles for Linux x64/ARM64, macOS
x64/ARM64, and Windows x64. Each bundle contains Electron, the Rust motor
backend, MuJoCo 3.12.0, and the UI assets. It publishes a `.tar.gz` archive
and a matching `.sha256` file for each platform. No AppImage is produced.

## Publish

1. Set the same version in `Cargo.toml` and `electron/package.json`, then update
   `Cargo.lock` and commit the changes.
2. Let the unit test workflow pass on `main`.
3. Push a matching `vX.Y.Z` tag. The [release workflow](../.github/workflows/release.yml)
   builds all five bundles, verifies the checksums, and publishes the GitHub
   release when every build succeeds.

## Build locally

Build on the target operating system. On Linux and Windows, Cargo downloads
the pinned MuJoCo SDK to `.tools/mujoco` when `MUJOCO_DOWNLOAD_DIR` points
there. On macOS, mount the MuJoCo 3.12.0 DMG, copy its versioned dylib into
`.tools/mujoco/mujoco-3.12.0/lib`, add a `libmujoco.dylib` symlink, and set
`MUJOCO_DYNAMIC_LINK_DIR` to that directory. The release workflow does this
automatically.

```sh
cargo build --locked --release
cd electron
npm ci
npm run check
npm run package:desktop
```

The output is under `dist-electron/`. Run the executable in the unpacked
directory, or publish the archive and checksum pair to GitHub Releases.

## Updates

Settings queries the latest GitHub release. The Install button appears only
when that release includes the matching `motor-setup-tool-electron-PLATFORM-ARCH.tar.gz`
and `.sha256` assets. The app verifies the checksum, extracts the bundle into
its user data directory, and launches it. The original launcher redirects to
that newer installed version on subsequent starts. A running motor operation
must finish before installation.
