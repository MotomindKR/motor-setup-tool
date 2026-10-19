# Motor Setup Tool

<img src="assets/motor-setup-tool.svg" width="96" height="96" alt="Motor Setup Tool icon">

[![Unit tests](https://github.com/MotomindKR/motor-setup-tool/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/MotomindKR/motor-setup-tool/actions/workflows/tests.yml)
[![Desktop release](https://github.com/MotomindKR/motor-setup-tool/actions/workflows/release.yml/badge.svg)](https://github.com/MotomindKR/motor-setup-tool/actions/workflows/release.yml)
[![Download Electron app](https://img.shields.io/badge/Download-Electron_app-E82E01)](https://github.com/MotomindKR/motor-setup-tool/releases/latest)

Calibrate a bare RobStride motor, compare its motion with MuJoCo, and manage
its ID, zero position, and firmware. Supports RS-00 through RS-06.

## Install

Get the latest installer from **[Releases](https://github.com/MotomindKR/motor-setup-tool/releases/latest)**.

| System | Installer |
|---|---|
| Linux x64 or ARM64 | `.deb` or `.rpm` |
| macOS Apple silicon | `.dmg` |
| Windows x64 | `.exe` |

MuJoCo is bundled. **Settings → Check for update** downloads and opens a
checksum-verified installer; finish installation in the system dialog.

## Your first calibration

You need a motor, its power supply, and a supported USB-CAN adapter. Secure the
housing, clear the unloaded shaft, and keep a physical stop available.

1. Power the motor and [connect CAN](docs/user-guide.md#connect-a-motor).
2. Select the adapter under **Connection**, click **Scan**, and select your motor.
3. Open **Calibrate**, review the limits, and check **Motor secured · limits reviewed**.
4. Select **Start calibration**. The app records, fits, and validates the result.
5. Open **Validation** to compare measured motion with the fitted model.

Accepted runs export `calibration.json` and `post_calibration.xml`. See the
[user guide](docs/user-guide.md#compare-the-result) to interpret graphs and
[simulation guide](docs/simulation.md) to use the exports.

## Documentation

| I want to… | Read |
|---|---|
| Connect, calibrate, or configure a motor | [User guide](docs/user-guide.md) |
| Operate from a terminal or over SSH | [CLI guide](docs/cli.md) |
| Use a result in MuJoCo | [Simulation and exports](docs/simulation.md) |
| Build, test, or change the app | [Developer guide](docs/development.md) |
| Understand the fitting method | [Identification](docs/identification.md) |
| Work on CAN or firmware support | [Protocol reference](docs/protocol.md) |
| Build or publish desktop releases | [Release guide](packaging/README.md) |
