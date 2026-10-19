# Command-line guide

The Rust backend runs without a window or display server. The examples below
use the installed Linux DEB/RPM path; source builds can use
`target/release/motor-setup-tool` or `./scripts/run.sh`.

```sh
tool="/opt/Motor Setup Tool/resources/backend/motor-setup-tool"
"$tool" --help
"$tool" calibrate --help
```

On macOS, the backend is inside `Motor Setup Tool.app/Contents/Resources/backend/`.
On Windows, it is `resources\backend\motor-setup-tool.exe` inside the installed
application directory.

## Connect

```sh
"$tool" can list
"$tool" can up can0
"$tool" scan --can can0
"$tool" info --can can0 --id 127
```

| Transport | Find it | `--can` example |
|---|---|---|
| SocketCAN (Linux) | `can list` | `can0` |
| SLCAN | `can serial-list` | `slcan:canable:921600:/dev/ttyUSB0` or `slcan:canable:921600:COM3` |
| GS USB | `can usb-list` | `gsusb:3:79` (use listed bus/address) |

SLCAN also supports the `lawicel` profile; both serial and direct USB modes
configure Classic CAN at 1 Mbps when opened. A GS USB address can change after
reconnection. See [USB access](user-guide.md#direct-gs-usb-adapters) for Linux
permissions.

`can up` configures an idle SocketCAN interface at 1 Mbps. It uses sudo in a
terminal; use `--auth polkit` for a desktop dialog or `--auth direct` in an
already privileged shell. `can restart can0` resets an idle bus. GUI and CLI
operations share a lock. Scans and identity queries can disable responding
motors, so use an idle bench bus. Use the ID returned by scan; host ID defaults
to 253 and can be changed with `--host-id`.

## Calibrate and analyze

```sh
"$tool" plan --model RS-00
"$tool" calibrate --can can0 --id 127 --yes
"$tool" analyze /path/to/recording
```

`plan` prints the model's single preset without contacting hardware.
Calibration detects the connected model from firmware, checks the watchdog,
records 40 seconds of training and 20 seconds of validation, then fits and
replays MuJoCo. `--yes` confirms the motor is secured, the shaft is clear, and
the preset limits have been reviewed. Ctrl+C cancels acquisition or fitting;
active motor control stops before exit.

| Option | Purpose |
|---|---|
| `--output NEW_DIRECTORY` | Save to a new directory; existing paths are rejected |
| `--train-seconds`, `--validation-seconds` | Set recording durations |
| `--torque-limit`, `--speed-limit`, `--travel-limit` | Set Nm, rad/s, and rad limits within the model's bench caps |

Without `--output`, recordings use the GUI's data directory.

Artifacts and acceptance rules are identical to the GUI. Open the resulting
directory from **Files** to view graphs. `analyze` replaces analysis artifacts
in an existing real recording. It does not contact a motor.

## Monitor and jog

```sh
"$tool" monitor --can can0 --id 127 --seconds 10
"$tool" jog --can can0 --id 127 --speed 0.5 --seconds 2 --yes
"$tool" jog --can can0 --id 127 --speed -0.5 --seconds 2 --yes
"$tool" stop --can can0 --id 127
```

Monitoring keeps the motor disabled and prints feedback at up to 10 Hz. Omit
`--seconds` to monitor until Ctrl+C. Jog speed is output-shaft rad/s. Jog uses
the GUI's torque, speed, travel, stale-input, and firmware-watchdog checks;
each CLI jog is limited to 30 seconds and disables on completion or interruption.
Its duration starts after the enable handshake finishes.

## Setup and firmware

```sh
"$tool" zero --can can0 --id 127 --yes
"$tool" set-id --can can0 --id 127 --new-id 7 --yes
"$tool" firmware check --can can0 --id 7
"$tool" firmware update --can can0 --id 7 --yes
```

Zero requires a stationary motor. ID changes check for collisions and verify
the motor identity. Firmware check uses the bundled verified release catalog;
update downloads and verifies the matching image. Keep power connected until
the update finishes. Once firmware transfer starts, termination requests wait
for it to finish rather than interrupting a flash write.

## Scripts

Results are JSON on stdout; progress and errors are on stderr. Monitor and jog
emit one JSON object per feedback sample. A failed command exits nonzero;
invalid arguments exit with code 2. Calibration's `accepted` field indicates
whether validation passed; successful command completion alone does not imply
an accepted fit. Machine-readable values retain full precision.

```sh
"$tool" calibrate --can can0 --id 127 --yes > result.json
"$tool" monitor --can can0 --id 127 --seconds 10 > feedback.jsonl
```

Ctrl+C, SIGTERM, and SIGHUP request cancellation. A software stop still depends
on a working CAN link; keep a physical stop available when running motion.
