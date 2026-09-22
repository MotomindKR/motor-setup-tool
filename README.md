# Motomind Motor Calibration / Setup

Native Rust / egui workbench for bare RobStride actuators. Estimates **output-side armature inertia, viscous damping, dry friction, and effective delay**, assuming correct commanded torque. Motor strength and PD-gain calibration are deliberately deferred.

The entire application, acquisition loop, optimizer, and simulation replay run in Rust. **[mujoco-rs 6.1.0](https://docs.rs/mujoco-rs/6.1.0+mj-3.12.0/mujoco_rs/) calls MuJoCo 3.12.0 directly. There is no Python runtime requirement.**

## Download

Download **amd64** (Intel/AMD) or **arm64** (64-bit ARM) from
[GitHub Releases](https://github.com/MotomindKR/motor-setup-tool/releases).
The AppImage requires Linux with glibc 2.35 or newer (Ubuntu 22.04 baseline) and a desktop OpenGL driver.
Rust, Python and a separate MuJoCo installation are not required.
Make the downloaded file executable and launch it. If FUSE is unavailable, prefix
its launch command with `APPIMAGE_EXTRACT_AND_RUN=1`.

## Run from source

Linux, Rust 1.95 or newer, a C compiler/linker, and desktop OpenGL libraries are required. On a fresh checkout:

On Ubuntu/Debian, desktop prerequisites can be installed with `sudo apt-get install build-essential pkg-config libxkbcommon-x11-0 libxcb-xkb1 libgl1 libegl1 libwayland-client0`. The launcher also recognizes workspace-local desktop libraries under `.tools/system-libs/`.

```bash
./scripts/setup.sh
./scripts/run.sh
```

Setup installs a workspace-local Rust toolchain if needed. Cargo downloads the matching MuJoCo shared library with upstream checksum verification into `.tools/mujoco/`. `Cargo.lock` pins Rust dependencies. The local binary includes a library search path to that location. Release builds use a relative library path and ship MuJoCo inside the AppImage; see [Linux packaging](packaging/README.md).

Select an available CAN bus, click **Scan**, and choose a detected motor. Its firmware family selects the model and its single preset automatically. Only real motor recordings can be captured, opened, or refitted. Unknown or unreadable firmware blocks calibration. The interface list refreshes every three seconds and excludes virtual CAN buses. It displays down buses without changing system network settings.

```bash
# Open the UI and discover motors on a chosen bus (no enable command)
./scripts/run.sh --connect=can0

# Open saved graphs, without contacting hardware
./scripts/run.sh --open=/absolute/path/to/runs/RUN

# Refit a recorded session without moving a motor
./scripts/run.sh --analyze=/absolute/path/to/runs/RUN

# Run the same identity and firmware scan as the GUI, without opening a window
./scripts/run.sh --scan=can0
```

## Hardware workflow

Use a rigidly mounted housing, unloaded shaft, correctly powered motor, and configured Linux SocketCAN adapter. The application expects **the current RobStride 29-bit extended-frame private protocol**, not the alternate packed MIT protocol. A CAN ID/UUID response alone does not identify the model: scanning also reads firmware and maps its `0.N.x.y` family to RS-0N. Unsupported version formats remain unknown; calibration rechecks the family before enabling the motor.

For example, bring up an already connected 1 Mbps interface separately:

```bash
sudo ip link set can0 up type can bitrate 1000000
```

1. Select an available CAN interface in **Connection**, then **Scan**. Scanning probes IDs 1–254 (excluding the host), queries firmware on responding motors, and never enables a motor. Select the discovered model/ID. Firmware queries use type 4 and may stop a responding motor; scan on an idle bench bus. Changing the bus or host ID clears the previous discovery and limit review.
2. Review the wire profile and experiment limits. All built-in RS-00–RS-06 presets now follow the **official July 13, 2026 manuals**, private CAN types 1 and 2; RS-00 uses **±33 rad/s and ±14 Nm**. See the [profile table and pinned sources](docs/protocol.md). Exact ranges are available in **Motor setup → CAN protocol**. The detected model supplies the documented wire ranges automatically; these are read-only in the UI. Historical recordings preserve their original profiles. Wire ranges are not operating limits.
3. Optionally use **Set current position as zero** or enter **New ID → Apply**. Both disable the selected motor and require stationary feedback. Zero is verified against position feedback. ID changes probe the destination for collisions and verify the same UUID at the new ID. No broadcast writes, zeroing, ID changes, or flash saves happen during scanning or calibration. Zero persistence depends on firmware; the app sends type 6 and does not issue a separate flash save.
4. Set conservative torque, speed, travel, and temperature limits. Check the mount/stop/model acknowledgement, then **Start calibration**. Only the selected motor is enabled. Keep other controllers off this interface during the experiment; no software scan can reliably distinguish two devices sharing one CAN ID.
5. Compare **Held-out validation** graphs first. Training and validation tabs show measured, pre-calibration MuJoCo, and post-calibration MuJoCo position/velocity, RMSE, and optional residuals. Toggle lines and zoom/pan the plots. The report identifies the recorded motor independently of the current UI selection.

The default baseline is an editable illustrative starting model, **not manufacturer inertia/friction data**. Each motor needs its own recorded run and appropriate torque limits; there is no automatic multi-motor excitation.

### Experiment and stopping behavior

- All operation commands set onboard **Kp = Kd = 0**. A bounded host velocity-feedback law creates multiple speed plateaus, reversals, and torque perturbations. Its gains are acquisition settings, not PD parameters being calibrated. Simulation replays the **recorded quantized torque**, not the acquisition controller.
- The training motion differs from the sinusoidal validation motion. Validation measurements never enter parameter fitting.
- The app programs operation mode `0x7005 = 0` and a nonzero command watchdog `0x7028 = 2000` raw firmware ticks, reads both back, and verifies watchdog expiry with a zero-torque enable before starting excitation. It requires reset mode after 300 ms without commands, rather than assuming one timeout tick duration across firmware versions. It leaves operation mode and this nonzero watchdog setting in place; it does not save them to flash.
- Enable consumes the preceding zero-command acknowledgement, then waits up to 100 ms for Run feedback while requesting fresh status with zero-gain, zero-target-torque commands. Intermediate Reset feedback does not fail the check. Any reported motor fault still aborts immediately. Failures include the observed mode/fault bits, and the watchdog expiry check remains mandatory.
- Acquisition stops on a motor fault/mode change, speed/travel/temperature limit, implausible encoder jump, CAN error, 50 ms without feedback, or a missed command deadline exceeding 25 ms. The command loop is a desktop scheduling loop, not a hard real-time guarantee.
- **STOP / cancel** stops an active acquisition or cancels fitting. **Disable motor** is available when a discovered motor is selected and the app is idle and verifies stopped-mode feedback. Closing the window cancels and joins the worker. Acquisition has a stop-on-exit guard; the firmware watchdog covers loss of host commands. A physical emergency stop remains necessary for a bench motor. A disconnected bus cannot deliver a software stop.
- Disable can allow the output to coast. The app waits for stationary feedback before the next trace. Travel limits are relative to each trace's start; they are not discovered joint limits.
- Real RS-05 recordings have been collected (initially mislabeled as RS-00), but the current fit has not passed held-out validation. Other models still need bench verification. ID/zero settings are user-triggered actions.

**Scan** reads the documented type-4 firmware version reply for each responding motor. Capture saves this information and blocks missing, unknown, or mismatched firmware families before enabling. Version replies are excluded from motion feedback, failed parameter reads are rejected, and type-21 motor faults (including driver faults) stop acquisition.

For a stopped firmware check from the terminal:

```bash
./scripts/run.sh --firmware=can0 --motor-id=7
```

## Identification

The fitted mechanical equation is `J * acceleration = delayed_command - b * velocity - friction` (MuJoCo implements friction as a constraint). All quantities are in gearbox-output coordinates. Torque gain is fixed at one. This identifies an **effective** inertia/friction model conditional on the torque assumption; it does not independently establish torque accuracy or validate behavior under robot loads.

During capture (after sufficient movement) and before fitting, the app compares position changes with integrated velocity in 200 ms windows. A scale disagreement greater than 10% rejects the recording and reports a suggested speed range conditional on correct position units. It never silently rescales recorded data. This check cannot verify torque scale.

Identification fits inertia, viscous damping, constant friction and effective delay. Moving 40 ms integration windows seed the fit and a 0–50 ms delay search; short MuJoCo windows above 0.3 rad/s refine that seed. Final refinement fits the **complete continuous training trajectory**, including stops and reversals, from both the integral and moving-window seeds. The training objective combines velocity residuals with position residuals weighted by 0.3 /s, normalized by training velocity standard deviation. It retains the moving seed if neither refinement improves that objective. Reports preserve the seed and before/after objective values. Held-out data never chooses parameters or starting estimates. Breakaway calibration remains deferred: new fits have no separate static-friction peak. Validation thresholds are unchanged.

Each motor has **one calibration preset**, scaled from its documented ratings. The default **40 s training / 20 s validation** suite combines paired speed steps, a **0.15–8 Hz sweep**, multisine, direct torque bursts at 20–100% of the torque limit, and coast-down. Speed targets reach 75% of the configured cutoff. The preset uses the existing bench torque cap, a speed cutoff of 45% of the smaller of no-load speed and the wire range, and ±24 rad travel. For RS-00: **1.25 Nm**, **14.844025288211773 rad/s cutoff**, and **±11.13301896615883 rad/s requested speed**. New excitation brakes above 85% of the speed cutoff; independent hardware cutoffs remain active. Actual motion depends on the motor. Old recordings retain their original commands and excitation revision.

The **Test** tab shows the model preset and Start button; **Advanced** contains manual limits, timing, sweep and baseline controls. **Connection** contains bus and motor selection; **Motor setup** contains zero/ID and firmware functions. **Files** opens or refits recordings. Results have Motion, Residuals and Torque views; parameters and diagnostics are collapsed. No hardware motion starts automatically. See [measurement details](docs/identification.md).

Model-specific rated/peak torque, no-load speed, gearing and voltage come from the [July 2026 product specifications](https://github.com/RobStride/Product_Information/blob/main/README.md). The UI shows these separately from wire ranges. Bench caps are app policy: the smaller of 25% rated or 10% peak torque, and the smaller of 50% nominal no-load speed or 50% wire speed. Selecting a discovered motor or clicking **Restore motor preset** sets a smaller starting envelope. Ratings require the manufacturer's cooling conditions; these percentages are not manufacturer-approved safety limits. Existing valid test limits remain unchanged at startup.
Commands and observations have separate host-monotonic timestamps. Commands are replayed as zero-order holds. Simulation steps stop at delayed command boundaries and observation times, with a maximum 1 ms step. Full before/after and held-out replays initialize state only once; they never correct simulation drift from observations. Only training identification uses short windows initialized from measured state. The effective delay includes transmit scheduling, CAN, firmware, feedback filtering and reception. This version cannot separate those contributions or independently resolve delay below the feedback interval.

Acceptance requires optimizer convergence, adequate parameter separation, no delay-boundary hit, no material worsening of either held-out RMSE, and a held-out velocity RMSE below the larger of 0.05 rad/s or 20% of measured RMS velocity. These are initial engineering acceptance thresholds, not confidence intervals. Inspect residuals and repeat runs; temperature/load-dependent friction, asymmetric friction, compliance and backlash are outside the first model.

## Artifacts and applying to your robot

Every run gets an independent `$XDG_DATA_HOME/motomind-motor-calib/runs/TIMESTAMP-PID/` directory (by default `~/.local/share/motomind-motor-calib/runs/`):

| File | Contents |
|---|---|
| `config.json` | Selected ID, model wire ranges, limits, baseline |
| `hardware.json` | Hardware-only identity, queried firmware version (or unknown), and wire profile |
| `session.json` | Source (`hardware`), actual command history, feedback, completion flag |
| `report.json` | Parameters, staged-fit diagnostics, acceptance, warnings and comparison traces |
| `experiment_plan.json` | Phase schedule, selected limits, sweep frequencies and motor specifications |
| `replay_wrapper.py` | Optional robot-side MuJoCo helper for delay and velocity-dependent friction |
| `training.csv`, `validation.csv` | Exportable measured / before / after graphs |
| `pre_calibration.xml` | Baseline bare-motor MuJoCo model |
| `candidate.json`, `candidate.xml` | Fitted candidate, including rejected results |
| `calibration.json`, `post_calibration.xml` | Created only after held-out acceptance |

Hardware acquisition failures also save `error.json`, including failures before recording starts. Aborted acquisitions retain partial data with `complete: false` when a recording exists; fitting refuses them. Rejected refits remove stale accepted exports. Graph artifacts are saved automatically; fitting does not write firmware calibration constants.

For an existing robot MJCF, apply `parameters.armature` to joint `armature`, `parameters.damping` to joint `damping`, and `parameters.friction` to joint `frictionloss`. Avoid adding inertia or friction already represented elsewhere. The standalone XML has only a negligible numerical body inertia, not a robot link. See the [MuJoCo XML reference](https://mujoco.readthedocs.io/en/stable/XMLreference.html).

**XML alone does not implement delay.** Use the exported `replay_wrapper.py` (Python MuJoCo) or the equivalent code in `src/engine.rs`. The wrapper splits integration at delayed command boundaries, matching the Rust replay. New fits use constant joint frictionloss (`static_friction = 0`). Existing recordings with a static-friction peak remain replayable through the wrapper. Apply delay once; do not duplicate host delay already present in your robot stack. The native Rust app does not require Python; the optional wrapper is for downstream simulation.

## Development

```bash
# If using the workspace-local toolchain:
export CARGO_HOME="$PWD/.tools/cargo"
export RUSTUP_HOME="$PWD/.tools/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo fmt --check
```

Code is split into `app` (egui), `hardware` (SocketCAN and acquisition), `protocol` (wire encoding), `engine` (mujoco-rs stepping), `fit` (identification), `pipeline` (validation and exports), and `bridge` (artifact I/O). Tests exercise wire commands, input rejection, real MuJoCo inertia/delay behavior, hidden-parameter recovery, held-out rejection, cancellation, and headless egui rendering.

An optional UI screenshot smoke test needs a working desktop display:

```bash
./scripts/run.sh --open=/absolute/path/to/runs/RUN --screenshot=/tmp/motor-calibration.png
```

The window saves its own screenshot and closes. This path never enables hardware.

The Motomind theme follows system light/dark appearance and embeds the official SVG logo and Pretendard 400/600/700. Physical values use tabular bold numerals with compact display precision (2 decimals for limits, 3 for errors, 6 for fitted parameters); saved data retains full precision. Hover a headline error value to inspect its full value. Colors and component styling are centralized in `src/theme.rs`. The UI is English-only; localization is deferred. Asset sources, font license, and the numeric-font build script are documented in [assets/README.md](assets/README.md).

## Firmware updater

After scanning and selecting a detected motor, open **Motor setup → Firmware update**, then click **Download and verify firmware**. The app shows the
installed and target versions before **Update model · ID** starts flashing.
The bundled official catalog is release **V26.05.19** (RS-00 through RS-06).
Each image is checked against its published SHA-256 before any OTA command.
The app checks the firmware family and motor UUID again immediately before
writing. Downloads are cached in `$XDG_CACHE_HOME/motomind-motor-calib/firmware/` (by default `~/.cache/motomind-motor-calib/firmware/`).

The native updater follows RobStride's [OTA protocol and reference implementation](https://github.com/RobStride/Product_Information/tree/main/OTA).
It stops the motor, sends acknowledged 8-byte packets with bounded retries and
resume handling, then verifies the restarted firmware version and unchanged UUID.
It never enables the motor. Keep DC power and USB connected until completion;
Stop/cancel and window closing are disabled during flashing. Other operations
are excluded, including another instance of this app using the same interface.
Close other CAN tools before updating. Update records and acknowledgements are
saved in the user data directory under `runs/` as `firmware_update.json` and `ota_ack.jsonl`.

An interrupted transfer may require the vendor OTA recovery procedure; this UI
requires a responsive application to identify the motor before starting.
Transfer acknowledgement alone is not reported as success: version readback
must match. A successful update does not imply watchdog validation passed;
calibration still performs its independent zero-torque watchdog preflight.

The same updater can be used from the terminal (this starts flashing):

```bash
./scripts/run.sh --update-firmware=can0 --motor-id=127 --model=RS-00
```

## Progress and appearance

Recording has a time-based progress bar spanning training and validation, with the current motion segment and elapsed time. Fitting has a separate bar covering the delay search, moving-window fit, both trajectory refinements, MuJoCo validation replays, and saving. Fitting progress measures stages and iteration budgets, not time-to-convergence. Early convergence advances to the next stage. Stop stays above the scrollable plots; firmware writing continues to block cancellation.

The app follows system appearance automatically. On Linux it reads the desktop portal's `org.freedesktop.appearance/color-scheme`, through native D-Bus, with the window system preference as fallback. A bounded background worker checks for changes every two seconds; it does not share the motor worker. Both palettes, font styles and component tokens live in `src/theme.rs`. Text contrast is checked against the page, card and muted surfaces in both modes. English is the only UI language for now.

For repeatable visual review:

```bash
./scripts/run.sh --open=/path/to/real/run --screenshot=/tmp/calibration-dark.png --screenshot-theme=dark
./scripts/run.sh --open=/path/to/real/run --screenshot=/tmp/calibration-light.png --screenshot-theme=light
# Refit updates artifacts in this folder; use a copy when reviewing progress.
./scripts/run.sh --refit=/path/to/copied/real/run --screenshot=/tmp/fitting.png --screenshot-during-fit
```

Screenshot theme overrides apply only to the capture process and never change desktop settings. A progress screenshot waits for fitting, captures the active bar, then lets the job finish before closing.
