# Linux releases

Repository: [MotomindKR/motor-setup-tool](https://github.com/MotomindKR/motor-setup-tool).
The visible product name is **Motor Calibration / Setup**. The existing Cargo
package and data identity remain `motomind-motor-calib` so updates keep user data.

## Release procedure

1. Update `package.version` in `Cargo.toml` and regenerate `Cargo.lock` with Cargo.
2. Commit and push the change to GitHub.
3. Tag that commit with the exact version, for example:
   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

`.github/workflows/release.yml` builds natively on GitHub's `ubuntu-22.04`
and `ubuntu-22.04-arm` runners. Each job runs the same pinned Ubuntu 22.04
container build used locally, with Rust 1.98.1, `Cargo.lock`, and SHA-256-verified
MuJoCo 3.12.0, AppImage tooling and architecture-specific runtime downloads.
Both architectures must pass formatting, Clippy, unit tests, ELF/glibc inspection,
and clean Ubuntu 22.04/24.04 runtime checks before the publication job starts.

The workflow creates a draft release, uploads both AppImages and their individual
SHA-256 files, then publishes it. Tags containing a hyphen create prereleases.
A manually dispatched workflow builds and tests artifacts without publishing
unless it is explicitly dispatched against a version tag. The tag must match
`Cargo.toml`. Release publication uses only the workflow's built-in token.

Artifacts:

- `Motomind-Motor-Setup-VERSION-linux-amd64.AppImage`
- `Motomind-Motor-Setup-VERSION-linux-arm64.AppImage`
- Matching `.sha256` files

The repository must permit GitHub Actions and the selected hosted runners.
No release secret or personal access token is needed. Private repository
releases are visible to authorized repository members.

## Local build

Docker is the only host build prerequisite. On an amd64 or arm64 Linux host:

```sh
docker build -f packaging/Dockerfile -t motomind-packager .
docker run --rm --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/work/.tools/ci-cargo -v "$PWD:/work" \
  motomind-packager bash scripts/build-appimage.sh
```

This produces the host architecture in `dist/`. Native builds are used for both
architectures in CI; local cross-compilation/emulation is not required. The
Docker base image digest, Rust version and download hashes are pinned. Ubuntu
security packages are resolved at build time, so builds are repeatable but not
claimed to be byte-for-byte reproducible. Mutable runtime release names are
avoided by fetching immutable GitHub asset IDs with verified hashes.

`package.py` bundles MuJoCo, the desktop libraries loaded by egui/winit, license
texts and build metadata. System glibc, the ELF loader and OpenGL driver/dispatch
stay on the host. The binary uses `$ORIGIN/../lib`; packaged libraries use
`$ORIGIN`. The release script rejects GLIBC requirements newer than 2.35.
The final AppImage uses the statically linked type-2 runtime; systems without
FUSE can use `APPIMAGE_EXTRACT_AND_RUN=1`.

To run the same clean runtime check as CI:

```sh
docker build -f packaging/Dockerfile.smoke -t motomind-smoke .
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/dist:/input:ro" \
  motomind-smoke /input/Motomind-Motor-Setup-0.1.0-linux-amd64.AppImage
```

The smoke check copies the AppImage into a different path containing spaces,
unsets development library paths, uses fresh XDG directories, steps a MuJoCo
model, lists CAN interfaces passively, and renders light/dark screenshots under
Xvfb with software OpenGL. Only the release directory is mounted: the source
checkout, Rust and developer's MuJoCo installation are inaccessible. It does
not transmit CAN frames or operate a motor. Hardware acquisition, firmware
flashing and real GPU/Wayland behavior require separate hardware validation.

## User data and host integration

- Recordings: `$XDG_DATA_HOME/motomind-motor-calib/runs/`, default
  `~/.local/share/motomind-motor-calib/runs/`.
- Firmware cache: `$XDG_CACHE_HOME/motomind-motor-calib/firmware/`, default
  `~/.cache/motomind-motor-calib/firmware/`.
- CAN operation locks: the user data directory's `can-locks/`. Persistent lock
  files deliberately keep a stable inode across GUI/SSH sessions and versions;
  kernel file locks are released when a process exits. Do not delete these files
  while an operation is running.
- Existing egui preferences retain their original application identity.
- Previous recordings in a source checkout's `runs/` remain untouched and can
  still be opened by absolute path. No automatic movement or deletion occurs.
- Close older development versions before using this package: they used
  checkout-local CAN locks and cannot coordinate with the new data-directory lock.

CAN discovery uses rtnetlink and verifies the link kind is `can`, excluding
`vcan` and `vxcan`. System appearance is read through the XDG Settings portal
using native D-Bus calls; if unavailable the window system/egui fallback applies.
Neither integration requires `ip`, `gdbus` or `gsettings` executables.

The host still provides the USB-CAN kernel driver and configured CAN interface.
The AppImage does not change permissions, install drivers or configure bitrate.
Normal operation runs as a regular user. A future privileged CAN setup helper
would need its own system installation and authorization policy.

Diagnostic commands (no motor commands): `--version`, `--list-can`, `--self-check`.
The last creates and removes a small recording-directory probe, loads/steps
MuJoCo, and reports the resolved data/cache/lock paths, system theme and CAN list.

## Updating dependencies

Update both architecture entries in `downloads.json` together, using upstream
release digests. Keep the MuJoCo version synchronized with `mujoco-rs`, `build.rs`
and `engine::VERSION`. Updating glibc requirements requires an explicit change
to the supported baseline, package assertion and release notes.

Upstream references:
- https://docs.appimage.org/reference/best-practices.html
- https://github.com/AppImage/appimagetool
- https://github.com/AppImage/type2-runtime
- https://github.com/google-deepmind/mujoco
- https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Settings.html
