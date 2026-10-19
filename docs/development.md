# Developer guide

[User documentation](../README.md) · [Identification](identification.md) ·
[Protocol](protocol.md) · [Release packaging](../packaging/README.md)

## Build and run

Use Linux, Rust 1.95 or newer, and a C compiler/linker. CI pins Rust 1.98.1.
On Ubuntu/Debian:

```sh
sudo apt-get install build-essential pkg-config libxkbcommon-x11-0 \
  libxcb-xkb1 libgl1 libegl1 libwayland-client0
./scripts/setup.sh
./scripts/run.sh
```

| Item | Behavior |
|---|---|
| Toolchain | `setup.sh` installs a workspace-local Rust if needed; `run.sh` selects it |
| Dependencies | `Cargo.lock` pins crates; Cargo downloads matching MuJoCo to `.tools/mujoco/` |
| Library loading | Development uses the download path; release builds need MuJoCo packaged beside the app |
| App identity | Executable: `motor-setup-tool`; desktop ID: `com.motomind.MotorSetup` |

Data, cache, CAN locks, and window settings retain their v0.1.0 locations.
Keep the lock directory name so old and new binaries share bus ownership.

Opening the app does not start motor motion. Use a real saved run to work on
results/UI without hardware:

```sh
./scripts/run.sh --open=/path/to/run
```

## Checks

With Cargo on `PATH`:

```sh
rustup component add rustfmt clippy
./scripts/check.sh
```

If using the workspace-local toolchain, first set:

```sh
export CARGO_HOME="$PWD/.tools/cargo"
export RUSTUP_HOME="$PWD/.tools/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
```

`check.sh` runs formatting, Clippy with warnings denied, and unit tests. These
cover protocol, command limits, replay, fitting, acceptance, cancellation, and
theme contrast without sending physical CAN frames. The ignored `vcalwatch`
test needs an isolated virtual CAN interface.

| Workflow | Trigger | Output |
|---|---|---|
| [Unit tests](../.github/workflows/tests.yml) | Main, pull request, manual | Checks in the Ubuntu build container |
| [Desktop release](../.github/workflows/release.yml) | Matching version tag | Linux DEB/RPM, macOS DMG, Windows EXE |

For the same environment locally:

```sh
docker build -f packaging/Dockerfile -t motomind-packager .
docker run --rm --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/work/.tools/ci-cargo -v "$PWD:/work" \
  motomind-packager bash scripts/check-ci.sh
```

The Test tab shares calibration's CAN lock and watchdog. Its worker renews a
250 ms intent lease from UI frames. Releasing Jog commands zero speed; loss of
UI authority disables the motor. Opening a view never enables it.

## Code map

| Module | Responsibility |
|---|---|
| `app.rs`, `theme.rs` | UI, worker events, plots, shared appearance tokens |
| `cli.rs`, `can_admin.rs` | Headless commands, signal cancellation, system authentication for CAN setup |
| `manual.rs` | Live feedback, manual enable/jog, UI heartbeat and jog limits |
| `hardware.rs` | SocketCAN discovery, acquisition, stop conditions, bus ownership |
| `protocol.rs`, `firmware.rs` | Frame encoding/decoding and firmware transfer |
| `types.rs`, `experiment.rs` | Profiles, configuration, motion generation, progress |
| `fit.rs` | Training-only parameter estimation |
| `engine.rs` | Native MuJoCo models and command-history replay |
| `pipeline.rs` | Input validation, acceptance, reports, and exports |
| `bridge.rs`, `paths.rs` | Artifact I/O and user directories |

The UI sends work to a background worker. The motor loop owns timing and
cancellation; rendering stays outside it. Recording and fitting emit typed
progress events. Plots share `styled_plot` styling and legends.

## Changes that affect results

Keep these invariants when changing acquisition or fitting:

- Identify and validate the motor's firmware family before enabling it.
- Preserve the zero-torque watchdog preflight, limits, stale-feedback checks,
  cancellation, and stop-on-exit behavior.
- Record the transmitted, quantized command and its timestamp. Replay recorded
  commands rather than regenerating waveforms from current settings.
- Use training data to select parameters. Validation data must not select a
  seed, tune a parameter, or choose between candidates.
- Keep original saved profiles and samples intact. Refitting may replace
  analysis artifacts, but must not silently rescale measurements.
- Export accepted calibration files only when the acceptance checks pass.

Use the [protocol reference](protocol.md) when adding a model or changing wire
ranges, and the [identification reference](identification.md) for solver and
replay behavior.

## Visual review

Capture the native UI with a working desktop display:

```sh
./scripts/run.sh --open=/path/to/run --screenshot=/tmp/light.png --screenshot-theme=light
./scripts/run.sh --open=/path/to/run --screenshot=/tmp/dark.png --screenshot-theme=dark
```

The capture process closes after saving. These commands only open saved data.
Check graph legends, axis labels, units, clipping, and both theme palettes.
For fitting progress, use a copy of a real run because refit rewrites artifacts:

```sh
./scripts/run.sh --refit=/path/to/copied/run \
  --screenshot=/tmp/fitting.png --screenshot-during-fit
```

This captures the progress bar, then lets fitting finish before closing.
Screenshot theme overrides affect only the capture process. System appearance
comes from the XDG Settings portal over D-Bus, with the window system/egui
fallback when unavailable. Fonts and branding are embedded; see
[asset provenance and licenses](../assets/README.md).

## CLI and compatibility

See the [CLI guide](cli.md) for commands and scripting. GUI and CLI share the
same CAN lock; only the host's `ip` command is elevated for CAN setup. Legacy
options such as `--open`, `--refit`, and `--self-check` remain available in
`./scripts/run.sh --help`. Use `--screenshot-tab=calibrate|test|motor|files`
to capture a specific view; selecting Test starts no motion.
