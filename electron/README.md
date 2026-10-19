# Electron app

Electron provides the windows, controls, and charts. A bundled Rust CLI process
handles CAN, motor control, firmware, calibration, and MuJoCo. Electron and the
native app share run files and CAN locks.

## Develop

From the repository root:

```sh
cargo build --locked
cd electron
npm ci
npm start
```

Run `npm run check` for JavaScript and IPC checks. The app looks for the release
Rust binary, then the debug binary; set `MOTOMIND_BACKEND` to override its path.
See the [developer guide](../docs/development.md) for MuJoCo setup and the
[user guide](../docs/user-guide.md#connect-a-motor) for CAN adapters. Saved runs
can be viewed without hardware.

## Desktop installers

```sh
cargo build --locked --release
cd electron
npm run package:installers
```

This produces DEB/RPM, DMG, or NSIS EXE installers in `dist-electron/`, each
with a `.sha256` file. Set `MUJOCO_DYNAMIC_LINK_DIR` if MuJoCo is outside
`.tools/mujoco/mujoco-3.12.0/lib`. See the [release guide](../packaging/README.md).

## Operation details

| View | Purpose |
|---|---|
| Calibrate | Review limits and motion preview, record a run, fit, and inspect results |
| Test | Monitor feedback and use bounded hold-to-jog controls |
| Setup | Set zero/reference angle, change ID, search and edit persistent registers in the main area, update firmware |
| Files | Open saved runs, compare traces, or refit |

Only one backend operation runs at a time. Stop signals the CLI, whose worker
disables the motor before exit. Opening the app or a recording sends no motor
command. Firmware transfer finishes before the window closes.

**Settings** shows the version, appearance mode, and updates. The update button
verifies and installs Linux and Windows updates when the motor is idle. macOS
opens the DMG for installation.
