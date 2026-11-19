use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::LazyLock};

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
#[derive(Deserialize)]
struct MotorModel {
    firmware_family: u8,
    preset_revision: u32,
    velocity_range: f64,
    torque_range: f64,
    spec: MotorSpec,
}

static MODELS: LazyLock<BTreeMap<String, MotorModel>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../electron/motor-models.json")).expect("valid motor models")
});

impl Profile {
    pub fn model_for_family(family: u8) -> Option<&'static str> {
        MODELS
            .iter()
            .find(|(_, entry)| entry.firmware_family == family)
            .map(|(model, _)| model.as_str())
    }

    pub fn spec(&self) -> Option<&'static MotorSpec> {
        Some(&MODELS.get(&self.model)?.spec)
    }

    pub fn manual_revision(&self) -> Option<String> {
        let revision = MODELS.get(&self.model)?.preset_revision;
        Some(format!(
            "{:04}-{:02}-{:02}",
            revision / 10000,
            revision / 100 % 100,
            revision % 100
        ))
    }

    pub fn preset(model: &str) -> Option<Self> {
        let entry = MODELS.get(model)?;
        Some(Self {
            model: model.into(),
            position_range: 4. * std::f64::consts::PI,
            velocity_range: entry.velocity_range,
            torque_range: entry.torque_range,
            preset_revision: entry.preset_revision,
        })
    }

    #[cfg(test)]
    pub fn presets() -> Vec<Self> {
        MODELS
            .keys()
            .map(|name| Self::preset(name).unwrap())
            .collect()
    }

    fn same_ranges(&self, other: &Self) -> bool {
        self.position_range == other.position_range
            && self.velocity_range == other.velocity_range
            && self.torque_range == other.torque_range
    }
    pub fn uses_documented_ranges(&self) -> bool {
        Self::preset(&self.model).is_some_and(|p| self.same_ranges(&p))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub excitation_revision: u32,
    pub interface: String,
    pub motor_id: u8,
    pub host_id: u8,
    #[serde(default)]
    pub reference_angle_rad: f64,
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
        Self::preset("RS-01").expect("valid default motor preset")
    }
}
impl Config {
    pub fn preset(model: &str) -> Result<Self> {
        let profile =
            Profile::preset(model).with_context(|| format!("Unknown motor model: {model}"))?;
        let spec = &MODELS[model].spec;
        let config = Self {
            excitation_revision: 1,
            interface: "can0".into(),
            motor_id: 1,
            host_id: 253,
            reference_angle_rad: 0.,
            torque_limit: spec.bench_torque_max().min(profile.torque_range * 0.1),
            speed_limit: 0.45 * spec.speed_rad_s().min(profile.velocity_range),
            profile,
            travel_limit: 24.,
            temperature_limit: 55.,
            sample_hz: 200.,
            train_seconds: 40.,
            validation_seconds: 20.,
            baseline: Parameters::default(),
            experiment: crate::experiment::Experiment::Mixed,
            sweep_start_hz: 0.15,
            sweep_end_hz: 8.,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn target_speed_fraction(&self) -> f64 {
        if self.excitation_revision >= 1 {
            0.75
        } else {
            0.4
        }
    }
    pub fn input_fields(&self) -> Result<impl Iterator<Item = (&'static str, f64, [f64; 2])>> {
        let spec = self
            .profile
            .spec()
            .context("Select a supported motor model")?;
        let legacy = self.experiment == crate::experiment::Experiment::Legacy;
        Ok([
            (
                "torque_limit",
                self.torque_limit,
                [
                    0.001,
                    spec.bench_torque_max().min(self.profile.torque_range * 0.1),
                ],
            ),
            (
                "speed_limit",
                self.speed_limit,
                [
                    0.1,
                    spec.speed_rad_s().min(self.profile.velocity_range) * 0.5,
                ],
            ),
            ("travel_limit", self.travel_limit, [0.1, 100.]),
            ("temperature_limit", self.temperature_limit, [20., 70.]),
            (
                "train_seconds",
                self.train_seconds,
                [if legacy { 8. } else { 20. }, 60.],
            ),
            (
                "validation_seconds",
                self.validation_seconds,
                [if legacy { 6. } else { 10. }, 60.],
            ),
            ("sample_hz", self.sample_hz, [50., 500.]),
            ("sweep_start_hz", self.sweep_start_hz, [0.05, 20.]),
            ("sweep_end_hz", self.sweep_end_hz, [0.1, 20.]),
            ("armature", self.baseline.armature, [1e-6, 5.]),
            ("damping", self.baseline.damping, [0., 10.]),
            ("friction", self.baseline.friction, [0., 100.]),
            ("delay", self.baseline.delay, [0., 0.1]),
            (
                "static_friction",
                self.baseline.static_friction,
                [0., spec.peak_torque],
            ),
        ]
        .into_iter())
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.reference_angle_rad.is_finite() && self.reference_angle_rad.abs() <= 100.,
            "Reference angle must be within ±100 rad"
        );
        ensure!((1..=254).contains(&self.motor_id), "Motor ID must be 1–254");
        ensure!(
            self.host_id != self.motor_id && (1..=254).contains(&self.host_id),
            "Host ID must be 1–254 and distinct from motor ID"
        );
        for (name, value, [lo, hi]) in self.input_fields()?.chain([
            ("wire position", self.profile.position_range, [0.1, 100.]),
            ("wire speed", self.profile.velocity_range, [0.1, 1000.]),
            ("wire torque", self.profile.torque_range, [0.01, 1000.]),
            (
                "sweep end Hz",
                self.sweep_end_hz,
                [self.sweep_start_hz + 0.05, self.sample_hz / 10.],
            ),
        ]) {
            ensure!(
                (lo..=hi).contains(&value),
                "{} must be {lo} … {hi}",
                name.replace('_', " ")
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motor_uuid: Option<[u8; 8]>,
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
    pub motor_uuid: Option<[u8; 8]>,
    #[serde(default)]
    pub reference_angle_rad: f64,
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
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProgressLabel {
    Text {
        text: &'static str,
    },
    Scan {
        id: u8,
    },
    Capture {
        trace: &'static str,
        phase: String,
        elapsed: f64,
        duration: f64,
    },
    FitIteration {
        stage: &'static str,
        iteration: usize,
        total: usize,
    },
    FitComplete {
        stage: &'static str,
    },
    Replay {
        trace: String,
    },
    PrepareFirmware {
        model: String,
        version: String,
    },
    WriteFirmware {
        sent: usize,
        total: usize,
    },
    UpdatedFirmware {
        model: String,
        id: u8,
        version: String,
    },
}

impl From<&'static str> for ProgressLabel {
    fn from(text: &'static str) -> Self {
        Self::Text { text }
    }
}

impl std::fmt::Display for ProgressLabel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        use ProgressLabel::*;
        match self {
            Text { text } => f.write_str(text),
            Scan { id } => write!(f, "Checking CAN IDs · {id} / 254"),
            Capture {
                trace,
                phase,
                elapsed,
                duration,
            } => write!(f, "{trace} · {phase} · {elapsed:.1} / {duration:.0} s"),
            FitIteration {
                stage,
                iteration,
                total,
            } => write!(f, "{stage} · iteration {iteration} / {total}"),
            FitComplete { stage } => write!(f, "{stage} complete"),
            Replay { trace } => write!(f, "Replaying {trace} in MuJoCo"),
            PrepareFirmware { model, version } => {
                write!(f, "Preparing official {model} firmware {version}")
            }
            WriteFirmware { sent, total } => write!(f, "Writing firmware · {sent}/{total} packets"),
            UpdatedFirmware { model, id, version } => {
                write!(f, "{model} ID {id} updated to {version} · motor stopped")
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct WorkProgress {
    pub phase: WorkPhase,
    pub fraction: f32,
    pub label: ProgressLabel,
}
impl WorkProgress {
    pub fn scanning(id: u8) -> Self {
        Self {
            phase: WorkPhase::Scanning,
            fraction: id as f32 / 254.,
            label: ProgressLabel::Scan { id },
        }
    }
    pub fn recording(fraction: f32, label: impl Into<ProgressLabel>) -> Self {
        Self {
            phase: WorkPhase::Recording,
            fraction: fraction.clamp(0., 1.),
            label: label.into(),
        }
    }
    pub fn fitting(fraction: f32, label: impl Into<ProgressLabel>) -> Self {
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
