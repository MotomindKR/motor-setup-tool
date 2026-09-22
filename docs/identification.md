# Measurements and staged identification

The full suite defaults to 40 seconds of training followed by 20 seconds of
independent validation. Only training samples select parameters. The exported
session contains actual transmitted, quantized torque commands and separate
observation timestamps; fitting never re-creates commands from the waveform.

| Training interval | Excitation | Purpose |
|---|---|---|
| 0–10 s | Paired positive/negative speed steps at 20%, 45%, 75%, 100% amplitude | Wider speed coverage |
| 10–22 s | Logarithmic velocity-target sine sweep, 0.15–8 Hz | Accelerations and effective delay |
| 22–30 s | Three-frequency multisine | Dynamic excitation |
| 30–36 s | Alternating torque bursts, 20–100% torque limit, 60–160 ms widths | Acceleration and torque range |
| 36–40 s | Zero commanded torque while enabled | Coast-down |

There is one preset per motor. Intervals scale with recording duration. Held-out
validation uses different frequencies, speed levels, pulse widths and amplitudes.
Requested target speed reaches 75% of the configured speed cutoff. The preset
speed cutoff is 45% of the smaller of nominal no-load speed and wire range.
Preset torque uses the existing bench cap; travel is ±24 rad from the initial
position. Sweep range, durations and limits can be edited in Advanced.

Speed stages use a bounded host PI controller. Torque bursts directly request
bounded torque; their response is not a commanded position or velocity. Above
85% of the speed cutoff, the generator commands opposing torque. Near 75% of
the travel bound, it commands a return toward center. Independent acquisition
speed/travel/temperature cutoffs, cancellation, CAN error handling and the
firmware watchdog remain active. These tests keep firmware operation-mode
Kp/Kd at zero. No motor motion starts when opening the app.

The motion preview shows requested speed and burst torque, not predicted motor
response. High-frequency tracking may be amplitude-limited. `excitation_revision`
separates the new suite from older recordings; recorded commands remain the
replay input. The UI upgrades old saved test settings once and requires review
before a hardware run.

## Motor specifications versus test settings

[Official July 2026 product table](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/README.md).
These are output-side quantities. Rated torque assumes specified cooling.
For RS04 the lower published 35 Nm rating is used for bench-policy calculations.

| Model | Rated Nm | Peak Nm | Nominal no-load rpm | Ratio | Rated V |
|---|---:|---:|---:|---:|---:|
| RS00 | 5 | 14 | 315 | 10 | 48 |
| RS01 | 7 | 17 | 315 | 7.75 | 36 |
| RS02 | 7 | 17 | 410 | 7.75 | 48 |
| RS03 | 21 | 60 | 195 | 9 | 48 |
| RS04 | 35 | 120 | 200 | 9 | 48 |
| RS05 | 1.8 | 5.5 | 480 | 7.75 | 48 |
| RS06 | 11 | 36 | 480 | 9 | 48 |

The app's bench torque cap is min(25% rated, 10% peak, 10% wire range), and
its speed cap is min(50% no-load, 50% wire range). The single preset uses that torque cap and 45% of the smaller of no-load
speed and wire range.
These are application policy, not manufacturer safety guarantees. Ratings do
not justify commanding full peak torque during bare-shaft identification.
Temperature limits refer to reported motor temperature, not the ambient rating.

## Fitting stages

1. Check timestamp coverage, bidirectional motion and position/velocity units.
2. On uninterrupted moving windows above 0.3 rad/s, solve integrated torque
   balance for positive inertia and nonnegative damping/kinetic friction.
   Search effective delay over 0–50 ms. Torque gain remains fixed at one.
3. Refine those parameters with bounded least squares on up to 48 moving
   MuJoCo windows of 120 ms. All these windows are from training. This avoids
   forcing rest intervals into the moving inertia or delay estimate.
4. Refine the same four parameters against the complete continuous training
   trajectory, initialized once at its first measured state. Try the integral
   and moving-window seeds and choose solely by training objective; keep the
   moving seed if refinement does not improve it. Include stops and reversals.
   The objective is the mean square of velocity residuals and position residuals
   weighted by 0.3 /s, both normalized by training velocity standard deviation.
   This reduces the mismatch between short-window fitting and plotted rollouts.
   A reduced training objective does not guarantee improved held-out behavior.
5. Run full training and held-out trajectories from their initial states only.
   The held-out data never tunes parameters. Original acceptance thresholds
   remain unchanged, and rejected candidates are not promoted.

Breakaway calibration is deferred. New fits use MuJoCo's constant joint
`frictionloss`, with no additional static peak (`static_friction = 0`). The
model can still resist motion at rest through that constant constraint, but
there is no separate breakaway experiment or parameter search. Low-speed and
reversal discrepancies remain visible in full-trajectory validation. Historical
reports containing a Stribeck peak retain their original replay semantics.

## Applying an accepted result

Compile a model with the exported joint armature, damping and kinetic friction
and a direct torque actuator with gear=1. Then apply delayed command history. The exported `replay_wrapper.py` provides the
same stepping semantics as native Rust, using maximum 1 ms steps and splitting
at command/observation boundaries. It advances the entire MuJoCo model.

```python
import json
import mujoco
from replay_wrapper import TorqueReplay

artifact = json.load(open("calibration.json"))
model = mujoco.MjModel.from_xml_path("post_calibration.xml")
data = mujoco.MjData(model)
replay = TorqueReplay(model, data, artifact)
# Commands use the same time origin as data.time, in seconds and output Nm.
replay.advance_to(0.01, [(0.0, 0.02)])
```

XML contains delay as metadata, but loading XML alone does not activate it. Do not use a rejected `candidate.json` as an accepted result.
The helper was compared against Rust replay on both synthetic and real traces;
maximum state differences were below 1e-12 with MuJoCo 3.12.0.
