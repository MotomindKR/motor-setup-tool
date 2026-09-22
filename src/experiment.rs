//! Bounded excitation. Host feedback shapes the test, not the replay model.
use crate::types::{Config, excitation};
use serde::{Deserialize, Serialize};
use std::f64::consts::TAU;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
// Historical variants remain readable; the UI uses one Mixed suite per model.
pub enum Experiment {
    Legacy,
    Mixed,
    SineSweep,
    Multisine,
    Steps,
}
impl Experiment {
    pub fn label(self) -> &'static str {
        match self {
            Self::Legacy => "Legacy steps",
            Self::Mixed => "Calibration suite",
            Self::SineSweep => "Sine sweep",
            Self::Multisine => "Multisine",
            Self::Steps => "Steps + coast",
        }
    }
}
pub fn legacy() -> Experiment {
    Experiment::Legacy
}
pub fn default_start_hz() -> f64 {
    0.2
}
pub fn default_end_hz() -> f64 {
    5.
}

#[derive(Clone, Debug, Serialize)]
pub struct Segment {
    pub name: &'static str,
    pub start: f64,
    pub end: f64,
}
pub fn plan(c: &Config, validation: bool) -> Vec<Segment> {
    let d = if validation {
        c.validation_seconds
    } else {
        c.train_seconds
    };
    if c.experiment == Experiment::Legacy {
        return vec![Segment {
            name: "legacy",
            start: 0.,
            end: d,
        }];
    }
    let parts: Vec<(&str, f64)> = if validation && (c.excitation_revision >= 1) {
        vec![
            ("held-out multisine", 0.5),
            ("held-out steps", 0.25),
            ("held-out bursts", 0.15),
            ("coast-down", 0.1),
        ]
    } else if validation {
        vec![
            ("held-out multisine", 0.65),
            ("held-out steps", 0.25),
            ("coast-down", 0.1),
        ]
    } else {
        match c.experiment {
            Experiment::Mixed if c.excitation_revision >= 1 => vec![
                ("speed steps", 0.25),
                ("sine sweep", 0.3),
                ("multisine", 0.2),
                ("torque bursts", 0.15),
                ("coast-down", 0.1),
            ],
            Experiment::Mixed => vec![
                ("speed steps", 0.25),
                ("sine sweep", 0.4),
                ("multisine", 0.25),
                ("coast-down", 0.1),
            ],
            Experiment::SineSweep => vec![("sine sweep", 0.9), ("coast-down", 0.1)],
            Experiment::Multisine => vec![("multisine", 0.9), ("coast-down", 0.1)],
            _ => vec![("speed steps", 0.9), ("coast-down", 0.1)],
        }
    };
    let mut t = 0.;
    parts
        .into_iter()
        .map(|(name, f)| {
            let start = t;
            t += d * f;
            Segment {
                name,
                start,
                end: t,
            }
        })
        .collect()
}
pub fn chirp_phase(t: f64, duration: f64, f0: f64, f1: f64) -> f64 {
    let k = (f1 / f0).ln() / duration;
    TAU * f0 * (k * t).exp_m1() / k
}

fn target_in_segment(segment: &Segment, local: f64, c: &Config) -> f64 {
    if segment.name == "coast-down" || segment.name.contains("bursts") {
        return 0.;
    }
    let wave = match segment.name {
        "sine sweep" => chirp_phase(
            local,
            segment.end - segment.start,
            c.sweep_start_hz,
            c.sweep_end_hz,
        )
        .sin(),
        "multisine" => {
            0.55 * (TAU * 0.37 * local).sin()
                + 0.3 * (TAU * 1.13 * local + 0.8).sin()
                + 0.15 * (TAU * 3.1 * local + 1.7).sin()
        }
        "held-out multisine" => {
            0.5 * (TAU * 0.29 * local + 0.3).sin()
                + 0.3 * (TAU * 0.83 * local + 1.4).sin()
                + 0.2 * (TAU * 2.37 * local + 0.7).sin()
        }
        "held-out steps" if c.excitation_revision >= 1 => {
            [0.3, -0.65, 0.9, -0.35, 0.6, -0.95, 0.][((local / 0.55) as usize) % 7]
        }
        "speed steps" if c.excitation_revision >= 1 => {
            [0.2, -0.2, 0.45, -0.45, 0.75, -0.75, 1., -1., 0.][((local / 0.65) as usize) % 9]
        }
        "held-out steps" => [0.5, -0.85, 0.2, -0.45, 0.][((local / 0.8) as usize) % 5],
        _ => [0.3, 0.7, -0.5, -1., 0., 1., -0.3, 0.][((local / 0.85) as usize) % 8],
    };
    c.target_speed_fraction() * c.speed_limit * wave
}
/// Requested trajectory, not predicted motor motion. Used by the UI preview.
pub fn preview(c: &Config, t: f64, validation: bool) -> (f64, f64) {
    let segments = plan(c, validation);
    let segment = segments
        .iter()
        .find(|s| t < s.end)
        .unwrap_or(segments.last().unwrap());
    let local = t - segment.start;
    (
        target_in_segment(segment, local, c),
        if segment.name.contains("bursts") {
            pulse_torque(local, c.torque_limit, validation)
        } else {
            0.
        },
    )
}
fn pulse_torque(t: f64, limit: f64, validation: bool) -> f64 {
    // Alternating amplitudes and pulse widths excite acceleration without
    // relying on velocity-loop tracking. Quiet gaps retain coast-down samples.
    let period = if validation { 0.41 } else { 0.36 };
    let i = (t / period) as usize;
    let (levels, widths): (&[f64], &[f64]) = if validation {
        (&[0.35, -0.7, 0.9, -0.4, 0.65, -1.], &[0.11, 0.07, 0.14])
    } else {
        (
            &[0.2, -0.2, 0.5, -0.5, 0.8, -0.8, 1., -1.],
            &[0.06, 0.1, 0.16],
        )
    };
    if t % period < widths[i % widths.len()] {
        limit * levels[i % levels.len()]
    } else {
        0.
    }
}

pub struct Exciter {
    segments: Vec<Segment>,
    integral: f64,
    last_t: f64,
    phase: usize,
}
impl Exciter {
    pub fn new(c: &Config, validation: bool) -> Self {
        Self {
            segments: plan(c, validation),
            integral: 0.,
            last_t: 0.,
            phase: usize::MAX,
        }
    }
    pub fn phase_name(&self) -> &str {
        self.segments
            .get(self.phase)
            .map_or("preparing", |s| s.name)
    }
    pub fn command(&mut self, t: f64, q: f64, v: f64, c: &Config, validation: bool) -> f64 {
        if c.experiment == Experiment::Legacy {
            return excitation(t, v, c, validation);
        }
        let phase = self
            .segments
            .iter()
            .position(|s| t < s.end)
            .unwrap_or(self.segments.len() - 1);
        if phase != self.phase {
            self.integral = 0.;
            self.phase = phase;
        }
        let dt = (t - self.last_t).clamp(0., 0.025);
        self.last_t = t;
        let s = &self.segments[phase];
        let local = t - s.start;
        let torque = if s.name == "coast-down" {
            self.integral = 0.;
            0.
        } else if s.name.contains("bursts") {
            self.integral = 0.;
            pulse_torque(local, c.torque_limit, s.name == "held-out bursts")
        } else {
            let target = target_in_segment(s, local, c);
            let error = (target - v) / (c.target_speed_fraction() * c.speed_limit);
            let (kp, ki) = if c.excitation_revision >= 1 {
                (1.6, 3.)
            } else {
                (0.8, 1.5)
            };
            // Anti-windup: integrate only if it does not push saturation farther.
            let candidate = (self.integral + ki * error * dt).clamp(-0.8, 0.8);
            if (kp * error + candidate).abs() <= 1. || error.signum() != self.integral.signum() {
                self.integral = candidate;
            }
            c.torque_limit * (kp * error + self.integral)
        };
        // Brake before reaching the independent acquisition speed cutoff.
        if (c.excitation_revision >= 1) && v.abs() > 0.85 * c.speed_limit {
            self.integral = 0.;
            return -v.signum() * 0.8 * c.torque_limit;
        }
        // Return toward center before the independent acquisition travel cutoff.
        if q.abs() > 0.75 * c.travel_limit {
            self.integral = 0.;
            return (-q.signum() * 0.5 * c.torque_limit - 0.3 * c.torque_limit * v / c.speed_limit)
                .clamp(-c.torque_limit, c.torque_limit);
        }
        torque.clamp(-c.torque_limit, c.torque_limit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_plans_are_bounded_and_validation_differs() {
        for model in crate::types::Profile::presets() {
            for experiment in [
                Experiment::Mixed,
                Experiment::SineSweep,
                Experiment::Multisine,
                Experiment::Steps,
            ] {
                let mut c = Config {
                    profile: model.clone(),
                    experiment,
                    ..Default::default()
                };
                c.apply_spec_limits();
                c.validate().unwrap();
                let mut train = Exciter::new(&c, false);
                let mut test = Exciter::new(&c, true);
                let mut different = false;
                for i in 0..8000 {
                    let t = i as f64 * 0.005;
                    let u = train.command(t, 0., (t * 2.).sin(), &c, false);
                    let b = test.command(t, 0., (t * 2.).sin(), &c, true);
                    assert!(u.is_finite() && u.abs() <= c.torque_limit);
                    assert!(b.abs() <= c.torque_limit);
                    different |= (u - b).abs() > 0.01;
                }
                assert!(different);
            }
        }
    }
    #[test]
    fn model_presets_brake_near_limits_and_keep_historical_plans_readable() {
        for model in crate::types::Profile::presets() {
            let mut c = Config {
                profile: model,
                ..Default::default()
            };
            c.apply_spec_limits();
            c.validate().unwrap();
            for sign in [-1., 1.] {
                let mut e = Exciter::new(&c, false);
                assert!(e.command(1., 0., sign * c.speed_limit * 0.9, &c, false) * sign < 0.);
                assert!(e.command(1.1, sign * c.travel_limit * 0.8, 0., &c, false) * sign < 0.);
            }
        }
        let mut saved = serde_json::to_value(Config::default()).unwrap();
        saved.as_object_mut().unwrap().remove("excitation_revision");
        let historical: Config = serde_json::from_value(saved).unwrap();
        assert_eq!(historical.target_speed_fraction(), 0.4);
        assert!(
            !plan(&historical, false)
                .iter()
                .any(|s| s.name.contains("bursts"))
        );
    }
    #[test]
    fn rs00_preset_increases_measured_dynamic_range_in_simulation() {
        use crate::{engine, types::Parameters};
        use std::sync::atomic::AtomicBool;
        let mut new = Config {
            profile: crate::types::Profile::presets()[0].clone(),
            ..Default::default()
        };
        new.apply_spec_limits();
        let old = Config {
            excitation_revision: 0,
            torque_limit: 0.7,
            speed_limit: 6.597344572538566,
            travel_limit: 12.,
            sweep_start_hz: 0.2,
            sweep_end_hz: 5.,
            ..new.clone()
        };
        let p = Parameters {
            armature: 0.0228,
            damping: 0.0313,
            friction: 0.0752,
            delay: 0.0067,
            static_friction: 0.,
        };
        let cancel = AtomicBool::new(false);
        let baseline = engine::demo_trace(&old, &p, false, &cancel).unwrap();
        let dynamic = engine::demo_trace(&new, &p, false, &cancel).unwrap();
        let peak = |t: &crate::types::Trace| {
            t.samples
                .iter()
                .map(|s| s.velocity.abs())
                .fold(0., f64::max)
        };
        let before = peak(&baseline);
        let after = peak(&dynamic);
        println!(
            "RS00 simulated peak speed: {before:.3} -> {after:.3} rad/s; cutoff {:.3}",
            new.speed_limit
        );
        assert!(after > 3. * before, "{before} -> {after}");
        assert!(
            dynamic
                .samples
                .iter()
                .all(|s| s.velocity.abs() < new.speed_limit && s.position.abs() < new.travel_limit)
        );
        assert!(
            dynamic
                .commands
                .iter()
                .any(|s| s.torque > 0.95 * new.torque_limit)
        );
        assert!(
            dynamic
                .commands
                .iter()
                .any(|s| s.torque < -0.95 * new.torque_limit)
        );
    }
    #[test]
    fn chirp_instantaneous_frequency_reaches_requested_endpoints() {
        for (t, f) in [(0., 0.2), (10., 5.)] {
            let measured =
                (chirp_phase(t + 1e-5, 10., 0.2, 5.) - chirp_phase(t, 10., 0.2, 5.)) / 1e-5 / TAU;
            assert!((measured - f).abs() < 1e-4);
        }
    }
}
