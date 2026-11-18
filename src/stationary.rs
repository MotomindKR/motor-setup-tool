//! Confirm standstill from position and several speed reports, not one noisy reply.
use crate::protocol::Feedback;
use std::{collections::VecDeque, time::Duration};

const WINDOW: Duration = Duration::from_millis(100);
const MIN_SAMPLES: usize = 5;
// About eight position ticks at the protocol's ±4π range.
const POSITION_SPAN: f64 = 0.003;
const REPORTED_SPEED: f64 = 0.15;

pub(crate) struct StationaryCheck {
    range: f64,
    previous_raw: Option<f64>,
    position: f64,
    samples: VecDeque<(Duration, f64, f64)>,
}

impl StationaryCheck {
    pub(crate) fn new(position_range: f64) -> Self {
        Self {
            range: position_range,
            previous_raw: None,
            position: 0.,
            samples: VecDeque::new(),
        }
    }

    pub(crate) fn observe(&mut self, feedback: &Feedback, at: Duration) {
        if feedback.mode != 0 || !feedback.position.is_finite() || !feedback.velocity.is_finite() {
            self.clear();
            return;
        }
        if self
            .samples
            .back()
            .is_some_and(|&(previous, _, _)| at < previous || at.saturating_sub(previous) > WINDOW)
        {
            self.clear();
        }
        if let Some(raw) = self.previous_raw {
            self.position +=
                (feedback.position - raw + self.range).rem_euclid(2. * self.range) - self.range;
        }
        self.previous_raw = Some(feedback.position);
        // Keep an anchor at or just before the start of the observation window.
        while self.samples.len() > 1 && at - self.samples[1].0 >= WINDOW {
            self.samples.pop_front();
        }
        self.samples
            .push_back((at, self.position, feedback.velocity));
    }

    pub(crate) fn is_stationary(&self) -> bool {
        self.has_window() && !self.motion_detected()
    }

    /// Also usable while monitoring an already confirmed stationary motor.
    pub(crate) fn motion_detected(&self) -> bool {
        let mut low = f64::INFINITY;
        let mut high = f64::NEG_INFINITY;
        for &(_, position, _) in &self.samples {
            low = low.min(position);
            high = high.max(position);
        }
        if high - low > POSITION_SPAN {
            return true;
        }
        if !self.has_window() {
            return false;
        }
        // Signed speed noise straddles zero at standstill. A median rejects an
        // isolated spike; position span still detects motion that changes direction.
        let mut speeds: Vec<_> = self.samples.iter().map(|sample| sample.2).collect();
        speeds.sort_unstable_by(f64::total_cmp);
        let middle = speeds.len() / 2;
        let median = if speeds.len().is_multiple_of(2) {
            (speeds[middle - 1] + speeds[middle]) / 2.
        } else {
            speeds[middle]
        };
        median.abs() >= REPORTED_SPEED
    }

    fn has_window(&self) -> bool {
        self.samples.len() >= MIN_SAMPLES
            && self.samples.back().unwrap().0 - self.samples.front().unwrap().0 >= WINDOW
    }

    fn clear(&mut self) {
        self.previous_raw = None;
        self.position = 0.;
        self.samples.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    fn feedback(position: f64, velocity: f64) -> Feedback {
        Feedback {
            position,
            velocity,
            torque: 0.,
            temperature: 25.,
            faults: 0,
            mode: 0,
        }
    }

    #[test]
    fn stationary_encoder_tolerates_captured_rs06_speed_spikes() {
        // RS-06 recording 1794983084206-92370: one encoder tick of jitter
        // while reported speed occasionally crosses the old 0.15 rad/s cutoff.
        let mut check = StationaryCheck::new(2. * TAU);
        for (i, (micros, position, speed)) in [
            (0, -7.007714663498433, -0.10757610437170939),
            (20_111, -7.007331162449699, 0.01907377737087046),
            (39_991, -7.007331162449699, 0.16403448538948595),
            (59_966, -7.007331162449699, 0.10452429999237012),
            (79_961, -7.007331162449699, -0.031280994888227553),
            (100_164, -7.007331162449699, -0.05111772335393283),
        ]
        .into_iter()
        .enumerate()
        {
            check.observe(&feedback(position, speed), Duration::from_micros(micros));
            assert_eq!(check.is_stationary(), i == 5);
            assert!(!check.motion_detected());
        }
    }

    #[test]
    fn actual_motion_and_persistently_high_speed_are_rejected() {
        for direction in [-1., 1.] {
            for frozen_position in [false, true] {
                let mut check = StationaryCheck::new(2. * TAU);
                for i in 0..=5 {
                    let position = if frozen_position {
                        0.
                    } else {
                        i as f64 * 0.004
                    };
                    check.observe(
                        &feedback(direction * position, direction * 0.2),
                        Duration::from_millis(i * 20),
                    );
                }
                assert!(!check.is_stationary());
                assert!(check.motion_detected());
            }
        }
    }

    #[test]
    fn reversing_motion_cannot_cancel_out_in_the_speed_median() {
        let mut check = StationaryCheck::new(2. * TAU);
        for i in 0..=5 {
            let direction = if i % 2 == 0 { -1. } else { 1. };
            check.observe(
                &feedback(direction * 0.005, direction * 0.2),
                Duration::from_millis(i * 20),
            );
        }
        assert!(!check.is_stationary());
        assert!(check.motion_detected());
    }

    #[test]
    fn position_drift_is_rejected_even_when_speed_reports_zero() {
        let mut check = StationaryCheck::new(2. * TAU);
        for i in 0..=5 {
            check.observe(
                &feedback(i as f64 * 0.001, 0.),
                Duration::from_millis(i * 20),
            );
        }
        assert!(!check.is_stationary());
        assert!(check.motion_detected());
    }

    #[test]
    fn coasting_can_settle_without_restarting_the_operation() {
        let mut check = StationaryCheck::new(2. * TAU);
        for i in 0..=15 {
            let moving = i < 10;
            check.observe(
                &feedback(i.min(10) as f64 * 0.004, if moving { 0.2 } else { 0. }),
                Duration::from_millis(i * 20),
            );
            assert_eq!(check.is_stationary(), i == 15);
        }
    }

    #[test]
    fn encoder_wrap_does_not_look_like_motion() {
        let range = 2. * TAU;
        let tick = 2. * range / 65535.;
        let mut check = StationaryCheck::new(range);
        for i in 0..=5 {
            let position = if i % 2 == 0 {
                range - tick
            } else {
                -range + tick
            };
            check.observe(&feedback(position, 0.), Duration::from_millis(i * 20));
        }
        assert!(check.is_stationary());
    }

    #[test]
    fn buffered_packets_and_sparse_replies_cannot_confirm_standstill() {
        for interval in [Duration::from_micros(2), Duration::from_millis(101)] {
            let mut check = StationaryCheck::new(2. * TAU);
            for i in 0..=10 {
                check.observe(&feedback(0., 0.), interval * i);
                assert!(!check.is_stationary());
            }
        }
    }

    #[test]
    fn leaving_reset_or_losing_feedback_requires_a_new_window() {
        for interruption in 0..4 {
            let mut check = StationaryCheck::new(2. * TAU);
            for i in 0..=5 {
                check.observe(&feedback(0., 0.), Duration::from_millis(i * 20));
            }
            assert!(check.is_stationary());
            let mut invalid = feedback(0., 0.);
            match interruption {
                0 => invalid.mode = 2,
                1 => invalid.position = f64::NAN,
                2 => invalid.velocity = f64::INFINITY,
                _ => {}
            }
            check.observe(
                &invalid,
                Duration::from_millis(if interruption == 3 { 250 } else { 120 }),
            );
            assert!(!check.is_stationary());
            for i in 0..=5 {
                check.observe(&feedback(0., 0.), Duration::from_millis(270 + i * 20));
            }
            assert!(check.is_stationary());
        }
    }
}
