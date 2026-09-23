# Command-line guide

The same AppImage works in a terminal or over SSH. Subcommands never open a
window and do not need a display server. Run without arguments for the GUI.

```sh
tool=./motor-setup-tool-0.1.3-linux-amd64.AppImage
"$tool" --help
"$tool" calibrate --help
```

Use your architecture's filename. If FUSE is unavailable, set
`APPIMAGE_EXTRACT_AND_RUN=1`. A source build also supports these commands through
`./scripts/run.sh` or `target/release/motor-setup-tool`.

## Connect

```sh
"$tool" can list
"$tool" can up can0
"$tool" scan --can can0
"$tool" info --can can0 --id 127
```

`can up` configures a down interface at **1 Mbps**, using sudo's terminal prompt.
Use `--auth polkit` for the desktop password dialog, or `--auth direct` from an
already privileged shell. Without a terminal, sudo fails unless authorization
is already available; passwords are never read or stored by this tool.
`can restart can0` resets an idle bus. Motor operations share a lock with the
GUI, so close its active monitor or calibration before using the CLI.

Use the ID returned by scan. The host ID defaults to 253; `--host-id` changes it.
Identity queries and scans disable responding motors. Use an idle bench bus.

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

Optional calibration arguments: `--output NEW_DIRECTORY`, `--train-seconds`,
`--validation-seconds`, `--torque-limit`, `--speed-limit`, `--travel-limit`.
Limits use Nm, rad/s, and radians and are checked against the detected model's
bench limits. Existing output directories are rejected. Without `--output`,
recordings use the same data directory as the GUI.

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
