//! Moving-dynamics and delay identification; training only.
use crate::{engine, types::*};
use anyhow::{Context, Result, ensure};
use nalgebra::{DMatrix, DVector, Matrix3, Matrix4, Vector3, Vector4};
use std::sync::atomic::{AtomicBool, Ordering};

pub fn validate(session: &Session) -> Result<()> {
    ensure!(
        session.complete && session.schema_version == 1,
        "Only complete schema-version-1 sessions can be fitted"
    );
    session.config.validate()?;
    ensure!(
        session.traces.len() == 2
            && session.traces[0].name == "training"
            && session.traces[1].name == "validation",
        "Require separate training and held-out validation traces"
    );
    for trace in &session.traces {
        ensure!(
            trace.samples.len() >= 200 && trace.commands.len() >= 100,
            "Not enough samples/commands"
        );
        ensure!(
            trace.samples.iter().all(|s| [
                s.t,
                s.position,
                s.velocity,
                s.reported_torque,
                s.temperature
            ]
            .iter()
            .all(|v| v.is_finite())),
            "Nonfinite measurements"
        );
        ensure!(
            trace
                .commands
                .iter()
                .all(|s| s.t.is_finite() && s.torque.is_finite()),
            "Nonfinite commands"
        );
        ensure!(
            trace
                .samples
                .windows(2)
                .all(|w| w[1].t > w[0].t && w[1].t - w[0].t <= 0.05),
            "Feedback timestamps invalid or gap exceeds 50 ms"
        );
        ensure!(
            trace.commands.windows(2).all(|w| w[1].t > w[0].t),
            "Command timestamps must increase"
        );
        ensure!(
            trace.samples[0].t >= 0.
                && trace.commands[0].t >= 0.
                && trace.commands.last().unwrap().t <= trace.samples.last().unwrap().t + 0.05,
            "Invalid time coverage"
        );
        let v: Vec<_> = trace.samples.iter().map(|s| s.velocity).collect();
        ensure!(
            stddev(&v) > 0.08
                && v.iter().filter(|&&v| v > 0.1).count() >= 20
                && v.iter().filter(|&&v| v < -0.1).count() >= 20,
            "Insufficient bidirectional motion; increase excitation within limits"
        );
        check_wire_scale(trace, &session.config.profile)?;
        let quantization = session.config.profile.torque_range / 65535.;
        ensure!(
            trace
                .commands
                .iter()
                .all(|c| c.torque.abs() <= session.config.torque_limit + quantization + 1e-8),
            "Command exceeds torque limit"
        );
    }
    Ok(())
}

pub fn check_wire_scale(trace: &Trace, profile: &Profile) -> Result<()> {
    let ratio = velocity_position_scale(trace)?;
    ensure!(
        (ratio - 1.).abs() <= 0.10,
        "{}: position/velocity scaling mismatch (position change / integrated velocity = {:.3}, expected 1). If the position range is correct, the speed wire range would be about ±{:.2} rad/s instead of ±{:.2}. Recording does not agree with the selected profile; verify motor firmware and settings. Data was not rescaled",
        trace.name,
        ratio,
        profile.velocity_range * ratio,
        profile.velocity_range
    );
    Ok(())
}

/// Compare displacement with trapezoidal velocity integrals over 200 ms.
/// Local windows avoid accumulating velocity bias over the entire recording.
/// This detects incompatible units; it cannot identify which encoder is wrong.
pub fn velocity_position_scale(trace: &Trace) -> Result<f64> {
    let samples = &trace.samples;
    let mut iv = vec![0.; samples.len()];
    for i in 1..samples.len() {
        iv[i] = iv[i - 1]
            + (samples[i].t - samples[i - 1].t)
                * (samples[i].velocity + samples[i - 1].velocity)
                * 0.5;
    }
    let mut xx = 0.;
    let mut xy = 0.;
    let mut end = 0;
    for start in (0..samples.len()).step_by(10) {
        while end < samples.len() && samples[end].t < samples[start].t + 0.2 {
            end += 1;
        }
        if end == samples.len() {
            break;
        }
        let x = iv[end] - iv[start];
        xx += x * x;
        xy += x * (samples[end].position - samples[start].position);
    }
    ensure!(
        xx > 1e-6,
        "Too little displacement to check position/velocity scaling"
    );
    Ok(xy / xx)
}
fn stddev(v: &[f64]) -> f64 {
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    (v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
}
fn integral(v: &[f64], dt: f64) -> Vec<f64> {
    let mut out = vec![0.; v.len()];
    for i in 1..v.len() {
        out[i] = out[i - 1] + dt * 0.5 * (v[i - 1] + v[i]);
    }
    out
}

fn seed(trace: &Trace, cancel: &AtomicBool, progress: &impl Fn(f32)) -> Result<(Parameters, f64)> {
    let dt = engine::TIMESTEP;
    let t0 = trace.samples[0].t;
    let n = ((trace.samples.last().unwrap().t - t0) / dt) as usize;
    let mut velocities = Vec::with_capacity(n);
    let mut j = 0;
    for i in 0..n {
        let t = t0 + i as f64 * dt;
        while j + 1 < trace.samples.len() - 1 && trace.samples[j + 1].t < t {
            j += 1;
        }
        let a = &trace.samples[j];
        let b = &trace.samples[j + 1];
        velocities.push(a.velocity + (b.velocity - a.velocity) * (t - a.t) / (b.t - a.t));
    }
    let iv = integral(&velocities, dt);
    let isig = integral(
        &velocities.iter().map(|v| v.signum()).collect::<Vec<_>>(),
        dt,
    );
    let windows: Vec<_> = (60..n.saturating_sub(40))
        .step_by(8)
        .filter(|&i| {
            velocities[i..=i + 40].iter().all(|v| v.abs() > 0.3)
                && velocities[i] * velocities[i + 40] > 0.
        })
        .collect();
    ensure!(
        windows.len() >= 50,
        "Too little motion above breakaway friction"
    );
    let mut best: Option<(f64, Parameters, f64)> = None;
    for delay_step in 0..=50 {
        progress(delay_step as f32 / 51.);
        ensure!(!cancel.load(Ordering::Relaxed), "Fit cancelled");
        let delay = delay_step as f64 * 0.001;
        let mut index = 0;
        let mut torque = 0.;
        let mut u = Vec::with_capacity(n);
        for i in 0..n {
            let t = t0 + i as f64 * dt;
            while index < trace.commands.len() && trace.commands[index].t + delay <= t {
                torque = trace.commands[index].torque;
                index += 1;
            }
            u.push(torque);
        }
        let iu = integral(&u, dt);
        let x = DMatrix::from_fn(windows.len(), 3, |r, col| {
            let a = windows[r];
            let b = a + 40;
            match col {
                0 => velocities[b] - velocities[a],
                1 => iv[b] - iv[a],
                _ => isig[b] - isig[a],
            }
        });
        let y = DVector::from_iterator(windows.len(), windows.iter().map(|&a| iu[a + 40] - iu[a]));
        let scales = Vector3::new(x.column(0).norm(), x.column(1).norm(), x.column(2).norm());
        if scales.min() < 1e-10 {
            continue;
        }
        let normalized = DMatrix::from_fn(x.nrows(), 3, |r, c| x[(r, c)] / scales[c]);
        let gram = normalized.transpose() * &normalized;
        let eig = Matrix3::from_fn(|r, c| gram[(r, c)])
            .symmetric_eigen()
            .eigenvalues;
        if eig.min() <= 0. {
            continue;
        }
        let condition = (eig.max() / eig.min()).sqrt();
        if condition > 1000. {
            continue;
        }
        // Exact nonnegative least squares for only three regressors: enumerate
        // the seven active subsets, solve each, choose the feasible minimum.
        for mask in 1..8 {
            let cols: Vec<_> = (0..3).filter(|c| mask & (1 << c) != 0).collect();
            let sub = DMatrix::from_fn(x.nrows(), cols.len(), |r, c| normalized[(r, cols[c])]);
            let Some(coeff) = (&sub.transpose() * &sub)
                .lu()
                .solve(&(&sub.transpose() * &y))
            else {
                continue;
            };
            if coeff.iter().any(|&c| c < 0.) {
                continue;
            }
            let mut fit = Vector3::zeros();
            for (i, &col) in cols.iter().enumerate() {
                fit[col] = coeff[i] / scales[col];
            }
            if fit[0] <= 0. {
                continue;
            }
            let cost = (&sub * coeff - &y).norm_squared();
            if best.as_ref().is_none_or(|b| cost < b.0) {
                best = Some((
                    cost,
                    Parameters {
                        armature: fit[0],
                        damping: fit[1],
                        friction: fit[2],
                        delay,
                        static_friction: 0.,
                    },
                    condition,
                ));
            }
        }
    }
    let (_, p, condition) = best.context("Excitation cannot distinguish inertia and friction")?;
    progress(1.);
    Ok((p, condition))
}
fn from_vector(x: Vector4<f64>, scale: Vector4<f64>) -> Parameters {
    let p = x.component_mul(&scale);
    Parameters {
        armature: p[0],
        damping: p[1],
        friction: p[2],
        delay: p[3],
        static_friction: 0.,
    }
}
fn vector(p: &Parameters) -> Vector4<f64> {
    Vector4::new(p.armature, p.damping, p.friction, p.delay)
}
fn clipped(x: Vector4<f64>, lo: &Vector4<f64>, hi: &Vector4<f64>) -> Vector4<f64> {
    Vector4::from_fn(|i, _| x[i].clamp(lo[i], hi[i]))
}
pub struct Fit {
    pub parameters: Parameters,
    pub condition: f64,
    pub converged: bool,
    pub diagnostics: FitDiagnostics,
}

/// Moving windows provide a physical seed. Final parameters minimize the same
/// continuous training rollout used in the graphs, including stops/reversals.
/// Held-out measurements are never used for candidate selection.
pub fn identify(
    trace: &Trace,
    torque_limit: f64,
    cancel: &AtomicBool,
    progress: &impl Fn(WorkProgress),
) -> Result<Fit> {
    let (initial, condition) = seed(trace, cancel, &|f| {
        progress(WorkProgress::fitting(
            0.1 * f,
            "Estimating inertia, friction and delay",
        ))
    })?;
    let windows = moving_windows(trace);
    ensure!(
        windows.len() >= 8,
        "Too few clean moving windows; use the full identification suite"
    );
    let (moving, moving_converged, moving_cost) = refine(
        trace,
        &windows,
        &initial,
        torque_limit,
        cancel,
        &|f, label| progress(WorkProgress::fitting(0.1 + 0.2 * f, label)),
        "Moving-window fit",
    )?;
    let velocity_scale =
        stddev(&trace.samples.iter().map(|s| s.velocity).collect::<Vec<_>>()).max(0.1);
    let score = |p: &Parameters| -> Result<f64> {
        let r = residuals(std::slice::from_ref(trace), p, velocity_scale, cancel)?;
        Ok(r.iter().map(|v| v * v).sum::<f64>() / r.len() as f64)
    };
    let before = score(&moving)?;
    let mut parameters = moving.clone();
    let mut converged = moving_converged;
    let mut after = before;
    // Both starts are determined solely from training; retain the seed if
    // refinement does not improve its full-trajectory objective.
    for (stage, (label, candidate)) in [
        ("Trajectory fit from moving seed", &moving),
        ("Trajectory fit from integral seed", &initial),
    ]
    .into_iter()
    .enumerate()
    {
        let (p, solved, loss) = refine(
            trace,
            std::slice::from_ref(trace),
            candidate,
            torque_limit,
            cancel,
            &|f, label| progress(WorkProgress::fitting(0.3 + 0.3 * (stage as f32 + f), label)),
            label,
        )?;
        if loss < after {
            parameters = p;
            converged = solved;
            after = loss;
        }
    }
    let diagnostics = FitDiagnostics {
        moving_windows: windows.len(),
        moving_velocity_normalized_rmse: moving_cost.sqrt(),
        trajectory_refinement: Some(TrajectoryRefinement {
            moving_seed: moving,
            training_objective_before: before,
            training_objective_after: after,
        }),
        notes: vec![
            "Moving training windows seed J, damping, friction and delay. Final refinement uses the complete continuous training trajectory, including stops and reversals, from two training-only seeds.".into(),
            "Objective: velocity residual plus position residual weighted by 0.3 /s, normalized by training velocity standard deviation. Validation is never reset, fitted or used to select a seed.".into(),
            "Breakaway calibration remains deferred: constant MuJoCo frictionloss, no separate static peak. These are effective parameters under the fixed torque-gain assumption.".into(),
        ],
        ..Default::default()
    };
    Ok(Fit {
        parameters,
        condition,
        converged,
        diagnostics,
    })
}
fn residuals(
    windows: &[Trace],
    p: &Parameters,
    velocity_scale: f64,
    cancel: &AtomicBool,
) -> Result<Vec<f64>> {
    let mut r = Vec::new();
    for window in windows {
        let sim = engine::replay(window, p, cancel)?;
        for (s, model) in window.samples.iter().zip(sim).skip(1).step_by(2) {
            r.push((model[1] - s.velocity) / velocity_scale);
            r.push(0.3 * (model[0] - s.position) / velocity_scale);
        }
    }
    Ok(r)
}
fn refine(
    trace: &Trace,
    windows: &[Trace],
    initial: &Parameters,
    torque_limit: f64,
    cancel: &AtomicBool,
    progress: &impl Fn(f32, String),
    label: &str,
) -> Result<(Parameters, bool, f64)> {
    let scale = Vector4::new(
        initial.armature.max(0.0001),
        initial.damping.max(0.001),
        initial.friction.max(0.005),
        0.01,
    );
    let lo = Vector4::new(1e-6, 0., 0., 0.).component_div(&scale);
    let hi = Vector4::new(5., 10., (torque_limit * 2.).max(0.01), 0.05).component_div(&scale);
    let mut x = clipped(vector(initial).component_div(&scale), &lo, &hi);
    let velocity_scale =
        stddev(&trace.samples.iter().map(|s| s.velocity).collect::<Vec<_>>()).max(0.1);
    let residual =
        |x: Vector4<f64>| residuals(windows, &from_vector(x, scale), velocity_scale, cancel);
    let mut r = residual(x)?;
    let mut cost = r.iter().map(|v| v * v).sum::<f64>();
    let mut lambda = 0.001;
    let mut converged = false;
    for iteration in 0..80 {
        progress(
            iteration as f32 / 80.,
            format!("{label} · iteration {} / 80", iteration + 1),
        );
        ensure!(!cancel.load(Ordering::Relaxed), "Fit cancelled");
        let mut jac = Vec::new();
        for col in 0..4 {
            let h = 0.001_f64.max(x[col].abs() * 0.001);
            let mut perturbed = x;
            perturbed[col] = (x[col] + h).min(hi[col]);
            if perturbed[col] == x[col] {
                perturbed[col] = (x[col] - h).max(lo[col]);
            }
            let actual_h = perturbed[col] - x[col];
            let rp = residual(perturbed)?;
            jac.push(
                rp.iter()
                    .zip(&r)
                    .map(|(a, b)| (a - b) / actual_h)
                    .collect::<Vec<_>>(),
            );
        }
        let jtj = Matrix4::from_fn(|a, b| jac[a].iter().zip(&jac[b]).map(|(x, y)| x * y).sum());
        let gradient =
            Vector4::from_fn(|a, _| jac[a].iter().zip(&r).map(|(x, y)| x * y).sum::<f64>());
        if gradient.amax() < 1e-6 {
            converged = true;
            break;
        }
        let mut damped = jtj;
        for i in 0..4 {
            damped[(i, i)] += lambda * (jtj[(i, i)] + 1e-8);
        }
        let Some(delta) = damped.lu().solve(&(-gradient)) else {
            lambda *= 10.;
            continue;
        };
        let candidate = clipped(x + delta, &lo, &hi);
        if (candidate - x).norm() < 1e-7 {
            converged = true;
            break;
        }
        let next = residual(candidate)?;
        let next_cost = next.iter().map(|v| v * v).sum::<f64>();
        if next_cost < cost {
            let improvement = (cost - next_cost) / cost.max(1e-12);
            x = candidate;
            r = next;
            cost = next_cost;
            lambda = (lambda / 3.).max(1e-9);
            if improvement < 1e-7 {
                converged = true;
                break;
            }
        } else {
            lambda *= 5.;
        }
    }
    progress(1., format!("{label} complete"));
    Ok((from_vector(x, scale), converged, cost / r.len() as f64))
}

fn slice(trace: &Trace, a: usize, b: usize) -> Trace {
    Trace {
        name: trace.name.clone(),
        commands: trace.commands.clone(),
        samples: trace.samples[a..b].to_vec(),
    }
}
fn moving_windows(trace: &Trace) -> Vec<Trace> {
    let s = &trace.samples;
    let mut ranges = Vec::new();
    for a in (0..s.len()).step_by(10) {
        let b = s.partition_point(|v| v.t < s[a].t + 0.12);
        if b >= s.len() || b - a < 5 {
            continue;
        }
        if s[a..b]
            .iter()
            .all(|v| v.velocity.abs() > 0.3 && v.velocity * s[a].velocity > 0.)
        {
            ranges.push((a, b));
        }
    }
    let stride = ranges.len().div_ceil(48).max(1);
    ranges
        .into_iter()
        .step_by(stride)
        .map(|(a, b)| slice(trace, a, b))
        .collect()
}
