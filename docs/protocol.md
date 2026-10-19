# RobStride protocol reference

[Developer guide](development.md) · [Identification](identification.md)

The app uses RobStride's 29-bit extended-frame private CAN protocol. Built-in
profiles follow communication types 1 (command) and 2 (feedback) in the pinned
July 13, 2026 manuals below. These encoding ranges are distinct from rated
motor specifications and calibration test limits.

## Wire ranges

| Model | Speed range (rad/s) | Torque range (Nm) | Pinned source |
|---|---:|---:|---|
| RS00 | ±33 | ±14 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS00/RS00User%20Manual260713.pdf) |
| RS01 | ±44 | ±17 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS01/RS01User%20Manual260713.pdf) |
| RS02 | ±44 | ±17 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS02/RS02User%20Manual260713.pdf) |
| RS03 | ±20 | ±60 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS03/RS03User%20Manual260713.pdf) |
| RS04 | ±15 | ±120 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS04/RS04User%20Manual260713.pdf) |
| RS05 | ±50 | ±5.5 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS05/RS05User%20Manual260713.pdf) |
| RS06 | ±50 | ±36 | [2026-07-13 manual](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/Product%20Literature/RS06/RS06User%20Manual260713.pdf) |


Position ranges are ±4π rad. Type-1 torque occupies ID bits 8–23; payload
position, velocity, Kp, and Kd are big-endian 16-bit values. Calibration sends
Kp = Kd = 0. Feedback uses the model's position/velocity/torque ranges;
temperature is an unsigned 16-bit value divided by ten.

`types::Profile` owns these ranges. Saved sessions retain the exact profile
used to acquire them. New captures use the discovered firmware family to
select the model. A manual revision does not identify the installed firmware.

## Discovery and identity

Discovery probes IDs 1–254, excluding the configured host ID. Type 0 returns
the motor identity. Each responding motor is then queried for its firmware:

- Request: type 4, host in ID bits 8–15, motor in bits 0–7, payload
  `00 C4 00 00 00 00 00 00`. This is a stop-class command.
- Response: type 2, motor as source, host as destination, prefix `00 C4 56`,
  four version components in bytes 3–6.
- Family mapping: `0.N.x.y`, with N from 0 through 6, selects RS-0N. Unknown
  formats remain unknown. Calibration rejects missing or mismatched families.

Version replies are excluded from motion feedback decoding. The recording
captures identity, firmware, and wire profile in `hardware.json`.

## Commands and faults

| Operation | Type / parameter | Behavior |
|---|---|---|
| Enable | Type 3 | Wait for Run feedback; faults abort |
| Stop | Type 4 | Request stopped mode |
| Set zero | Type 6, payload byte 0 = 1 | Stop, require stationary feedback, verify position |
| Change ID | Type 7, new ID in bits 16–23 | Check collision, stop, verify unchanged UUID at the new ID |
| Parameter read | Type 17 reply | Reject nonzero status in ID bits 16–23 |
| Motor fault | Type 21 | Decode little-endian 32-bit fault/warning fields; nonzero faults abort |

Warning-only type-21 reports are not treated as faults. CAN error frames are
received explicitly so bus faults are surfaced before repeated transmissions
fill the queue. A per-user, per-interface file lock excludes simultaneous app
operations; it cannot exclude unrelated CAN tools.

## Calibration preflight and stopping

Before excitation, the app writes and reads back operation mode `0x7005 = 0`
and a nonzero command watchdog `0x7028 = 2000` raw ticks. It verifies watchdog
expiry using a zero-torque enable and requires fault-free Reset within 300 ms
without commands. When supported, the app observes the motor's periodic Type-24
status frames, which do not send a new command during the quiet interval. Older
firmware falls back to a zero-torque status request after the interval. It does
not rely solely on a presumed tick duration.

Enable allows intermediate Reset feedback while requesting fresh status, then
requires Run feedback within 100 ms. Acquisition checks motor state/faults,
speed, travel, temperature, encoder continuity, CAN errors, missing feedback
(50 ms), and missed command deadlines (25 ms). A stop guard handles exits;
firmware watchdog expiry covers loss of host commands. The desktop command
loop is not a hard real-time scheduler.

Encoder continuity uses unwrapped position and a 50 ms history, allowing up to
5 ms of USB/host arrival jitter plus 0.02 rad position tolerance. The same speed
envelope must hold against every recent sample, so the jitter allowance does
not accumulate for each received packet. This avoids treating a delayed reply
followed by a closely spaced reply as a shaft jump. Speed, travel, feedback
timeout, and command-deadline limits remain separate checks. Rejected encoder
feedback is saved with its raw CAN frame and timing in `encoder_error.json`.

Mode/watchdog settings remain in place after capture; the app does not save
them to flash. Scanning and calibration do not change IDs, zero position, or
firmware. Those are separate user-triggered operations.

## Firmware transfer

`firmware_catalog.json` pins the model-specific versions, URLs, and SHA-256
hashes from [RobStride release V26.05.19](https://github.com/RobStride/Product_Information/releases/tag/V26.05.19).
The updater implements private CAN types 11–14 following the vendor's
[OTA protocol and reference](https://github.com/RobStride/Product_Information/tree/main/OTA).

Before writing, verify the image digest, model family, and motor UUID. Transfer
uses acknowledged 8-byte packets with bounded retries and resume handling.
Completion requires reading back the target version and the same UUID after
restart. Flashing never enables the motor and excludes cancellation, window
closing, and other app operations. Transfer acknowledgement alone is not
success. Update logs are saved as `firmware_update.json` and `ota_ack.jsonl`.

## Measurement consistency

Acquisition and fitting compare position change with integrated velocity over
200 ms windows once enough motion is available. A scale disagreement above
10% rejects the recording; it never silently rescales data or switches wire
profiles. This check helps detect incompatible position/velocity units but
cannot verify commanded torque accuracy.
