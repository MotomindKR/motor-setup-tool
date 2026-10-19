# Electron app

This UI uses Electron for windows, controls, and charts. The existing Rust binary
performs all CAN operations, motor control, calibration, firmware updates, and
MuJoCo analysis through its CLI. It uses the same run files and CAN locks as the
native app. The native app and CLI remain available.

## Develop

On Linux, build the Rust backend and install Electron:

```sh
cargo build --locked
cd electron
npm ci
npm start
```

The app finds `target/release/motor-setup-tool` first, then `target/debug/motor-setup-tool`.
Set `MOTOMIND_BACKEND=/absolute/path/to/motor-setup-tool` for another build path.
The Rust build requires the pinned MuJoCo SDK described in the
[developer guide](../docs/development.md). If Node, npm, or Cargo are not on
`PATH`, use the workspace-local toolchains under `.tools/`.

Use `npm run check` to validate the JavaScript and IPC operation rules. The app
can display saved runs without a CAN adapter. On Linux, choose SocketCAN,
GS USB, or a SLCAN serial adapter; on macOS and Windows, choose GS USB or SLCAN. The serial adapter
must support extended Classic CAN at 1 Mbps. Select a detected serial port, or
choose **Enter manually…** if it is missing, then choose the LAWICEL or CANable
profile and UART speed before scanning. Review the limits before
issuing a motion command.

## Desktop installers

```sh
cargo build --locked --release
cd electron
npm run package:installers
```

The package script stages Electron, the release Rust binary, the pinned MuJoCo
library, and UI assets, then builds DEB/RPM, DMG, or NSIS EXE installers under
`dist-electron/`. Each installer gets a `.sha256` checksum. Set
`MUJOCO_DYNAMIC_LINK_DIR` when the SDK is outside
`.tools/mujoco/mujoco-3.12.0/lib`. No AppImage is produced.

## Operation details

- **Calibrate:** scans and identifies the motor, loads its Rust preset, previews
  the planned speed and torque trajectory, accepts the native advanced limits
  and baseline fields, then records, fits, and opens the saved report. Use
  **Save location…** for a native picker; the selected path must be new.
- **Test:** starts disabled-motor monitoring, displays live feedback and the last
  30 seconds of position, speed, and torque. After the motor is secured and
  fresh, healthy feedback arrives, Enable motor runs the same Rust watchdog
  preflight as the native UI. Hold Jog − or Jog + to move; release to stop
  motion while enabled. Disable motor or stop monitoring to disable it.
- **Setup:** zero, ID change, CAN restart, verified firmware download, and
  update. The motor zero command always sets the shaft's present position to 0;
  an optional reference angle is saved by motor UUID and applied to displayed
  positions. Closing the app waits for an active firmware transfer to finish.
- **Files:** opens completed real motor recordings, plots training and held-out
  validation traces, and can refit a selected run.

Only one backend operation can run at a time. A stop request sends SIGTERM to
the CLI, whose motor worker stops and disables before exiting. No motor command
is sent by opening the Electron app or loading a recording.

Settings shows the app version, checks the latest GitHub release, and downloads
the matching installer after verifying its checksum. Complete installation in
the system installer and restart the app. Installation is disabled while a motor
operation is active.
