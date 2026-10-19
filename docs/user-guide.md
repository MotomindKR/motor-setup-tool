# User guide

[Download and quick start](../README.md) · [MuJoCo exports](simulation.md)

**Jump to:** [Connection](#connect-a-motor) · [Calibration](#run-calibration) ·
[Results](#compare-the-result) · [Test and jog](#monitor-and-jog-a-motor) ·
[Firmware](#update-firmware) · [Troubleshooting](#troubleshooting)

## Connect a motor

Before scanning:

1. Secure the unloaded motor housing and clear the shaft.
2. Connect the correct power supply, CAN-H to CAN-H, and CAN-L to CAN-L.
3. Check grounding and termination against the adapter and motor manuals.
4. Close other motor-control applications.

| Adapter mode | Available on | Select in Connection |
|---|---|---|
| SocketCAN | Linux | A CAN interface such as `can0` |
| GS USB | Linux, macOS, Windows | A detected USB adapter |
| SLCAN | Linux, macOS, Windows | Serial port, protocol profile, and UART speed |

### SocketCAN on Linux

Select the interface and click **CAN up** to configure a down bus at 1 Mbps.
An active interface offers **Restart CAN**. The system authentication dialog
requires `iproute2`, `pkexec`, and a desktop authentication agent; the app does
not handle the password. If these are unavailable, configure an idle bus in a
terminal:

```sh
ip -details link show type can
sudo ip link set can0 down
sudo ip link set can0 up type can bitrate 1000000
```

Replace `can0` and the bitrate as needed. Run the app as your normal user.

### Direct GS USB adapters

Select **GS USB**, choose the USB adapter, then scan. This mode uses the GS USB
protocol directly. On Linux, it temporarily detaches the `gs_usb` kernel
driver; when returning to SocketCAN, click **CAN up** again.

On Linux, grant your desktop user USB access once, then reconnect the adapter:

```sh
sudo install -m 0644 "/opt/Motor Setup Tool/packaging/99-motomind-gsusb.rules" /etc/udev/rules.d/
sudo udevadm control --reload-rules
```

If **USB access denied** remains, reconnect the adapter after loading the rule.
Refresh the list after reconnecting because its USB address may change.

### SLCAN serial adapters

Select **SLCAN**, then choose a detected port (or **Enter manually…**), the
LAWICEL or CANable profile, and the adapter's UART speed. The app configures
Classic CAN at 1 Mbps when it opens the port.

### Scan

In **Connection**, choose the bus, click **Scan**, then choose the discovered
motor. The app reads its firmware to select the model and calibration preset.
Use an idle bus: scanning can stop responding motors. Each motor needs a unique
CAN ID. An unknown or unreadable firmware version blocks calibration.

## Run calibration

1. Select **Calibrate**. Review maximum torque, speed cutoff, requested speed, and travel.
2. Open **Motion preview** to see the requested speed and torque bursts. These
   are test inputs, not predictions of the motor's response.
3. If needed, adjust limits and recording duration under **Advanced**. **Restore
   motor preset** restores the selected model's settings.
4. Check **Motor secured · limits reviewed** and press **Start calibration**.
5. Wait for recording, fitting, and validation to finish. The default recording
   contains 40 seconds of training and 20 seconds of separate validation.

The motion suite uses speed steps, sweeps, torque bursts, and coast-down.
**Stop** cancels the job. Limits, communication errors, and motor faults also
stop acquisition. A disabled motor may coast, and a software stop cannot reach
a disconnected bus; keep a physical stop accessible.

## Compare the result

Start with **Validation**. These measurements were not used to choose the fitted
parameters. **Training** shows the recording used for fitting.

| View | What it shows |
|---|---|
| Motion | Measured position/velocity and MuJoCo before/after calibration |
| Residuals | Simulation minus measurement; zero means agreement |
| Torque | Commanded torque and motor-reported torque |

| Check | Meaning |
|---|---|
| Error cards | Fitted RMSE and change from the editable baseline |
| Fitted parameters | Estimated values, with full precision in saved files |
| Diagnostics | Rejection reasons and model limitations |

Use the graph controls to show or hide traces. A reference angle changes the
displayed position; fitting and residuals still use raw motor coordinates.
`report.json` stores the motor UUID and reference angle; accepted
`calibration.json` files do too.

Rejected fits remain available for inspection but have no accepted exports.
Check **Diagnostics** before recording again. A bare-motor fit does not predict
behavior with a robot load.

## Set zero or change the ID

Select the motor, then use **Test** or **Setup**:

- **Test → Set current position as zero** makes the current shaft position the zero
  reference. The app stops the motor and checks that it is stationary first.
  Monitoring stops before the zero is written. Persistence across power cycles
  depends on the firmware.
- To show a chosen angle at the present shaft position, enter it under
  **Setup → Display angle at this position**, then select **Set current position**.
  The motor's firmware zero is set to 0; the app saves the displayed offset by
  the motor's eight-byte UUID. Live position and calibration reports carry this
  reference angle. The motor does not report this app offset to other software.
- Enter **New ID**, then **Change ID**. The app checks for an ID collision and verifies
  the same motor at its new address.
- The top bar shows **Connected · Enabled** or **Connected · Disabled**.
  **Disable motor** is available only while the selected motor is enabled.

### Persistent registers

Open **Setup → Persistent registers** after selecting a motor. Choose a register
and click **Read**. Gains and filters `0x2011`–`0x2017` can be edited within their
documented ranges; the speed and current limit registers are read only. Enter a
value and click **Save** to confirm the change. The app disables the motor,
checks its UUID and current value, writes the new value, and sends the motor's
save command. Power cycle and read again to verify the value persisted. Volatile
`0x70xx` control registers are absent from this editor.

## Monitor and jog a motor

1. Open **Test → Start monitoring**. The motor starts disabled. Live position,
   speed, torque, temperature, mode, and faults update; graphs retain 30 seconds.
   Stale or unavailable values show `--`.
2. Secure the housing, clear the shaft, choose a speed, and check
   **Motor secured · shaft clear**.
3. Click **Enable motor** and wait for the watchdog check.
4. Hold **Jog −** or **Jog +**. Release to command zero speed while keeping the
   motor enabled. Click **Disable motor** to turn torque off.

| Limit | Maximum |
|---|---|
| Speed | Lower of 1 rad/s and 10% of calibration speed limit |
| Torque | Lower of 10% rated torque and calibration torque limit |
| Travel | Lower of ±one output revolution from enable position and calibration travel limit |

Enabling alone commands zero torque. After a jog, the controller brakes toward
zero speed without holding a fixed position. Jogging also stops on monitor
stop, tab/window/focus change, stale input, missing feedback, faults, or exceeded
limits. The Test view reports communication and limit errors. Stop monitoring
before changing motors or setup. Monitoring saves no recording.

## Update firmware

The **Firmware update available** notice compares the selected motor against
the app's bundled, verified catalog. It works offline and does not track future
vendor releases or recommend downgrades.

1. Open **Setup → Firmware update** and select **Download and verify**.
2. Compare the installed and target versions and confirm the model and ID.
3. Start the update. The app disables the motor before checking the bus and
   starting transfer. Keep motor power and USB connected until it finishes.

The app blocks cancellation and window closing during the write. Success
requires a matching version readback and the same motor identity. An interrupted
transfer may require the vendor's recovery tools. After a verified update, the
selected motor stays selected and its displayed firmware version refreshes.

## Open and refit recordings

Recordings are saved automatically. In **Files**, enter a saved run folder and
choose **Open** to view it or **Refit** to rerun fitting without moving hardware.
Refit replaces analysis artifacts in that folder; copy the folder first if you
want to preserve the earlier result.

Default locations:

| Data | Location |
|---|---|
| Recordings and results | `~/.local/share/motomind-motor-calib/runs/` |
| Downloaded firmware | `~/.cache/motomind-motor-calib/firmware/` |

`XDG_DATA_HOME` and `XDG_CACHE_HOME` override these base directories. Use
**Copy folder path** for the current run. See [Simulation and exports](simulation.md)
for the files to use in your robot model.

## Troubleshooting

| Symptom | What to check |
|---|---|
| No CAN interface | USB connection, adapter driver, and whether Linux exposes a SocketCAN interface |
| Bus shown as Down or BUS-OFF | Stop other controllers, check power/wiring/termination/bitrate, then reconfigure the idle interface |
| Scan finds no motor | Motor power, matching bitrate, CAN wiring, and unique IDs |
| Unknown model or firmware | Read the installed version with the vendor's tool; unsupported version families cannot be calibrated |
| “No buffer space available” | Frames may not be draining from the transmit queue; investigate bus errors and acknowledgements before retrying |
| Watchdog preflight fails | Check the motor's firmware and close other CAN senders. A failed run saves `watchdog_preflight.json`; recent versions include a bounded CAN trace showing traffic during the quiet interval. Calibration requires the watchdog check to pass. |
| Another operation owns the bus | Finish or close the other app instance; do not delete its lock file |
| Fit rejected or residuals remain large | Read Diagnostics, verify a bare unloaded shaft and correct model, and inspect the measured motion |

Use **Settings → Appearance** to choose Light, Dark, or System.
