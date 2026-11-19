# Identification reference

[Developer guide](development.md) · [Simulation and exports](simulation.md)

Calibration records a training trajectory and an independent validation trajectory.
Only training data selects parameters. Replay uses the quantized commands sent
to the motor and their recorded timestamps.

## Motion plan

Speed steps, a sweep, and multisine motion excite different parts of the speed
range. Torque bursts measure acceleration directly. Coast-down reveals friction
as the shaft slows. Validation changes the waveform to test the fit on new motion.

Run `motor-setup-tool plan --model RS-00` to see a model's current limits and
defaults. The calibration preview shows requested motion. Each run saves its
actual segment timings and limits in `experiment_plan.json`.

Rated torque assumes the manufacturer's cooling conditions. The app derives
bench limits from the model ratings and wire ranges. For RS-04 it uses the lower
published torque rating. [Model catalog](../electron/motor-models.json) ·
[Vendor specifications](https://github.com/RobStride/Product_Information/blob/0f4ad74fdb67023e75bbcbeebecd6f1a003ce000/README.md)

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
