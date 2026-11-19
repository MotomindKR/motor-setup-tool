use crate::{bridge, engine, fit, types::*};
use anyhow::{Context, Result};
use std::{fs, io, path::Path, sync::atomic::AtomicBool};

fn rmse(a: &[f64], b: &[f64]) -> f64 {
    (a.iter().zip(b).map(|(x, y)| (x - y).powi(2)).sum::<f64>() / a.len() as f64).sqrt()
}
pub fn analyze(dir: &Path, cancel: &AtomicBool, progress: impl Fn(WorkProgress)) -> Result<Report> {
    progress(WorkProgress::fitting(0., "Checking recorded measurements"));
    let recording = fs::File::open(dir.join("session.json")).context("Open session.json")?;
    recording
        .try_lock()
        .context("Cannot lock session.json for refitting")?;
    let session: Session =
        serde_json::from_reader(io::BufReader::new(&recording)).context("Invalid session.json")?;
    anyhow::ensure!(
        session.source == "hardware",
        "Choose a real motor recording; synthetic sessions are no longer supported"
    );
    fit::validate(&session)?;
    let fitted = fit::identify(
        &session.traces[0],
        session.config.torque_limit,
        cancel,
        &progress,
    )?;
    finish(&session, fitted, dir, cancel, &progress)
}
pub fn write_plan(c: &Config, dir: &Path) -> Result<()> {
    bridge::write_json(
        &dir.join("experiment_plan.json"),
        &serde_json::json!({
            "training":crate::experiment::plan(c,false), "validation":crate::experiment::plan(c,true),
            "motor_spec":c.profile.spec(), "specification_revision":c.profile.manual_revision(),
            "sweep_start_hz":c.sweep_start_hz,"sweep_end_hz":c.sweep_end_hz,
            "torque_limit_nm":c.torque_limit,"speed_limit_rad_s":c.speed_limit,
            "target_speed_peak_rad_s":c.speed_limit*c.target_speed_fraction(),"excitation_revision":c.excitation_revision,
            "notes":"Rated torque assumes specified cooling; test caps are app bench policy, not manufacturer limits."
        }),
    )
}
fn finish(
    session: &Session,
    fit: fit::Fit,
    dir: &Path,
    cancel: &AtomicBool,
    progress: &impl Fn(WorkProgress),
) -> Result<Report> {
    let fitted = fit.parameters;
    let mut warnings = vec![
        "Torque gain is fixed at 1; inertia and friction are conditional estimates.".into(),
        "Delay includes host/CAN/feedback effects; internal delays are not separately identified."
            .into(),
    ];
    warnings.extend(fit.diagnostics.notes.clone());
    if fitted.static_friction > fitted.friction {
        warnings.push("Velocity-dependent breakaway friction and delay require replay_wrapper.py; XML alone does not reproduce this model.".into());
    }
    warnings.push(format!(
        "Decoded wire ranges: position ±{:.5} rad, speed ±{:.2} rad/s, torque ±{:.2} Nm. These do not identify the installed firmware version.",
        session.config.profile.position_range,
        session.config.profile.velocity_range,
        session.config.profile.torque_range
    ));
    warnings.push(if session.config.profile.uses_documented_ranges() {
        "Wire ranges match the official model manual (private CAN types 1 and 2).".into()
    } else {
        "Custom/older wire ranges: these differ from the official model manual.".into()
    });
    let hardware: serde_json::Value = if dir.join("hardware.json").exists() {
        bridge::read_json(&dir.join("hardware.json"))?
    } else {
        serde_json::Value::Null
    };
    warnings.push(format!(
        "Recorded motor firmware version: {}",
        hardware["firmware_version"].as_str().unwrap_or("unknown")
    ));
    let provenance = dir.join("reprocessing.json");
    if provenance.exists() {
        let metadata: serde_json::Value = bridge::read_json(&provenance)?;
        warnings.push(format!(
            "Offline reprocessed recording: {}",
            metadata["reason"]
                .as_str()
                .unwrap_or("See reprocessing.json")
        ));
    }
    if !fit.converged {
        warnings.push("Optimizer did not converge; candidate needs another run.".into());
    }
    if fit.condition > 100. {
        warnings.push("Weak parameter separation; repeat with more varied motion.".into());
    }
    let mut intervals: Vec<_> = session.traces[0]
        .samples
        .windows(2)
        .map(|w| w[1].t - w[0].t)
        .collect();
    intervals.sort_by(f64::total_cmp);
    let dt = intervals[intervals.len() / 2];
    warnings.push(format!(
        "Delay estimates below the {:.1} ms feedback interval are not independently resolved.",
        dt * 1000.
    ));
    if fitted.delay > 0.048 {
        warnings.push(
            "Delay reached the 50 ms search boundary; inspect timing before applying.".into(),
        );
    }
    let mut replays = Vec::new();
    for (index, trace) in session.traces.iter().enumerate() {
        progress(WorkProgress::fitting(
            0.9 + 0.08 * index as f32 / session.traces.len() as f32,
            format!("Replaying {} in MuJoCo", trace.name),
        ));
        let pre = engine::replay(trace, &session.config.baseline, cancel)?;
        let post = engine::replay(trace, &fitted, cancel)?;
        let q: Vec<_> = trace.samples.iter().map(|s| s.position).collect();
        let v: Vec<_> = trace.samples.iter().map(|s| s.velocity).collect();
        let pre_q: Vec<_> = pre.iter().map(|s| s[0]).collect();
        let pre_v: Vec<_> = pre.iter().map(|s| s[1]).collect();
        let post_q: Vec<_> = post.iter().map(|s| s[0]).collect();
        let post_v: Vec<_> = post.iter().map(|s| s[1]).collect();
        replays.push(Replay {
            name: trace.name.clone(),
            t: trace.samples.iter().map(|s| s.t).collect(),
            pre_position_rmse: rmse(&q, &pre_q),
            post_position_rmse: rmse(&q, &post_q),
            pre_velocity_rmse: rmse(&v, &pre_v),
            post_velocity_rmse: rmse(&v, &post_v),
            command_t: trace.commands.iter().map(|c| c.t).collect(),
            command_torque: trace.commands.iter().map(|c| c.torque).collect(),
            reported_torque: trace.samples.iter().map(|s| s.reported_torque).collect(),
            measured_position: q,
            measured_velocity: v,
            pre_position: pre_q,
            pre_velocity: pre_v,
            post_position: post_q,
            post_velocity: post_v,
        });
    }
    let v = &replays[1];
    let v_rms = (v.measured_velocity.iter().map(|v| v * v).sum::<f64>() / v.t.len() as f64).sqrt();
    let accepted = fit.converged
        && fit.condition < 1000.
        && fitted.delay < 0.048
        && v.post_velocity_rmse <= v.pre_velocity_rmse * 1.02 + 0.005
        && v.post_position_rmse <= v.pre_position_rmse * 1.02 + 0.005
        && v.post_velocity_rmse < 0.05_f64.max(0.2 * v_rms);
    if !accepted {
        warnings.push(
            "Held-out validation failed. Candidate was NOT promoted to calibration.json.".into(),
        );
    }
    let report = Report {
        source: session.source.clone(),
        motor_id: session.config.motor_id,
        motor_uuid: hardware
            .get("uuid")
            .and_then(|uuid| serde_json::from_value(uuid.clone()).ok()),
        reference_angle_rad: session.config.reference_angle_rad,
        model: session.config.profile.model.clone(),
        fitted: fitted.clone(),
        baseline: session.config.baseline.clone(),
        accepted,
        warnings,
        replays,
        delay_resolution_s: dt,
        mujoco_version: mujoco_rs::mujoco_version().into(),
        diagnostics: fit.diagnostics,
    };
    progress(WorkProgress::fitting(0.99, "Saving results"));
    let staging = tempfile::tempdir_in(dir)?;
    let stage = staging.path();
    fs::write(
        stage.join("replay_wrapper.py"),
        include_str!("replay_wrapper.py"),
    )?;
    bridge::write_json(&stage.join("report.json"), &report)?;
    fs::write(
        stage.join("pre_calibration.xml"),
        engine::xml(&session.config.baseline),
    )?;
    fs::write(stage.join("candidate.xml"), engine::xml(&fitted))?;
    let artifact = serde_json::json!({
        "schema_version":1,"source":session.source,"motor_id":session.config.motor_id,
        "motor_uuid":report.motor_uuid,
        "reference_angle_rad":report.reference_angle_rad,
        "profile":session.config.profile,"parameters":fitted,"torque_gain_assumption":1.,
        "hardware":hardware,
        "uses_documented_wire_ranges":session.config.profile.uses_documented_ranges(),
        "protocol_reference":"RobStride model manuals, private CAN types 1 and 2",
        "motor_spec":session.config.profile.spec(),
        "identification":report.diagnostics,
        "friction_model":{"type":if fitted.static_friction > fitted.friction {"stribeck_constraint_bound"} else {"constant_frictionloss"},"speed_rad_s":engine::STRIBECK_SPEED,"requires_wrapper":fitted.static_friction > fitted.friction},
        "wrapper_required": fitted.delay > 0. || fitted.static_friction > fitted.friction,
        "coordinate_frame":"gearbox output shaft",
        "delay_semantics":"effective command-to-observation delay; avoid double-counting host delay",
        "status":if !accepted {"rejected_candidate"} else {"validated_on_bare_motor"},
        "mujoco_version":report.mujoco_version,"mujoco_rs_version":"6.1.0",
        "feedback_interval_s":dt,"training_condition_number":fit.condition,"warnings":report.warnings
    });
    bridge::write_json(&stage.join("candidate.json"), &artifact)?;
    if accepted {
        bridge::write_json(&stage.join("calibration.json"), &artifact)?;
        fs::write(stage.join("post_calibration.xml"), engine::xml(&fitted))?;
    }
    for replay in &report.replays {
        use std::io::Write;
        let mut out = std::io::BufWriter::new(fs::File::create(
            stage.join(format!("{}.csv", replay.name)),
        )?);
        writeln!(
            out,
            "time_s,measured_position_rad,pre_position_rad,post_position_rad,measured_velocity_rad_s,pre_velocity_rad_s,post_velocity_rad_s"
        )?;
        for i in 0..replay.t.len() {
            writeln!(
                out,
                "{},{},{},{},{},{},{}",
                replay.t[i],
                replay.measured_position[i],
                replay.pre_position[i],
                replay.post_position[i],
                replay.measured_velocity[i],
                replay.pre_velocity[i],
                replay.post_velocity[i]
            )?;
        }
        out.flush()?;
    }
    crate::cancel::check(cancel)?;
    publish(stage, dir, accepted)?;
    progress(WorkProgress::fitting(1., "Comparison ready"));
    Ok(report)
}

fn publish(stage: &Path, dir: &Path, accepted: bool) -> Result<()> {
    // report.json marks a complete run. Publish it only after all exports are in place.
    let mut files: Vec<_> = fs::read_dir(stage)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<io::Result<_>>()?;
    files.sort_by_key(|name| name == "report.json");
    let mut previous_files = files.clone();
    if !accepted {
        previous_files.extend(["calibration.json".into(), "post_calibration.xml".into()]);
    }
    previous_files.sort_by_key(|name| name != "report.json");
    let backup = tempfile::tempdir_in(dir)?;
    let mut replaced = Vec::new();
    let mut installed = Vec::new();
    let commit = (|| -> Result<()> {
        for name in &previous_files {
            let path = dir.join(name);
            match fs::symlink_metadata(&path) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                result => {
                    anyhow::ensure!(!result?.is_dir(), "Expected a file at {}", path.display())
                }
            }
            fs::rename(path, backup.path().join(name))?;
            replaced.push(name);
        }
        for name in &files {
            fs::rename(stage.join(name), dir.join(name))?;
            installed.push(name);
        }
        Ok(())
    })();
    if let Err(error) = commit {
        let rollback = (|| -> io::Result<()> {
            for name in installed {
                fs::remove_file(dir.join(name))?;
            }
            for name in replaced.into_iter().rev() {
                fs::rename(backup.path().join(name), dir.join(name))?;
            }
            Ok(())
        })();
        if let Err(failure) = rollback {
            return Err(error).context(format!(
                "Restore failed ({failure}). Previous results are in {}",
                backup.keep().display()
            ));
        }
        return Err(error).context("Publish calibration results");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Session, Parameters) {
        let c = Config {
            train_seconds: 10.,
            validation_seconds: 6.,
            experiment: crate::experiment::Experiment::Legacy,
            ..Default::default()
        };
        let truth = Parameters {
            armature: 0.023,
            damping: 0.013,
            friction: 0.028,
            delay: 0.017,
            static_friction: 0.,
        };
        let cancel = AtomicBool::new(false);
        let traces = vec![
            engine::demo_trace(&c, &truth, false, &cancel).unwrap(),
            engine::demo_trace(&c, &truth, true, &cancel).unwrap(),
        ];
        (
            Session {
                schema_version: 1,
                source: "demo".into(),
                config: c,
                complete: true,
                traces,
            },
            truth,
        )
    }
    #[test]
    fn identify_recovers_hidden_parameters_and_validates_unseen_motion() {
        let (s, truth) = fixture();
        let cancel = AtomicBool::new(false);
        fit::validate(&s).unwrap();
        let updates = std::cell::RefCell::new(Vec::new());
        let fit = fit::identify(&s.traces[0], s.config.torque_limit, &cancel, &|p| {
            updates.borrow_mut().push(p)
        })
        .unwrap();
        let updates = updates.into_inner();
        assert!(updates.windows(2).any(|w| w[0].fraction < w[1].fraction));
        assert!(
            updates
                .iter()
                .all(|p| p.phase == WorkPhase::Fitting && (0.0..=1.).contains(&p.fraction))
        );
        assert!(
            updates
                .windows(2)
                .all(|w| w[1].fraction + 1e-6 >= w[0].fraction)
        );
        assert!(fit.converged, "optimizer did not converge");
        for (actual, expected) in [
            (fit.parameters.armature, truth.armature),
            (fit.parameters.damping, truth.damping),
            (fit.parameters.friction, truth.friction),
        ] {
            assert!(
                (actual / expected - 1.).abs() < 0.08,
                "{actual} vs {expected}"
            );
        }
        assert!((fit.parameters.delay - truth.delay).abs() < 0.002);
        let pre = engine::replay(&s.traces[1], &s.config.baseline, &cancel).unwrap();
        let post = engine::replay(&s.traces[1], &fit.parameters, &cancel).unwrap();
        let loss = |x: Vec<[f64; 2]>| {
            x.iter()
                .zip(&s.traces[1].samples)
                .map(|(a, b)| (a[1] - b.velocity).powi(2))
                .sum::<f64>()
        };
        assert!(loss(post) < loss(pre) * 0.01);
    }
    #[test]
    fn moving_fit_recovers_parameters_on_diverse_motion() {
        for experiment in [
            crate::experiment::Experiment::Mixed,
            crate::experiment::Experiment::SineSweep,
            crate::experiment::Experiment::Multisine,
            crate::experiment::Experiment::Steps,
        ] {
            let c = Config {
                experiment,
                ..Default::default()
            };
            let truth = Parameters {
                armature: 0.012,
                damping: 0.008,
                friction: 0.025,
                static_friction: 0.,
                delay: 0.014,
            };
            let cancel = AtomicBool::new(false);
            let training = engine::demo_trace(&c, &truth, false, &cancel).unwrap();
            let validation = engine::demo_trace(&c, &truth, true, &cancel).unwrap();
            let fit = fit::identify(&training, c.torque_limit, &cancel, &|_| {}).unwrap();
            let refinement = fit.diagnostics.trajectory_refinement.as_ref().unwrap();
            assert!(refinement.training_objective_after <= refinement.training_objective_before);
            assert_eq!(fit.parameters.static_friction, 0.);
            assert!(
                (fit.parameters.armature / truth.armature - 1.).abs() < 0.12,
                "{:?}",
                fit.parameters
            );
            assert!(
                (fit.parameters.delay - truth.delay).abs() < 0.003,
                "{:?}",
                fit.parameters
            );
            let replay = engine::replay(&validation, &fit.parameters, &cancel).unwrap();
            let error = (replay
                .iter()
                .zip(&validation.samples)
                .map(|(m, s)| (m[1] - s.velocity).powi(2))
                .sum::<f64>()
                / replay.len() as f64)
                .sqrt();
            assert!(error < 0.15, "Held-out RMSE {error}; {:?}", fit.parameters);
        }
    }
    #[test]
    fn invalid_or_unexcited_sessions_are_rejected() {
        let (s, _) = fixture();
        let mut broken = s.clone();
        broken.complete = false;
        assert!(fit::validate(&broken).is_err());
        let mut broken = s.clone();
        broken.traces[0].samples[5].t = 0.;
        assert!(fit::validate(&broken).is_err());
        let mut broken = s.clone();
        broken.traces[0].samples.drain(20..50);
        assert!(fit::validate(&broken).is_err());
        let mut broken = s.clone();
        for sample in &mut broken.traces[0].samples {
            sample.velocity = 0.;
        }
        assert!(fit::validate(&broken).is_err());
        let mut broken = s;
        broken.traces[0].samples[5].position = f64::NAN;
        assert!(fit::validate(&broken).is_err());
    }
    #[test]
    fn inconsistent_wire_velocity_is_rejected_in_either_trace() {
        let (s, _) = fixture();
        for index in 0..2 {
            let mut broken = s.clone();
            for sample in &mut broken.traces[index].samples {
                sample.velocity *= 33. / 50.;
            }
            let error = fit::validate(&broken).unwrap_err().to_string();
            assert!(error.contains("scaling mismatch"), "{error}");
            assert!(error.contains(&broken.traces[index].name), "{error}");
        }
    }
    #[test]
    fn failed_validation_does_not_promote_and_removes_stale_export() {
        let (mut s, truth) = fixture();
        for sample in &mut s.traces[1].samples {
            sample.position *= 3.;
            sample.velocity *= 3.;
        }
        let run = tempfile::tempdir().unwrap();
        let dir = run.path();
        fs::write(dir.join("calibration.json"), "stale").unwrap();
        let fit = fit::Fit {
            parameters: truth,
            converged: true,
            condition: 5.,
            diagnostics: FitDiagnostics::default(),
        };
        let report = finish(&s, fit, dir, &AtomicBool::new(false), &|_| {}).unwrap();
        assert!(!report.accepted);
        assert!(!dir.join("calibration.json").exists());
        assert!(dir.join("candidate.xml").exists());
    }
    #[test]
    fn cancellation_preserves_saved_results() {
        let (session, parameters) = fixture();
        let run = tempfile::tempdir().unwrap();
        fs::write(run.path().join("replay_wrapper.py"), "original").unwrap();
        let fit = fit::Fit {
            parameters,
            converged: true,
            condition: 5.,
            diagnostics: FitDiagnostics::default(),
        };
        let cancel = AtomicBool::new(false);
        let result = finish(&session, fit, run.path(), &cancel, &|_| {
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        });
        assert!(result.unwrap_err().is::<crate::cancel::Cancelled>());
        assert_eq!(
            fs::read(run.path().join("replay_wrapper.py")).unwrap(),
            b"original"
        );
        assert_eq!(fs::read_dir(run.path()).unwrap().count(), 1);
    }

    #[test]
    fn publication_failure_restores_prior_report_and_exports() {
        let run = tempfile::tempdir().unwrap();
        let stage = tempfile::tempdir_in(run.path()).unwrap();
        for name in ["report.json", "training.csv"] {
            fs::write(stage.path().join(name), "replacement").unwrap();
        }
        fs::write(run.path().join("report.json"), "previous report").unwrap();
        fs::create_dir(run.path().join("training.csv")).unwrap();
        assert!(publish(stage.path(), run.path(), false).is_err());
        assert_eq!(
            fs::read(run.path().join("report.json")).unwrap(),
            b"previous report"
        );
        assert!(run.path().join("training.csv").is_dir());
    }
}
