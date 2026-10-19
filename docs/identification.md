# Identification reference

[Developer guide](development.md) · [Simulation and exports](simulation.md)

The default run records **40 s training + 20 s independent validation**. Only
training selects parameters. Replay uses the transmitted, quantized commands
and recorded observation timestamps, not regenerated waveforms.

## Motion plan

| Training interval | Excitation | Purpose |
|---|---|---|
| 0–10 s | Paired positive/negative speed steps at 20%, 45%, 75%, 100% amplitude | Wider speed coverage |
| 10–22 s | Logarithmic velocity-target sine sweep, 0.15–8 Hz | Accelerations and effective delay |
| 22–30 s | Three-frequency multisine | Dynamic excitation |
| 30–36 s | Alternating torque bursts, 20–100% torque limit, 60–160 ms widths | Acceleration and torque range |
| 36–40 s | Zero commanded torque while enabled | Coast-down |

| Setting | Default or behavior |
|---|---|
| Preset | One per motor; intervals scale with recording duration |
| Validation | Different frequencies, speeds, pulses, and amplitudes |
| Requested speed | Up to 75% of configured speed cutoff |
| Preset speed cutoff | 45% of the smaller of no-load speed and wire range |
| Torque / travel | Bench torque cap below; ±24 rad from initial position |

**Advanced** can change sweep range, duration, and limits. Speed stages use a
bounded host PI controller; bursts request bounded torque. Above 85% of the
speed cutoff, the generator opposes motion. Near 75% of travel, it returns
toward center. Acquisition limits, CAN checks, cancellation, and the watchdog
remain active. Firmware operation-mode Kp/Kd stay at zero.

The preview shows requested inputs, not predicted response. High-frequency
tracking may be limited. `excitation_revision` identifies the generator;
recorded commands remain the replay input. Opening the app starts no motion.

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

| Bench policy | Formula |
|---|---|
| Torque cap | min(25% rated, 10% peak, 10% wire range) |
| Speed cap | min(50% no-load, 50% wire range) |
| Preset speed cutoff | 45% of the smaller of no-load speed and wire range |

These are application policy, not manufacturer safety guarantees. Temperature
limits use reported motor temperature, not ambient rating.

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
   The held-out data never tunes parameters. Rejected candidates are not promoted to accepted exports.

Breakaway calibration is deferred. New fits use MuJoCo's constant joint
`frictionloss`, with no additional static peak (`static_friction = 0`). The
model can still resist motion at rest through that constant constraint, but
there is no separate breakaway experiment or parameter search. Low-speed and
reversal discrepancies remain visible in full-trajectory validation. Historical
reports containing a Stribeck peak retain their original replay semantics.

## Acceptance and limitations

Acceptance requires all of the following:

- Optimizer convergence and sufficient parameter separation.
- No delay-boundary hit or material worsening of either held-out RMSE.
- Held-out velocity RMSE below the larger of 0.05 rad/s or 20% of measured RMS velocity.

These engineering thresholds are not confidence intervals.

The model assumes accurate commanded torque at the unloaded gearbox output.
Delay combines host, CAN, firmware, filtering, and reception timing; it cannot
separate those contributions or resolve below the feedback interval. It omits
load/temperature-dependent friction, compliance, backlash, torque strength,
and PD gains.

See [Simulation and exports](simulation.md) to apply an accepted result. For
implementation changes, keep the validation recording out of all parameter
and seed selection decisions.
