use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Parameters {
    pub armature: f64,
    pub damping: f64,
    pub friction: f64,
    pub delay: f64,
    /// New fits use zero (constant friction). Retained to replay historical peaks.
    #[serde(default)]
    pub static_friction: f64,
}
impl Default for Parameters {
    fn default() -> Self {
        Self {
            armature: 0.01,
            damping: 0.005,
            friction: 0.02,
            delay: 0.0,
            static_friction: 0.,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MotorSpec {
    pub rated_torque: f64,
    pub peak_torque: f64,
    pub no_load_rpm: f64,
    pub gear_ratio: f64,
    pub rated_voltage: f64,
}
impl MotorSpec {
    pub fn speed_rad_s(&self) -> f64 {
        self.no_load_rpm * std::f64::consts::TAU / 60.
    }
    // Bench policy, NOT manufacturer ratings or a full-load operating guarantee.
    pub fn bench_torque_max(&self) -> f64 {
        (0.25 * self.rated_torque).min(0.1 * self.peak_torque)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    pub model: String,
    pub position_range: f64,
    pub velocity_range: f64,
    pub torque_range: f64,
    #[serde(default)]
    pub preset_revision: u32,
}
impl Profile {
    pub fn spec(&self) -> Option<MotorSpec> {
        let i = Self::presets().iter().position(|p| p.model == self.model)?;
        let (rated, peak, rpm, gear, volts) = [
            (5., 14., 315., 10., 48.),
            (7., 17., 315., 7.75, 36.),
            (7., 17., 410., 7.75, 48.),
            (21., 60., 195., 9., 48.),
            (35., 120., 200., 9., 48.),
            (1.8, 5.5, 480., 7.75, 48.),
            (11., 36., 480., 9., 48.),
        ][i];
        Some(MotorSpec {
            rated_torque: rated,
            peak_torque: peak,
            no_load_rpm: rpm,
            gear_ratio: gear,
            rated_voltage: volts,
        })
    }
    // Official model manuals dated 2026-07-13, private CAN types 1 and 2.
    // See docs/protocol.md for pinned sources. These are NOT rated limits.
    pub fn presets() -> Vec<Self> {
        [
            (33., 14.),
            (44., 17.),
            (44., 17.),
            (20., 60.),
            (15., 120.),
            (50., 5.5),
            (50., 36.),
        ]
        .iter()
        .enumerate()
        .map(|(i, &(v, t))| Self {
            model: format!("RS-{i:02}"),
            position_range: 4. * std::f64::consts::PI,
            velocity_range: v,
            torque_range: t,
            preset_revision: 20260713,
        })
        .collect()
    }
    pub fn documented(&self) -> Option<Self> {
        Self::presets().into_iter().find(|p| p.model == self.model)
    }
    fn same_ranges(&self, other: &Self) -> bool {
        self.position_range == other.position_range
            && self.velocity_range == other.velocity_range
            && self.torque_range == other.torque_range
    }
    pub fn uses_documented_ranges(&self) -> bool {
        self.documented().is_some_and(|p| self.same_ranges(&p))
    }
    /// One-time migration of known old built-in presets, never saved sessions.
    /// Preserve custom settings, including later explicit overrides.
    pub fn migrate_saved_preset(&mut self) -> bool {
        if self.preset_revision != 0 {
            return false;
        }
        let Some(latest) = self.documented() else {
            return false;
        };
        let old = [
            (50., 17.),
            (44., 17.),
            (44., 17.),
            (50., 60.),
            (15., 120.),
            (33., 17.),
            (20., 60.),
        ];
        let i: usize = self.model[3..].parse().unwrap();
        let known = self.same_ranges(&latest)
            || (self.position_range == latest.position_range
                && (self.velocity_range, self.torque_range) == old[i]);
        self.preset_revision = 20260713;
        if known {
            let changed = !self.same_ranges(&latest);
            *self = latest;
            changed
        } else {
            false
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub excitation_revision: u32,
    pub interface: String,
    pub motor_id: u8,
    pub host_id: u8,
    pub profile: Profile,
    pub torque_limit: f64,
    pub speed_limit: f64,
    pub travel_limit: f64,
    pub temperature_limit: f64,
    pub sample_hz: f64,
    pub train_seconds: f64,
    pub validation_seconds: f64,
    pub baseline: Parameters,
    #[serde(default = "crate::experiment::legacy")]
    pub experiment: crate::experiment::Experiment,
    #[serde(default = "crate::experiment::default_start_hz")]
    pub sweep_start_hz: f64,
    #[serde(default = "crate::experiment::default_end_hz")]
    pub sweep_end_hz: f64,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            excitation_revision: 1,
            interface: "can0".into(),
            motor_id: 1,
            host_id: 253,
            profile: Profile::presets()[1].clone(),
            torque_limit: 1.7,
            speed_limit: 14.844025288211773,
            travel_limit: 24.,
            temperature_limit: 55.,
            sample_hz: 200.,
            train_seconds: 40.,
            validation_seconds: 20.,
            baseline: Parameters::default(),
            experiment: crate::experiment::Experiment::Mixed,
            sweep_start_hz: 0.15,
            sweep_end_hz: 8.,
        }
    }
}
impl Config {
    pub fn target_speed_fraction(&self) -> f64 {
        if self.excitation_revision >= 1 {
            0.75
        } else {
            0.4
        }
    }
    pub fn apply_spec_limits(&mut self) {
        if let Some(spec) = self.profile.spec() {
            let (rated, peak, speed, travel, f0, f1) = (0.25, 0.1, 0.45, 24., 0.15, 8.);
            self.excitation_revision = 1;
            self.torque_limit = (rated * spec.rated_torque)
                .min(peak * spec.peak_torque)
                .min(self.profile.torque_range * 0.1);
            self.speed_limit =
                (speed * spec.speed_rad_s()).min(speed * self.profile.velocity_range);
            self.travel_limit = travel;
            self.sweep_start_hz = f0;
            self.sweep_end_hz = f1;
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.experiment != crate::experiment::Experiment::Legacy {
            ensure!(
                self.train_seconds >= 20. && self.validation_seconds >= 10.,
                "New measurement plans need at least 20 s training and 10 s validation; recommended 40/20 s"
            );
        }
        let spec = self
            .profile
            .spec()
            .ok_or_else(|| anyhow::anyhow!("Select a supported motor model"))?;
        ensure!((1..=254).contains(&self.motor_id), "Motor ID must be 1–254");
        ensure!(
            self.host_id != self.motor_id && (1..=254).contains(&self.host_id),
            "Host ID must be 1–254 and distinct from motor ID"
        );
        for (name, value, lo, hi) in [
            ("wire position", self.profile.position_range, 0.1, 100.),
            ("wire speed", self.profile.velocity_range, 0.1, 1000.),
            ("wire torque", self.profile.torque_range, 0.01, 1000.),
            (
                "torque limit",
                self.torque_limit,
                0.001,
                spec.bench_torque_max().min(self.profile.torque_range * 0.1),
            ),
            (
                "speed limit",
                self.speed_limit,
                0.1,
                (spec.speed_rad_s() * 0.5).min(self.profile.velocity_range * 0.5),
            ),
            ("travel limit", self.travel_limit, 0.1, 100.),
            ("temperature limit", self.temperature_limit, 20., 70.),
            ("sample rate", self.sample_hz, 50., 500.),
            ("training duration", self.train_seconds, 8., 60.),
            ("validation duration", self.validation_seconds, 6., 60.),
            ("baseline armature", self.baseline.armature, 1e-6, 5.),
            ("baseline damping", self.baseline.damping, 0., 10.),
            ("baseline friction", self.baseline.friction, 0., 100.),
            ("baseline delay", self.baseline.delay, 0., 0.1),
            (
                "baseline static friction",
                self.baseline.static_friction,
                0.,
                spec.peak_torque,
            ),
            ("sweep start Hz", self.sweep_start_hz, 0.05, 20.),
            (
                "sweep end Hz",
                self.sweep_end_hz,
                self.sweep_start_hz + 0.05,
                (self.sample_hz / 10.).min(20.),
            ),
        ] {
            ensure!(
                value.is_finite() && (lo..=hi).contains(&value),
                "{name} must be {lo} … {hi}"
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Command {
    pub t: f64,
    pub torque: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Sample {
    pub t: f64,
    pub position: f64,
    pub velocity: f64,
    pub reported_torque: f64,
    pub temperature: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Trace {
    pub name: String,
    pub commands: Vec<Command>,
    pub samples: Vec<Sample>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    pub schema_version: u32,
    pub source: String,
    pub config: Config,
    pub traces: Vec<Trace>,
    pub complete: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Replay {
    pub name: String,
    pub t: Vec<f64>,
    pub measured_position: Vec<f64>,
    pub measured_velocity: Vec<f64>,
    pub pre_position: Vec<f64>,
    pub pre_velocity: Vec<f64>,
    pub post_position: Vec<f64>,
    pub post_velocity: Vec<f64>,
    pub pre_position_rmse: f64,
    pub post_position_rmse: f64,
    pub pre_velocity_rmse: f64,
    pub post_velocity_rmse: f64,
    #[serde(default)]
    pub command_t: Vec<f64>,
    #[serde(default)]
    pub command_torque: Vec<f64>,
    #[serde(default)]
    pub reported_torque: Vec<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Report {
    pub source: String,
    pub fitted: Parameters,
    pub baseline: Parameters,
    #[serde(default)]
    pub motor_id: u8,
    #[serde(default)]
    pub model: String,
    pub accepted: bool,
    pub warnings: Vec<String>,
    pub replays: Vec<Replay>,
    pub delay_resolution_s: f64,
    pub mujoco_version: String,
    #[serde(default)]
    pub diagnostics: FitDiagnostics,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FitDiagnostics {
    #[serde(default)]
    pub trajectory_refinement: Option<TrajectoryRefinement>,
    pub moving_windows: usize,
    pub breakaway_events: usize,
    pub moving_velocity_normalized_rmse: f64,
    pub breakaway_search: Vec<(f64, f64)>,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrajectoryRefinement {
    pub moving_seed: Parameters,
    pub training_objective_before: f64,
    pub training_objective_after: f64,
}

/// Excites several speeds, acceleration directions and rest periods. Validation
/// uses a different waveform. Feedback is only used to bound the experiment;
/// replay always uses the recorded, quantized torque commands, never this law.
pub fn excitation(t: f64, velocity: f64, config: &Config, validation: bool) -> f64 {
    let target = if validation {
        config.speed_limit * 0.35 * ((t * 1.7).sin() + 0.35 * (t * 4.3).sin())
    } else {
        let levels = [0., 0.18, 0.38, 0.12, 0., -0.18, -0.38, -0.12];
        config.speed_limit * levels[((t / 0.75) as usize) % levels.len()]
    };
    let dither = if validation {
        (t * 23.).sin()
    } else {
        (t * 31. + 1.5 * t * t).sin()
    };
    (config.torque_limit * (2.5 * (target - velocity) / config.speed_limit + 0.10 * dither))
        .clamp(-config.torque_limit, config.torque_limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_legacy_presets_migrate_once_and_custom_ranges_are_preserved() {
        let mut p = Profile::presets()[0].clone();
        p.preset_revision = 0;
        p.velocity_range = 50.;
        p.torque_range = 17.;
        assert!(p.migrate_saved_preset());
        assert_eq!((p.velocity_range, p.torque_range), (33., 14.));
        assert!(p.uses_documented_ranges());
        // A subsequent deliberate override must not be migrated again.
        p.velocity_range = 50.;
        p.torque_range = 17.;
        assert!(!p.migrate_saved_preset());
        assert_eq!(p.velocity_range, 50.);
        assert!(!p.uses_documented_ranges());
        p.preset_revision = 0;
        p.torque_range = 13.;
        assert!(!p.migrate_saved_preset());
        assert_eq!((p.velocity_range, p.torque_range), (50., 13.));
    }
    #[test]
    fn july_2026_manual_ranges_match_all_models() {
        let actual: Vec<_> = Profile::presets()
            .iter()
            .map(|p| (p.velocity_range, p.torque_range))
            .collect();
        assert_eq!(
            actual,
            [
                (33., 14.),
                (44., 17.),
                (44., 17.),
                (20., 60.),
                (15., 120.),
                (50., 5.5),
                (50., 36.)
            ]
        );
    }
    #[test]
    fn configuration_rejects_unsafe_and_nonfinite_values() {
        let mut c = Config::default();
        assert!(c.validate().is_ok());
        c.torque_limit = f64::NAN;
        assert!(c.validate().is_err());
        c.torque_limit = c.profile.torque_range;
        assert!(c.validate().is_err());
    }
    #[test]
    fn excitation_is_bounded_even_when_overspeed() {
        let c = Config::default();
        for i in 0..1000 {
            assert!(excitation(i as f64 / 100., 100., &c, false).abs() <= c.torque_limit);
        }
    }
}

/// Progress reports completed work, never an estimated convergence time.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WorkPhase {
    Scanning,
    Recording,
    Fitting,
}
#[derive(Clone, Debug)]
pub struct WorkProgress {
    pub phase: WorkPhase,
    pub fraction: f32,
    pub label: String,
}
impl WorkProgress {
    pub fn scanning(id: u8) -> Self {
        Self {
            phase: WorkPhase::Scanning,
            fraction: id as f32 / 254.,
            label: format!("Checking CAN IDs · {id} / 254"),
        }
    }
    pub fn recording(fraction: f32, label: impl Into<String>) -> Self {
        Self {
            phase: WorkPhase::Recording,
            fraction: fraction.clamp(0., 1.),
            label: label.into(),
        }
    }
    pub fn fitting(fraction: f32, label: impl Into<String>) -> Self {
        Self {
            phase: WorkPhase::Fitting,
            fraction: fraction.clamp(0., 1.),
            label: label.into(),
        }
    }
}
impl std::fmt::Display for WorkProgress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{:?} {:.0}% · {}",
            self.phase,
            self.fraction * 100.,
            self.label
        )
    }
}
