use crate::{bridge, firmware, hardware, manual, pipeline, theme, types::*};
use anyhow::Result;
use eframe::egui::{self, Color32, RichText};
use egui_material_icons::icons::*;
use egui_plot::{AxisHints, Legend, Line, Plot, PlotPoints};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

enum Event {
    FirmwarePrepared(firmware::Prepared),
    FirmwareProgress(f32, String),
    FirmwareInstalled(String),
    Status(String),
    Progress(WorkProgress),
    MotorEnabled(bool),
    Found(Vec<hardware::DiscoveredMotor>),
    Finished(PathBuf, Box<Report>),
    IdChanged(u8),
    Done(String),
    Error(String),
}

#[derive(Clone, Copy, PartialEq)]
enum SidebarTab {
    Calibrate,
    Test,
    Motor,
    Files,
}
#[derive(Clone, Copy, PartialEq)]
enum ChartView {
    Motion,
    Residuals,
    Torque,
}

pub struct CalibrationApp {
    config: Config,
    system_theme: Option<theme::SystemThemeWatcher>,
    sidebar_tab: SidebarTab,
    chart_view: ChartView,
    firmware_prepared: Option<firmware::Prepared>,
    open_firmware: bool,
    manual: Option<manual::Session>,
    manual_status: manual::Status,
    motor_enabled: bool,
    manual_history: std::collections::VecDeque<(Instant, crate::protocol::Feedback)>,
    jog_reviewed: bool,
    jog_speed: f64,
    firmware_updating: bool,
    firmware_progress: f32,
    work_progress: Option<WorkProgress>,
    interfaces: Vec<hardware::CanInterface>,
    interfaces_checked: Instant,
    reviewed: bool,
    new_id: u8,
    found: Vec<hardware::DiscoveredMotor>,
    status: String,
    error: Option<String>,
    report: Option<Report>,
    directory: Option<PathBuf>,
    import_path: String,
    validation: bool,
    cancel: Arc<AtomicBool>,
    rx: Option<Receiver<Event>>,
    job: Option<JoinHandle<()>>,
    show_real: bool,
    show_pre: bool,
    show_post: bool,
    screenshot_path: Option<PathBuf>,
    screenshot_requested: bool,
    screenshot_theme: Option<egui::Theme>,
    screenshot_during_fit: bool,
    frame_count: usize,
}
impl Default for CalibrationApp {
    fn default() -> Self {
        Self {
            config: Config::default(),
            system_theme: None,
            sidebar_tab: SidebarTab::Calibrate,
            chart_view: ChartView::Motion,
            firmware_prepared: None,
            open_firmware: false,
            manual: None,
            manual_status: manual::Status::default(),
            motor_enabled: false,
            manual_history: Default::default(),
            jog_reviewed: false,
            jog_speed: 0.5,
            firmware_updating: false,
            firmware_progress: 0.,
            work_progress: None,
            interfaces: vec![],
            interfaces_checked: Instant::now(),
            reviewed: false,
            new_id: 2,
            found: vec![],
            status: "Ready".into(),
            error: None,
            report: None,
            directory: None,
            import_path: String::new(),
            validation: true,
            cancel: Arc::new(AtomicBool::new(false)),
            rx: None,
            job: None,
            show_real: true,
            show_pre: true,
            show_post: true,
            screenshot_path: None,
            screenshot_requested: false,
            screenshot_theme: None,
            screenshot_during_fit: false,
            frame_count: 0,
        }
    }
}
impl CalibrationApp {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        theme::install(&cc.egui_ctx);
        let mut app = Self::default();
        if let Some(storage) = cc.storage
            && let Some(c) = eframe::get_value::<Config>(storage, "config")
        {
            app.config = c;
            if app.config.profile.migrate_saved_preset() {
                app.status = "Updated saved built-in profile to official 2026-07-13 manual. Review displayed wire ranges and experiment limits.".into();
            }
        }
        if app.config.experiment == crate::experiment::Experiment::Legacy {
            app.config.experiment = crate::experiment::Experiment::Mixed;
            app.config.train_seconds = app.config.train_seconds.max(40.);
            app.config.validation_seconds = app.config.validation_seconds.max(20.);
        }
        if app.config.excitation_revision == 0 {
            app.config.apply_spec_limits();
            app.config.excitation_revision = 1;
        }
        app.config.experiment = crate::experiment::Experiment::Mixed;
        // New captures use constant friction; old reports retain their original model.
        app.config.baseline.static_friction = 0.;
        // Optional artifact opening is read-only and never starts hardware.
        if let Some(path) =
            std::env::args().find_map(|a| a.strip_prefix("--open=").map(str::to_owned))
        {
            app.import_path = path;
            app.load_report();
        }
        app.system_theme = Some(theme::SystemThemeWatcher::new(&cc.egui_ctx));
        app.refresh_interfaces();
        if let Some(interface) =
            std::env::args().find_map(|a| a.strip_prefix("--connect=").map(str::to_owned))
        {
            if app
                .interfaces
                .iter()
                .any(|bus| bus.name == interface && bus.ready())
            {
                app.config.interface = interface;
                app.scan();
            } else {
                app.error = Some(format!("CAN interface {interface} is unavailable or down."));
            }
        }
        app.screenshot_path =
            std::env::args().find_map(|a| a.strip_prefix("--screenshot=").map(PathBuf::from));
        if app.screenshot_path.is_some() {
            if let Some(tab) = std::env::args().find_map(|a| match a.as_str() {
                "--screenshot-tab=calibrate" => Some(SidebarTab::Calibrate),
                "--screenshot-tab=test" => Some(SidebarTab::Test),
                "--screenshot-tab=motor" => Some(SidebarTab::Motor),
                "--screenshot-tab=files" => Some(SidebarTab::Files),
                _ => None,
            }) {
                app.sidebar_tab = tab;
            }
            app.screenshot_theme = std::env::args().find_map(|a| match a.as_str() {
                "--screenshot-theme=light" => Some(egui::Theme::Light),
                "--screenshot-theme=dark" => Some(egui::Theme::Dark),
                _ => None,
            });
        }
        app.screenshot_during_fit = std::env::args().any(|a| a == "--screenshot-during-fit");
        if let Some(path) =
            std::env::args().find_map(|a| a.strip_prefix("--refit=").map(str::to_owned))
        {
            app.import_path = path;
            app.load_report();
            if app.error.is_none() {
                app.refit();
            }
        }
        app
    }
    fn busy(&self) -> bool {
        self.rx.is_some()
    }
    fn spawn(
        &mut self,
        f: impl FnOnce(Sender<Event>, Arc<AtomicBool>) -> Result<()> + Send + 'static,
    ) {
        if self.busy() {
            return;
        }
        self.stop_monitor();
        if let Some(job) = self.job.take() {
            let _ = job.join();
        }
        self.error = None;
        self.work_progress = None;
        self.cancel = Arc::new(AtomicBool::new(false));
        let cancel = self.cancel.clone();
        let (tx, rx) = mpsc::channel();
        self.rx = Some(rx);
        self.job = Some(thread::spawn(move || {
            if let Err(e) = f(tx.clone(), cancel) {
                let _ = tx.send(Event::Error(format!("{e:#}")));
            }
        }));
    }
    fn poll(&mut self) {
        let mut events = Vec::new();
        let mut disconnected = false;
        if let Some(rx) = &self.rx {
            loop {
                match rx.try_recv() {
                    Ok(event) => events.push(event),
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }
        }
        for event in events {
            match event {
                Event::FirmwarePrepared(prepared) => {
                    self.status = format!(
                        "Firmware verified · {} -> {} · ready to update ID {}",
                        prepared.current_version, prepared.release.version, prepared.motor_id
                    );
                    self.firmware_prepared = Some(prepared);
                }
                Event::FirmwareProgress(fraction, message) => {
                    self.firmware_progress = fraction;
                    self.status = message;
                }
                Event::FirmwareInstalled(version) => {
                    if let Some(motor) =
                        self.found.iter_mut().find(|m| m.id == self.config.motor_id)
                    {
                        motor.model = crate::protocol::firmware_model(&version);
                        motor.firmware = Some(version.clone());
                    }
                    self.reviewed = false;
                    self.status = format!("Firmware {version} verified. Motor stopped.");
                }
                Event::Status(s) => self.status = s,
                Event::MotorEnabled(enabled) => self.motor_enabled = enabled,
                Event::Progress(p) => {
                    self.status = p.label.clone();
                    self.work_progress = Some(p);
                }
                Event::Found(motors) => {
                    self.status = format!(
                        "Found {} motors. Select a motor to review its preset.",
                        motors.len()
                    );
                    let selected = motors
                        .iter()
                        .find(|m| m.id == self.config.motor_id)
                        .or_else(|| motors.iter().find(|m| m.model.is_some()))
                        .or_else(|| motors.first())
                        .map(|m| m.id);
                    self.found = motors;
                    if let Some(id) = selected {
                        self.select_motor(id);
                    }
                }
                Event::Finished(path, report) => {
                    self.status = if report.accepted {
                        "Calibration complete · held-out validation passed"
                    } else {
                        "Candidate fit complete · validation needs attention"
                    }
                    .into();
                    self.import_path = path.display().to_string();
                    self.directory = Some(path);
                    self.report = Some(*report);
                }
                Event::IdChanged(id) => {
                    let old = self.config.motor_id;
                    self.config.motor_id = id;
                    if let Some(motor) = self.found.iter_mut().find(|m| m.id == old) {
                        motor.id = id;
                    }
                    self.found.sort_by_key(|m| m.id);
                    self.firmware_prepared = None;
                    self.status = format!("Motor ID changed {old} to {id}; UUID verified");
                    self.report = None;
                    self.reviewed = false;
                }
                Event::Done(s) => self.status = s,
                Event::Error(s) => {
                    self.motor_enabled = false;
                    self.status = "Operation stopped".into();
                    self.error = Some(s);
                }
            }
        }
        if disconnected {
            self.motor_enabled = false;
            self.rx = None;
            self.firmware_updating = false;
            if let Some(job) = self.job.take()
                && job.join().is_err()
            {
                self.error =
                    Some("Background task panicked; hardware stop guard was invoked".into());
            }
        }
    }
    fn load_report(&mut self) {
        let dir = PathBuf::from(&self.import_path);
        match bridge::read_json::<Report>(&dir.join("report.json")) {
            Ok(report) if report.source != "hardware" => {
                self.error = Some("Open a real motor recording. Synthetic sessions are no longer supported in the app.".into());
            }
            Ok(report) => {
                self.report = Some(report);
                self.sidebar_tab = SidebarTab::Files;
                self.directory = Some(dir);
                self.error = None;
                self.status = "Loaded recorded comparison".into();
            }
            Err(e) => self.error = Some(format!("{e:#}")),
        }
    }
    fn run(&mut self) {
        if !self.motor_ready() || !self.reviewed {
            self.error = Some(
                "Scan the selected CAN bus and review the detected motor limits first.".into(),
            );
            return;
        }
        if let Err(e) = self.config.validate() {
            self.error = Some(e.to_string());
            return;
        }
        let config = self.config.clone();
        self.report = None;
        self.status = "Preparing calibration…".into();
        self.spawn(move |tx, cancel| {
            let dir = bridge::new_run_dir()?;
            bridge::write_json(&dir.join("config.json"), &config)?;
            let _ = tx.send(Event::Status(format!("Recording to {}", dir.display())));
            let recording = hardware::acquire(&config, &dir, &cancel,
                |p| { let _ = tx.send(Event::Progress(p)); },
                |enabled| { let _ = tx.send(Event::MotorEnabled(enabled)); });
            let _ = tx.send(Event::MotorEnabled(false));
            if let Err(e) = recording {
                let _ = bridge::write_json(&dir.join("error.json"), &serde_json::json!({"error": format!("{e:#}")}));
                return Err(e);
            }
            let _ = tx.send(Event::Status("Motor stopped · fitting training data and replaying held-out validation in MuJoCo…".into()));
            let report = pipeline::analyze(&dir, &cancel, |p| { let _ = tx.send(Event::Progress(p)); })?;
            let _ = tx.send(Event::Finished(dir, Box::new(report)));
            Ok(())
        });
    }
    fn bus_ready(&self) -> bool {
        self.interfaces
            .iter()
            .any(|b| b.name == self.config.interface && b.ready())
    }
    fn selected_motor(&self) -> Option<&hardware::DiscoveredMotor> {
        self.found.iter().find(|m| m.id == self.config.motor_id)
    }
    fn motor_ready(&self) -> bool {
        self.bus_ready()
            && self
                .selected_motor()
                .is_some_and(|m| m.model.as_deref() == Some(self.config.profile.model.as_str()))
    }
    fn can_disable_motor(&self) -> bool {
        self.motor_ready() && self.motor_enabled && !self.firmware_updating
    }
    fn connection_label(&self) -> &'static str {
        if self.motor_ready() {
            if self.motor_enabled {
                "Connected · Enabled"
            } else {
                "Connected · Disabled"
            }
        } else if self.busy() {
            "Working"
        } else {
            "Not connected"
        }
    }
    fn invalidate_connection(&mut self) {
        self.stop_monitor();
        self.found.clear();
        self.reviewed = false;
        self.firmware_prepared = None;
    }
    fn refresh_interfaces(&mut self) {
        self.interfaces_checked = Instant::now();
        match hardware::available_interfaces() {
            Ok(interfaces) => {
                self.interfaces = interfaces;
                if !self
                    .interfaces
                    .iter()
                    .any(|b| b.name == self.config.interface)
                {
                    self.invalidate_connection();
                    self.config.interface = self
                        .interfaces
                        .iter()
                        .find(|b| b.ready())
                        .or_else(|| self.interfaces.first())
                        .map(|b| b.name.clone())
                        .unwrap_or_default();
                }
                if !self.bus_ready() {
                    self.invalidate_connection();
                }
            }
            Err(e) => {
                self.interfaces.clear();
                self.invalidate_connection();
                self.error = Some(e.to_string());
            }
        }
    }
    fn select_motor(&mut self, id: u8) {
        self.stop_monitor();
        self.manual_status = manual::Status::default();
        self.manual_history.clear();
        self.jog_reviewed = false;
        self.config.motor_id = id;
        if let Some(model) = self.selected_motor().and_then(|m| m.model.as_ref())
            && let Some(profile) = Profile::presets().into_iter().find(|p| &p.model == model)
        {
            self.config.profile = profile;
            self.config.apply_spec_limits();
            self.config.train_seconds = 40.;
            self.config.validation_seconds = 20.;
            self.config.experiment = crate::experiment::Experiment::Mixed;
        }
        self.new_id = (1..=254)
            .find(|id| *id != self.config.host_id && !self.found.iter().any(|m| m.id == *id))
            .unwrap_or(1);
        self.reviewed = false;
        self.firmware_prepared = None;
    }
    fn scan(&mut self) {
        if !self.bus_ready() {
            return;
        }
        let c = self.config.clone();
        self.invalidate_connection();
        self.status = "Scanning motor IDs and firmware…".into();
        self.spawn(move |tx, cancel| {
            let motors = hardware::scan(&c, &cancel, |p| {
                let _ = tx.send(Event::Progress(p));
            })?;
            let _ = tx.send(Event::Found(motors));
            Ok(())
        });
    }
    fn motor_action(&mut self, zero: bool) {
        if !self.motor_ready() {
            return;
        }
        let c = self.config.clone();
        let id = self.new_id;
        self.report = None;
        self.spawn(move |tx, _| {
            if zero {
                hardware::set_zero(&c)?;
                let _ = tx.send(Event::Done("Motor zero set. Position verified.".into()));
            } else {
                hardware::change_id(&c, id)?;
                let _ = tx.send(Event::IdChanged(id));
            }
            Ok(())
        });
    }
    fn connection_controls(&mut self, ui: &mut egui::Ui) {
        ui.label(
            RichText::new("Connection")
                .family(theme::semibold())
                .color(theme::colors(ui).ink),
        );
        ui.horizontal(|ui| {
            let before = self.config.interface.clone();
            egui::ComboBox::from_id_salt("can_interface")
                .width(200.)
                .selected_text(if before.is_empty() {
                    "Select CAN bus"
                } else {
                    &before
                })
                .show_ui(ui, |ui| {
                    for bus in &self.interfaces {
                        let label = format!(
                            "{} · {}",
                            bus.name,
                            if bus.ready() {
                                "Ready"
                            } else if !bus.up {
                                "Down"
                            } else {
                                &bus.state
                            }
                        );
                        ui.selectable_value(&mut self.config.interface, bus.name.clone(), label);
                    }
                });
            if self.config.interface != before {
                self.invalidate_connection();
            }
            if theme::icon_button(ui, ICON_REFRESH, "Refresh available CAN buses").clicked() {
                self.refresh_interfaces();
            }
        });
        if self.interfaces.is_empty() {
            ui.small("Connect a USB-CAN adapter to begin.");
        } else if !self.bus_ready() {
            ui.colored_label(
                theme::colors(ui).warning,
                "Bring the CAN bus up before scanning.",
            )
            .on_hover_text("Bring the selected CAN interface up before scanning.");
        }
        ui.horizontal(|ui| {
            let mut id = self.config.motor_id;
            let label = self
                .selected_motor()
                .map(|m| format!("{} · ID {}", m.model.as_deref().unwrap_or("Unknown"), m.id))
                .unwrap_or("Select motor".into());
            egui::ComboBox::from_id_salt("discovered_motor")
                .width(170.)
                .selected_text(label)
                .show_ui(ui, |ui| {
                    for motor in &self.found {
                        ui.selectable_value(
                            &mut id,
                            motor.id,
                            format!(
                                "{} · ID {}",
                                motor.model.as_deref().unwrap_or("Unknown"),
                                motor.id
                            ),
                        );
                    }
                });
            if id != self.config.motor_id {
                self.select_motor(id);
            }
            if ui
                .add_enabled(
                    self.bus_ready(),
                    egui::Button::new(theme::action(ICON_SEARCH, "Scan")),
                )
                .on_hover_text("Scan motor IDs and detect model from firmware")
                .clicked()
            {
                self.scan();
            }
        });
        if let Some(motor) = self.selected_motor() {
            if let Some(issue) = &motor.issue {
                ui.colored_label(theme::colors(ui).warning, issue);
            }
            if let Some(version) = &motor.firmware {
                ui.small(format!("Firmware {version} · Model detected"));
            }
        }
        let update = self.selected_motor().and_then(|motor| {
            firmware::available_update(motor.model.as_deref()?, motor.firmware.as_deref()?)
        });
        if let Some(update) = update
            && ui
                .add(egui::Button::new(theme::action_colored(
                    ICON_SYSTEM_UPDATE_ALT,
                    "Firmware update available",
                    theme::colors(ui).link,
                )))
                .on_hover_text(format!(
                    "{} · firmware {}. Open Setup to review and install.",
                    update.model, update.version
                ))
                .clicked()
        {
            self.sidebar_tab = SidebarTab::Motor;
            self.open_firmware = true;
        }
    }
    fn controls(&mut self, ui: &mut egui::Ui) {
        let before = self.config.clone();
        let busy = self.busy();
        ui.add_enabled_ui(!busy, |ui| {
            ui.add_enabled_ui(self.manual.is_none(), |ui| self.connection_controls(ui));
            ui.add_space(10.);
            let previous_tab = self.sidebar_tab;
            theme::segmented(ui, |ui| {
                ui.spacing_mut().button_padding.x = 2.;
                ui.spacing_mut().item_spacing.x = 4.;
                let width = (ui.available_width() - 3. * ui.spacing().item_spacing.x) / 4.;
                for (tab, label) in [
                    (SidebarTab::Calibrate, "Calibrate"),
                    (SidebarTab::Test, "Test"),
                    (SidebarTab::Motor, "Setup"),
                    (SidebarTab::Files, "Files"),
                ] {
                    if ui
                        .add_sized(
                            [width, 36.],
                            egui::Button::selectable(
                                self.sidebar_tab == tab,
                                RichText::new(label).size(13.),
                            )
                            .truncate(),
                        )
                        .clicked()
                    {
                        self.sidebar_tab = tab;
                    }
                }
            });
            if previous_tab == SidebarTab::Test && self.sidebar_tab != SidebarTab::Test {
                self.stop_monitor();
            }
            ui.separator();
            match self.sidebar_tab {
                SidebarTab::Test => self.manual_controls(ui),
                SidebarTab::Calibrate => {
                    if self.motor_ready() {
                        self.calibration_controls(ui);
                    } else {
                        ui.add_space(16.);
                        ui.label("Scan to load the preset for your motor.");
                    }
                }
                SidebarTab::Motor => {
                    if self.motor_ready() {
                        self.motor_controls(ui);
                    } else {
                        ui.label("Scan to identify your motor first.");
                        ui.collapsing("CAN protocol", |ui| {
                            ui.horizontal(|ui| {
                                ui.label("Host ID");
                                ui.add(
                                    egui::DragValue::new(&mut self.config.host_id).range(1..=254),
                                );
                            });
                        });
                    }
                }
                SidebarTab::Files => self.file_controls(ui),
            }
        });
        if self.config.host_id != before.host_id {
            self.invalidate_connection();
        }
        if self.config != before {
            self.reviewed = false;
        }
    }
    fn progress_card(&mut self, ui: &mut egui::Ui) {
        let palette = theme::colors(ui);
        theme::card(ui).show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            let heading = if self.firmware_updating {
                "Updating firmware"
            } else {
                match self.work_progress.as_ref().map(|p| p.phase) {
                    Some(WorkPhase::Scanning) => "Finding motors",
                    Some(WorkPhase::Recording) => "Recording motion",
                    Some(WorkPhase::Fitting) => "Fitting & validation",
                    None => "Working",
                }
            };
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new(heading)
                        .size(18.)
                        .family(theme::semibold())
                        .color(palette.ink),
                );
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui
                        .add_enabled(
                            !self.firmware_updating,
                            egui::Button::new(theme::action_colored(
                                ICON_STOP,
                                "Stop",
                                palette.error,
                            )),
                        )
                        .clicked()
                    {
                        self.cancel.store(true, Ordering::Relaxed);
                        self.status = "Stopping…".into();
                    }
                    if let Some(progress) = &self.work_progress {
                        ui.label(
                            RichText::new(format!("{:.0}%", progress.fraction * 100.))
                                .family(theme::numbers())
                                .color(palette.ink),
                        );
                    }
                });
            });
            let fraction = if self.firmware_updating {
                self.firmware_progress
            } else {
                self.work_progress.as_ref().map_or(0., |p| p.fraction)
            };
            ui.add(
                egui::ProgressBar::new(fraction)
                    .desired_width(ui.available_width())
                    .desired_height(8.)
                    .fill(palette.after),
            );
            ui.small(&self.status);
        });
        ui.add_space(16.);
    }
    fn calibration_controls(&mut self, ui: &mut egui::Ui) {
        ui.label(
            RichText::new(format!("{} preset", self.config.profile.model)).family(theme::bold()),
        );
        ui.small("Steps · sweep · multisine · torque bursts");
        ui.add_space(10.);
        for (label, value) in [
            (
                "Torque limit",
                format!("{:.2} Nm", self.config.torque_limit),
            ),
            (
                "Speed cutoff",
                format!("{:.2} rad/s", self.config.speed_limit),
            ),
            (
                "Target speed",
                format!(
                    "±{:.2} rad/s",
                    self.config.speed_limit * self.config.target_speed_fraction()
                ),
            ),
            (
                "Sweep",
                format!(
                    "{:.2}–{:.2} Hz",
                    self.config.sweep_start_hz, self.config.sweep_end_hz
                ),
            ),
            ("Travel", format!("±{:.1} rad", self.config.travel_limit)),
        ] {
            ui.horizontal(|ui| {
                ui.label(label);
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(
                        RichText::new(value)
                            .family(theme::numbers())
                            .color(theme::colors(ui).ink),
                    );
                });
            });
        }
        ui.add_space(8.);
        ui.collapsing("Advanced", |ui| {
            if ui.button("Restore motor preset").clicked() {
                self.config.apply_spec_limits();
                self.reviewed = false;
            }
            if let Some(spec) = self.config.profile.spec() {
                let cap = spec
                    .bench_torque_max()
                    .min(self.config.profile.torque_range * 0.1);
                let speed =
                    (spec.speed_rad_s() * 0.5).min(self.config.profile.velocity_range * 0.5);
                if ui
                    .add(
                        egui::Slider::new(&mut self.config.torque_limit, 0.01..=cap)
                            .text("Nm")
                            .max_decimals(2),
                    )
                    .on_hover_text("Maximum commanded torque")
                    .changed()
                {
                    self.reviewed = false;
                }
                if ui
                    .add(
                        egui::Slider::new(&mut self.config.speed_limit, 0.1..=speed)
                            .text("rad/s")
                            .max_decimals(1),
                    )
                    .on_hover_text("Speed cutoff; the requested motion stays below this limit")
                    .changed()
                {
                    self.reviewed = false;
                }
            }
            ui.horizontal(|ui| {
                ui.label("Train");
                ui.add(
                    egui::DragValue::new(&mut self.config.train_seconds)
                        .range(20.0..=60.0)
                        .suffix(" s"),
                );
                ui.label("Validate");
                ui.add(
                    egui::DragValue::new(&mut self.config.validation_seconds)
                        .range(10.0..=60.0)
                        .suffix(" s"),
                );
            });

            number(ui, "Travel ± rad", &mut self.config.travel_limit, 0.5);
            number(ui, "Temperature °C", &mut self.config.temperature_limit, 1.);
            number(ui, "Sample rate Hz", &mut self.config.sample_hz, 10.);
            number(ui, "Sweep from Hz", &mut self.config.sweep_start_hz, 0.05);
            number(ui, "Sweep to Hz", &mut self.config.sweep_end_hz, 0.1);
            ui.collapsing("Baseline model", |ui| {
                number(
                    ui,
                    "Armature kg m²",
                    &mut self.config.baseline.armature,
                    0.001,
                );
                number(
                    ui,
                    "Damping Nm s/rad",
                    &mut self.config.baseline.damping,
                    0.001,
                );
                number(ui, "Friction Nm", &mut self.config.baseline.friction, 0.001);
                number(ui, "Delay s", &mut self.config.baseline.delay, 0.001);
            });
        });
        ui.add_space(14.);
        theme::checkbox(ui, &mut self.reviewed, "Motor secured · limits reviewed")
            .on_hover_text("Motor secured; torque, speed and travel limits reviewed");
        if theme::primary(
            ui,
            ICON_PLAY_ARROW,
            "Start calibration",
            self.motor_ready() && self.reviewed,
        )
        .clicked()
        {
            self.run();
        }
        ui.small(format!(
            "{:.0} s recording + fitting",
            self.config.train_seconds + self.config.validation_seconds
        ));
    }
    fn motor_controls(&mut self, ui: &mut egui::Ui) {
        let open = std::mem::take(&mut self.open_firmware).then_some(true);
        egui::CollapsingHeader::new("Firmware update")
            .open(open)
            .show(ui, |ui| {
                ui.small("Official V26.05.19 · verified download");
                ui.hyperlink_to("RobStride release notes", firmware::RELEASE_URL);
                if let Ok(release) = firmware::release(&self.config.profile.model) {
                    ui.label(format!("{} → firmware {}", release.model, release.version));
                }
                if ui
                    .add_enabled(
                        self.motor_ready(),
                        egui::Button::new(theme::action(ICON_DOWNLOAD, "Download and verify")),
                    )
                    .clicked()
                {
                    let c = self.config.clone();
                    self.firmware_prepared = None;
                    self.spawn(move |tx, _| {
                        let prepared = firmware::prepare(&c, |s| {
                            let _ = tx.send(Event::Status(s));
                        })?;
                        let _ = tx.send(Event::FirmwarePrepared(prepared));
                        Ok(())
                    });
                }
                if let Some(prepared) = self
                    .firmware_prepared
                    .clone()
                    .filter(|p| p.matches(&self.config))
                {
                    ui.label(format!(
                        "Installed {} → {}",
                        prepared.current_version, prepared.release.version
                    ));

                    ui.label("Keep power and USB connected until finished.");
                    let label = format!(
                        "Update {} · ID {}",
                        prepared.release.model, prepared.motor_id
                    );
                    if ui
                        .add_enabled(
                            self.motor_ready(),
                            egui::Button::new(theme::action(ICON_SYSTEM_UPDATE_ALT, &label)),
                        )
                        .clicked()
                    {
                        let c = self.config.clone();
                        self.firmware_updating = true;
                        self.firmware_progress = 0.;
                        self.firmware_prepared = None;
                        self.reviewed = false;
                        self.spawn(move |tx, _| {
                            let installed = firmware::update(&c, &prepared, |fraction, s| {
                                let _ = tx.send(Event::FirmwareProgress(fraction, s));
                            })?;
                            let _ = tx.send(Event::FirmwareInstalled(installed));
                            Ok(())
                        });
                    }
                }
            });

        ui.separator();
        ui.horizontal(|ui| {
            ui.label("New ID");
            ui.add(egui::DragValue::new(&mut self.new_id).range(1..=254));
            if ui.button("Apply").clicked() {
                self.motor_action(false);
            }
        });
        ui.collapsing("Motor specifications", |ui| {
            if let Some(spec) = self.config.profile.spec() {
                ui.label(format!(
                    "{} Nm rated · {} Nm peak",
                    spec.rated_torque, spec.peak_torque
                ));
                ui.label(format!(
                    "{} rpm · {}:1 · {} V",
                    spec.no_load_rpm, spec.gear_ratio, spec.rated_voltage
                ));
                ui.small("July 2026 manual. Test limits are lower than motor ratings.");
            }
        });
        ui.collapsing("CAN protocol", |ui| {
            ui.horizontal(|ui| {
                ui.label("Host ID");
                ui.add(egui::DragValue::new(&mut self.config.host_id).range(1..=254));
            });
            ui.small(format!(
                "Position ±{:.3} rad",
                self.config.profile.position_range
            ));
            ui.small(format!(
                "Speed ±{:.2} rad/s",
                self.config.profile.velocity_range
            ));
            ui.small(format!(
                "Torque ±{:.2} Nm",
                self.config.profile.torque_range
            ));
        });
    }
    fn disable_motor(&mut self) {
        if !self.can_disable_motor() {
            return;
        }
        if let Some(session) = &self.manual {
            let mut intent = session.intent.lock().unwrap();
            intent.enabled = false;
            intent.direction = 0;
            self.status = "Disabling motor…".into();
        } else if self.busy() {
            self.cancel.store(true, Ordering::Relaxed);
            self.status = "Stopping…".into();
        } else if self.selected_motor().is_some() {
            let c = self.config.clone();
            self.spawn(move |tx, _| {
                hardware::disable(&c)?;
                let _ = tx.send(Event::Done("Motor stopped".into()));
                Ok(())
            });
        }
    }
    fn stop_monitor(&mut self) {
        self.manual = None; // Joins the worker after its stop guard runs.
        self.manual_status.enabled = false;
        self.manual_status.preparing = false;
        self.motor_enabled = false;
    }
    fn poll_monitor(&mut self, ctx: &egui::Context) {
        let Some(session) = &self.manual else {
            return;
        };
        let snapshot = session.snapshot();
        if let (Some(received), Some(fb)) = (snapshot.received, &snapshot.feedback)
            && self
                .manual_history
                .back()
                .is_none_or(|(at, _)| *at != received)
        {
            self.manual_history.push_back((received, fb.clone()));
            while self
                .manual_history
                .front()
                .is_some_and(|(at, _)| received.duration_since(*at) > Duration::from_secs(30))
            {
                self.manual_history.pop_front();
            }
        }
        if snapshot.stop_reason != self.manual_status.stop_reason
            && let Some(reason) = &snapshot.stop_reason
        {
            self.status = reason.clone();
        }
        self.manual_status = snapshot;
        self.motor_enabled = self.manual_status.enabled;
        if session.finished() {
            self.error = self.manual_status.error.clone();
            self.stop_monitor();
            return;
        }
        let focused = ctx.input(|i| i.focused && !i.viewport().close_requested());
        if !focused || self.sidebar_tab != SidebarTab::Test {
            let mut intent = session.intent.lock().unwrap();
            intent.enabled = false;
            intent.direction = 0;
        }
        ctx.request_repaint_after(Duration::from_millis(16));
    }
    fn manual_controls(&mut self, ui: &mut egui::Ui) {
        if !self.motor_ready() {
            ui.label("Scan to select a motor for testing.");
            return;
        }
        let monitoring = self.manual.is_some();
        if !monitoring {
            if ui
                .button(theme::action(ICON_PLAY_ARROW, "Start monitoring"))
                .clicked()
            {
                let uuid = self.selected_motor().unwrap().uuid;
                self.manual_status = manual::Status::default();
                self.manual_history.clear();
                self.error = None;
                self.jog_reviewed = false;
                self.manual = Some(manual::Session::start(self.config.clone(), uuid));
            }
            ui.small("Monitoring starts with the motor disabled.");
        } else if ui
            .button(theme::action(ICON_STOP, "Stop monitoring"))
            .clicked()
        {
            self.stop_monitor();
        }
        if ui
            .add_enabled(
                !self.manual_status.enabled && !self.manual_status.preparing,
                egui::Button::new(theme::action(
                    ICON_MY_LOCATION,
                    "Set current position as zero",
                )),
            )
            .on_hover_text("Disable the motor first. Monitoring will stop before setting zero.")
            .clicked()
        {
            self.motor_action(true);
        }
        ui.add_space(12.);
        ui.label(RichText::new("Jog motor").family(theme::semibold()));
        self.jog_speed = self.jog_speed.clamp(0.01, manual::max_speed(&self.config));
        ui.add_enabled_ui(
            !self.manual_status.enabled && !self.manual_status.preparing,
            |ui| {
                ui.add(
                    egui::Slider::new(&mut self.jog_speed, 0.01..=manual::max_speed(&self.config))
                        .text("rad/s")
                        .fixed_decimals(2),
                );
                theme::checkbox(ui, &mut self.jog_reviewed, "Motor secured · shaft clear");
            },
        );
        let fresh = self
            .manual_status
            .received
            .is_some_and(|at| at.elapsed() < Duration::from_millis(200));
        let healthy = self
            .manual_status
            .feedback
            .as_ref()
            .is_some_and(|fb| fb.faults == 0 && fb.temperature < self.config.temperature_limit);
        let enable = ui
            .add_enabled(
                self.manual.is_some()
                    && fresh
                    && healthy
                    && self.jog_reviewed
                    && !self.manual_status.enabled
                    && !self.manual_status.preparing,
                egui::Button::new(theme::action(ICON_POWER_SETTINGS_NEW, "Enable motor")),
            )
            .clicked();
        let mut direction = 0;
        ui.add_enabled_ui(
            self.manual_status.enabled && !self.manual_status.preparing,
            |ui| {
                ui.horizontal(|ui| {
                    if theme::hold_button(ui, ICON_ARROW_BACK, "Jog −") {
                        direction -= 1;
                    }
                    if theme::hold_button(ui, ICON_ARROW_FORWARD, "Jog +") {
                        direction += 1;
                    }
                });
            },
        );
        ui.small(if self.manual_status.preparing {
            "Checking firmware watchdog…"
        } else {
            "Hold to jog. Release to stop."
        });
        ui.add_space(8.);
        ui.small(format!(
            "Torque limit {:.2} Nm · Travel ±{:.2} rad",
            manual::torque_limit(&self.config),
            manual::travel_limit(&self.config)
        ));
        if let Some(session) = &self.manual {
            let mut intent = session.intent.lock().unwrap();
            intent.heartbeat = Instant::now();
            intent.speed = self.jog_speed;
            intent.direction = direction;
            if enable {
                intent.enabled = true;
            }
            if !self.jog_reviewed || !ui.input(|i| i.focused && !i.viewport().close_requested()) {
                intent.enabled = false;
                intent.direction = 0;
            }
        }
    }
    fn manual_view(&self, ui: &mut egui::Ui) {
        let palette = theme::colors(ui);
        ui.heading("Motor test");
        if let Some(error) = &self.manual_status.error {
            ui.colored_label(palette.error, error);
        } else if let Some(reason) = &self.manual_status.stop_reason {
            ui.label(reason);
        }
        if let Some(motor) = self.selected_motor() {
            ui.label(format!(
                "{} · ID {} · {}",
                motor.model.as_deref().unwrap_or("Unknown"),
                motor.id,
                self.config.interface
            ));
        }
        let fresh = self.manual.is_some()
            && self
                .manual_status
                .received
                .is_some_and(|at| at.elapsed() < Duration::from_millis(200));
        let fb = self.manual_status.feedback.as_ref().filter(|_| fresh);
        ui.horizontal(|ui| {
            let (text, color) = if self.manual_status.preparing {
                ("Checking watchdog", palette.muted)
            } else if fb.is_some_and(|f| f.faults != 0) {
                ("Motor fault", palette.error)
            } else if self.manual_status.enabled && fresh {
                ("Enabled", palette.success)
            } else if fresh {
                ("Disabled", palette.muted)
            } else {
                ("No live feedback", palette.muted)
            };
            theme::badge(ui, text, color);
            if let Some(fb) = fb {
                ui.monospace(format!("Mode {} · Faults 0x{:02x}", fb.mode, fb.faults));
            }
        });
        ui.add_space(16.);
        let values = [
            ("Position", fb.map(|f| format!("{:.3}", f.position)), "rad"),
            ("Speed", fb.map(|f| format!("{:.3}", f.velocity)), "rad/s"),
            ("Torque", fb.map(|f| format!("{:.3}", f.torque)), "Nm"),
            (
                "Temperature",
                fb.map(|f| format!("{:.1}", f.temperature)),
                "°C",
            ),
        ];
        let columns = if ui.available_width() >= 700. { 4 } else { 2 };
        for row in values.chunks(columns) {
            ui.columns(columns, |columns| {
                for (ui, (label, value, unit)) in columns.iter_mut().zip(row) {
                    theme::card(ui).show(ui, |ui| {
                        ui.set_min_width(ui.available_width());
                        ui.small(*label);
                        ui.add_space(12.);
                        ui.label(
                            RichText::new(value.as_deref().unwrap_or("--"))
                                .family(theme::numbers())
                                .size(26.),
                        );
                        ui.small(*unit);
                    });
                }
            });
            ui.add_space(8.);
        }
        ui.add_space(16.);
        if self.manual_history.is_empty() {
            ui.label("Start monitoring to see live motor feedback.");
            return;
        }
        let origin = self.manual_history.front().unwrap().0;
        for (index, title) in ["Position · rad", "Speed · rad/s", "Torque · Nm"]
            .into_iter()
            .enumerate()
        {
            styled_plot(["live_position", "live_speed", "live_torque"][index])
                .height(150.)
                .y_axis_label(title)
                .x_axis_label("Time · s")
                .show(ui, |plot| {
                    plot.line(
                        Line::new(
                            "Measured",
                            PlotPoints::from_iter(self.manual_history.iter().map(|(at, f)| {
                                [
                                    at.duration_since(origin).as_secs_f64(),
                                    match index {
                                        0 => f.position,
                                        1 => f.velocity,
                                        _ => f.torque,
                                    },
                                ]
                            })),
                        )
                        .color(palette.measured)
                        .width(1.7_f32),
                    );
                });
        }
    }
    fn refit(&mut self) {
        let dir = PathBuf::from(&self.import_path);
        self.spawn(move |tx, cancel| {
            let report = pipeline::analyze(&dir, &cancel, |p| {
                let _ = tx.send(Event::Progress(p));
            })?;
            let _ = tx.send(Event::Finished(dir, Box::new(report)));
            Ok(())
        });
    }
    fn file_controls(&mut self, ui: &mut egui::Ui) {
        ui.label("Saved run folder");
        ui.add(
            egui::TextEdit::singleline(&mut self.import_path)
                .margin(egui::vec2(12., 8.))
                .hint_text("Path to a recorded run"),
        );
        ui.horizontal(|ui| {
            if ui.button(theme::action(ICON_FOLDER_OPEN, "Open")).clicked() {
                self.load_report();
            }
            if ui.button(theme::action(ICON_REFRESH, "Refit")).clicked() {
                self.refit();
            }
        });
        if let Some(dir) = &self.directory {
            ui.add_space(12.);
            ui.label("Current run");
            ui.small(dir.display().to_string());
            if ui
                .button(theme::action(ICON_CONTENT_COPY, "Copy folder path"))
                .clicked()
            {
                ui.ctx().copy_text(dir.display().to_string());
            }
        }
        ui.small("Recordings and results are saved automatically.");
    }
    fn motion_preview(&self, ui: &mut egui::Ui, height: f32) {
        let palette = theme::colors(ui);
        let points: Vec<_> = (0..=1200)
            .map(|i| {
                let t = i as f64 / 1200. * self.config.train_seconds;
                let (v, u) = crate::experiment::preview(&self.config, t, false);
                (t, v, u)
            })
            .collect();
        styled_plot("requested_speed_preview")
            .height(height)
            .allow_drag(false)
            .allow_zoom(false)
            .x_axis_label("Time · s")
            .y_axis_label("Target · rad/s")
            .show(ui, |plot| {
                plot.line(
                    Line::new(
                        "Requested speed",
                        PlotPoints::from_iter(points.iter().map(|&(t, v, _)| [t, v])),
                    )
                    .color(palette.after),
                );
            });
        if points.iter().any(|x| x.2 != 0.) {
            styled_plot("pulse_preview")
                .height(height * 0.65)
                .allow_drag(false)
                .allow_zoom(false)
                .x_axis_label("Time · s")
                .y_axis_label("Burst · Nm")
                .show(ui, |plot| {
                    plot.line(
                        Line::new(
                            "Torque bursts",
                            PlotPoints::from_iter(points.iter().map(|&(t, _, u)| [t, u])),
                        )
                        .color(palette.before),
                    );
                });
        }
        ui.small("Requested motion; actual response depends on the motor.");
    }
    fn comparison(&mut self, ui: &mut egui::Ui) {
        let palette = theme::colors(ui);
        let updating = self.busy()
            && self
                .work_progress
                .as_ref()
                .is_some_and(|p| p.phase == WorkPhase::Fitting);
        let Some(report) = &self.report else {
            if !self.motor_ready() {
                ui.add_space(48.);
                ui.heading(RichText::new("Connect your motor").color(theme::colors(ui).ink));
                ui.label("Select a CAN bus, then scan to identify the model and firmware.");
                return;
            }
            ui.add_space(16.);
            ui.heading(RichText::new("Preview your next test").color(theme::colors(ui).ink));
            ui.label(format!(
                "{} · {}",
                self.config.profile.model,
                self.config.experiment.label()
            ));
            ui.add_space(18.);
            self.motion_preview(ui, 240.);
            ui.add_space(16.);
            ui.horizontal_wrapped(|ui| {
                for segment in crate::experiment::plan(&self.config, false) {
                    theme::card(ui).show(ui, |ui| {
                        ui.label(RichText::new(segment.name).family(theme::bold()));
                        ui.small(format!("{:.0}–{:.0} s", segment.start, segment.end));
                    });
                }
            });
            ui.add_space(20.);
            ui.label("Select your motor, review its limits, then run the test.");
            return;
        };
        ui.horizontal(|ui| {
            ui.heading(
                RichText::new(format!("{} · ID {}", report.model, report.motor_id))
                    .color(theme::colors(ui).ink),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.colored_label(
                    if updating {
                        palette.muted
                    } else if report.accepted {
                        theme::colors(ui).success
                    } else {
                        theme::colors(ui).warning
                    },
                    if updating {
                        "Previous result"
                    } else if report.accepted {
                        "Validated"
                    } else {
                        "Needs improvement"
                    },
                );
            });
        });
        ui.add_space(10.);
        ui.horizontal(|ui| {
            theme::segmented(ui, |ui| {
                ui.selectable_value(&mut self.validation, true, "Validation");
                ui.selectable_value(&mut self.validation, false, "Training");
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                theme::checkbox(
                    ui,
                    &mut self.show_post,
                    RichText::new("After").color(palette.after),
                );
                theme::checkbox(
                    ui,
                    &mut self.show_pre,
                    RichText::new("Before").color(palette.before),
                );
                theme::checkbox(
                    ui,
                    &mut self.show_real,
                    RichText::new("Measured").color(palette.measured),
                );
            });
        });
        let name = if self.validation {
            "validation"
        } else {
            "training"
        };
        if let Some(r) = report.replays.iter().find(|r| r.name == name) {
            ui.add_space(8.);
            if ui.available_width() < 680. {
                metric(
                    ui,
                    "Velocity error · RMSE",
                    r.pre_velocity_rmse,
                    r.post_velocity_rmse,
                    "rad/s",
                );
                metric(
                    ui,
                    "Position error · RMSE",
                    r.pre_position_rmse,
                    r.post_position_rmse,
                    "rad",
                );
            } else {
                ui.columns(2, |cols| {
                    metric(
                        &mut cols[0],
                        "Velocity error · RMSE",
                        r.pre_velocity_rmse,
                        r.post_velocity_rmse,
                        "rad/s",
                    );
                    metric(
                        &mut cols[1],
                        "Position error · RMSE",
                        r.pre_position_rmse,
                        r.post_position_rmse,
                        "rad",
                    );
                });
            }
            ui.add_space(10.);
            theme::segmented(ui, |ui| {
                ui.selectable_value(&mut self.chart_view, ChartView::Motion, "Motion");
                ui.selectable_value(&mut self.chart_view, ChartView::Residuals, "Residuals");
                ui.selectable_value(&mut self.chart_view, ChartView::Torque, "Torque");
            });
            ui.separator();
            match self.chart_view {
                ChartView::Motion => {
                    for (title, measured, before, after) in [
                        (
                            "Velocity · rad/s",
                            &r.measured_velocity,
                            &r.pre_velocity,
                            &r.post_velocity,
                        ),
                        (
                            "Position · rad",
                            &r.measured_position,
                            &r.pre_position,
                            &r.post_position,
                        ),
                    ] {
                        ui.label(RichText::new(title).family(theme::bold()));
                        overlay(
                            ui,
                            title,
                            &r.t,
                            &[
                                (self.show_real, "Measured", measured, palette.measured),
                                (self.show_pre, "Before", before, palette.before),
                                (self.show_post, "After", after, palette.after),
                            ],
                            205.,
                        );
                    }
                }
                ChartView::Residuals => {
                    for (title, measured, before, after) in [
                        (
                            "Velocity residual · rad/s",
                            &r.measured_velocity,
                            &r.pre_velocity,
                            &r.post_velocity,
                        ),
                        (
                            "Position residual · rad",
                            &r.measured_position,
                            &r.pre_position,
                            &r.post_position,
                        ),
                    ] {
                        let pre: Vec<_> = before.iter().zip(measured).map(|(s, m)| s - m).collect();
                        let post: Vec<_> = after.iter().zip(measured).map(|(s, m)| s - m).collect();
                        ui.label(RichText::new(title).family(theme::bold()));
                        overlay(
                            ui,
                            title,
                            &r.t,
                            &[
                                (self.show_pre, "Before", &pre, palette.before),
                                (self.show_post, "After", &post, palette.after),
                            ],
                            205.,
                        );
                    }
                }
                ChartView::Torque => {
                    ui.label(RichText::new("Torque · Nm").family(theme::bold()));
                    styled_plot("torque")
                        .height(380.)
                        .x_axis_label("Time · s")
                        .show(ui, |plot| {
                            plot.line(
                                Line::new(
                                    "Command",
                                    PlotPoints::from_iter(
                                        r.command_t
                                            .iter()
                                            .zip(&r.command_torque)
                                            .map(|(&t, &v)| [t, v]),
                                    ),
                                )
                                .color(palette.before),
                            );
                            plot.line(
                                Line::new(
                                    "Reported",
                                    PlotPoints::from_iter(
                                        r.t.iter().zip(&r.reported_torque).map(|(&t, &v)| [t, v]),
                                    ),
                                )
                                .color(palette.measured),
                            );
                        });
                    ui.small(
                        "Reported torque is motor telemetry, not an external torque measurement.",
                    );
                }
            }
        }
        ui.add_space(8.);
        ui.collapsing("Fitted parameters", |ui| {
            egui::ScrollArea::horizontal().show(ui, |ui| {
                egui::Grid::new("params")
                    .num_columns(4)
                    .spacing([24., 12.])
                    .striped(true)
                    .show(ui, |ui| {
                        for label in ["Parameter", "Before", "Fitted", "Unit"] {
                            ui.label(
                                RichText::new(label)
                                    .family(theme::semibold())
                                    .color(theme::colors(ui).ink),
                            );
                        }
                        ui.end_row();
                        for (label, before, after, unit) in [
                            (
                                "Armature",
                                report.baseline.armature,
                                report.fitted.armature,
                                "kg m²",
                            ),
                            (
                                "Damping",
                                report.baseline.damping,
                                report.fitted.damping,
                                "Nm s/rad",
                            ),
                            (
                                "Friction",
                                report.baseline.friction,
                                report.fitted.friction,
                                "Nm",
                            ),
                            (
                                "Delay",
                                report.baseline.delay * 1000.,
                                report.fitted.delay * 1000.,
                                "ms",
                            ),
                        ] {
                            ui.label(label);
                            for value in [before, after] {
                                ui.label(
                                    RichText::new(format!("{value:.6}"))
                                        .family(theme::numbers())
                                        .color(theme::colors(ui).ink),
                                );
                            }
                            ui.small(unit);
                            ui.end_row();
                        }
                    });
            });
        });
        ui.collapsing("Diagnostics", |ui| {
            if let Some(refinement) = &report.diagnostics.trajectory_refinement {
                ui.label(format!(
                    "Continuous training objective: {:.5} → {:.5}. Final fit includes stops and reversals; validation remains held out.",
                    refinement.training_objective_before, refinement.training_objective_after
                ));
            }
            if report.fitted.static_friction > report.fitted.friction {
                ui.label(format!(
                    "Historical fit: separate breakaway peak {:.6} Nm. New fits defer breakaway calibration.",
                    report.fitted.static_friction
                ));
            }
            ui.label(format!(
                "{} moving seed windows · seed normalized residual {:.4}",
                report.diagnostics.moving_windows,
                report.diagnostics.moving_velocity_normalized_rmse
            ));
            for w in &report.warnings {
                ui.label(format!("• {w}"));
            }
            ui.label(format!("Engine: MuJoCo {}", report.mujoco_version));
        });

        if let Some(dir) = &self.directory {
            ui.horizontal(|ui| {
                ui.small("Saved automatically");
                if ui
                    .small_button(theme::action(ICON_FOLDER_OPEN, "Files"))
                    .clicked()
                {
                    self.sidebar_tab = SidebarTab::Files;
                }
                if ui
                    .small_button(theme::action(ICON_CONTENT_COPY, "Copy path"))
                    .clicked()
                {
                    ui.ctx().copy_text(dir.display().to_string());
                }
            });
        }
    }
}
fn metric(ui: &mut egui::Ui, label: &str, before: f64, after: f64, unit: &str) {
    theme::card(ui).show(ui, |ui| {
        ui.set_min_width((ui.available_width() - 12.).max(0.));
        ui.small(label)
            .on_hover_text("Root-mean-square error across the selected recording");
        ui.label(
            RichText::new(format!("{after:.3}"))
                .size(30.)
                .family(theme::numbers())
                .color(theme::colors(ui).ink),
        )
        .on_hover_text(format!("{after} {unit}"));
        ui.small(unit);
        if before > 1e-12 {
            let change = 100. * (1. - after / before);
            ui.colored_label(
                if change >= 0. {
                    theme::colors(ui).success
                } else {
                    theme::colors(ui).error
                },
                format!(
                    "{before:.3} before · {:.1}% {}",
                    change.abs(),
                    if change >= 0. { "lower" } else { "higher" }
                ),
            );
        }
    });
}
fn styled_plot(id: &str) -> Plot<'static> {
    // Hide crowded ticks instead of leaving near-transparent, unreadable labels.
    Plot::new(id)
        .legend(
            Legend::default()
                .follow_insertion_order(true)
                .background_alpha(0.95),
        )
        .custom_x_axes(vec![AxisHints::new_x().label_spacing(60.0..=60.5)])
        .custom_y_axes(vec![AxisHints::new_y().label_spacing(28.0..=28.5)])
}
fn overlay(
    ui: &mut egui::Ui,
    title: &str,
    t: &[f64],
    series: &[(bool, &str, &Vec<f64>, Color32)],
    height: f32,
) {
    styled_plot(title)
        .height(height)
        .x_axis_label("Time · s")
        .link_axis("time_axes", [true, false])
        .show(ui, |plot| {
            for (visible, label, values, color) in series {
                if *visible {
                    plot.line(
                        Line::new(
                            *label,
                            PlotPoints::from_iter(t.iter().zip(*values).map(|(&t, &v)| [t, v])),
                        )
                        .color(*color)
                        .width(1.7_f32),
                    );
                }
            }
        });
}
fn number(ui: &mut egui::Ui, label: &str, value: &mut f64, speed: f64) {
    ui.horizontal(|ui| {
        ui.label(label);
        ui.add(egui::DragValue::new(value).speed(speed).max_decimals(6));
    });
}
impl eframe::App for CalibrationApp {
    fn clear_color(&self, visuals: &egui::Visuals) -> [f32; 4] {
        // Eframe asks for the clear color outside the egui input pass; use the
        // same desktop/capture theme that raw_input_hook supplies to the UI.
        let dark = self
            .screenshot_theme
            .or_else(|| self.system_theme.as_ref().and_then(|w| w.current))
            .map_or(visuals.dark_mode, |theme| theme == egui::Theme::Dark);
        theme::Palette::for_theme(dark)
            .surface
            .to_normalized_gamma_f32()
    }
    fn raw_input_hook(&mut self, _ctx: &egui::Context, input: &mut egui::RawInput) {
        if let Some(watcher) = &mut self.system_theme {
            watcher.poll();
            input.system_theme = watcher.current.or(input.system_theme);
        }
        input.system_theme = self.screenshot_theme.or(input.system_theme);
    }
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if self.firmware_updating && ctx.input(|i| i.viewport().close_requested()) {
            ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
        }
        self.frame_count += 1;
        if let Some(path) = self.screenshot_path.clone() {
            for event in ctx.input(|i| i.events.clone()) {
                if let egui::Event::Screenshot { image, .. } = event {
                    let bytes: Vec<u8> = image.pixels.iter().flat_map(|p| p.to_array()).collect();
                    match image::save_buffer(
                        &path,
                        &bytes,
                        image.size[0] as u32,
                        image.size[1] as u32,
                        image::ColorType::Rgba8,
                    ) {
                        Ok(()) if !self.busy() => {
                            ctx.send_viewport_cmd(egui::ViewportCommand::Close)
                        }
                        Ok(()) => {}
                        Err(e) => self.error = Some(format!("Save screenshot: {e}")),
                    }
                    self.screenshot_path = None;
                }
            }
            if self.frame_count >= 3
                && (!self.busy()
                    || (self.screenshot_during_fit
                        && self
                            .work_progress
                            .as_ref()
                            .is_some_and(|p| p.phase == WorkPhase::Fitting && p.fraction >= 0.3)))
                && !self.screenshot_requested
            {
                ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(Default::default()));
                self.screenshot_requested = true;
            }
            ctx.request_repaint();
        }
        self.poll();
        self.poll_monitor(ctx);
        if self.screenshot_during_fit
            && self.screenshot_requested
            && self.screenshot_path.is_none()
            && !self.busy()
        {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
        if self.busy() {
            ctx.request_repaint_after(Duration::from_millis(50));
        }
        if !self.busy() && self.interfaces_checked.elapsed() >= Duration::from_secs(3) {
            self.refresh_interfaces();
        }
        ctx.request_repaint_after(Duration::from_secs(3));
        egui::TopBottomPanel::top("header")
            .frame(
                egui::Frame::new()
                    .fill(theme::context_colors(ctx).background)
                    .inner_margin(egui::Margin::symmetric(20, 16)),
            )
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.add(
                        egui::Image::new(egui::include_image!("../assets/motomind-logo.svg"))
                            .fit_to_exact_size(egui::vec2(162., 24.)),
                    );
                    ui.add_space(16.);
                    ui.label(
                        RichText::new("Motor Setup Tool")
                            .size(20.)
                            .family(theme::semibold())
                            .color(theme::colors(ui).ink),
                    );
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui
                            .add_enabled(
                                self.can_disable_motor(),
                                egui::Button::new(theme::action(
                                    ICON_POWER_SETTINGS_NEW,
                                    "Disable motor",
                                )),
                            )
                            .on_hover_text("Disable the selected motor and stop active motion")
                            .clicked()
                        {
                            self.disable_motor();
                        }
                        let color = if self.motor_ready() {
                            theme::colors(ui).success
                        } else {
                            theme::colors(ui).muted
                        };
                        theme::badge(ui, self.connection_label(), color);
                    });
                });
            });
        egui::TopBottomPanel::bottom("status").show(ctx, |ui| {
            ui.label(&self.status);
            if let Some(error) = &self.error {
                ui.colored_label(theme::colors(ui).error, error);
            }
        });
        egui::SidePanel::left("controls")
            .resizable(false)
            .exact_width(320.)
            .frame(
                egui::Frame::new()
                    .fill(theme::context_colors(ctx).background)
                    .inner_margin(20),
            )
            .show(ctx, |ui| {
                egui::ScrollArea::vertical().show(ui, |ui| self.controls(ui));
            });
        egui::CentralPanel::default()
            .frame(
                egui::Frame::new()
                    .fill(theme::context_colors(ctx).surface)
                    .inner_margin(24),
            )
            .show(ctx, |ui| {
                if self.busy() {
                    self.progress_card(ui);
                }
                egui::ScrollArea::vertical().show(ui, |ui| {
                    if self.sidebar_tab == SidebarTab::Test {
                        self.manual_view(ui);
                    } else {
                        self.comparison(ui);
                    }
                });
            });
    }
    fn save(&mut self, storage: &mut dyn eframe::Storage) {
        eframe::set_value(storage, "config", &self.config);
    }
}
impl Drop for CalibrationApp {
    fn drop(&mut self) {
        self.stop_monitor();
        self.cancel.store(true, Ordering::Relaxed);
        if let Some(job) = self.job.take() {
            let _ = job.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn header_and_disable_action_follow_motor_state_and_clear_on_disconnect() {
        let mut app = CalibrationApp::default();
        assert_eq!(app.connection_label(), "Not connected");
        assert!(!app.can_disable_motor());
        app.interfaces.push(hardware::CanInterface {
            name: "can0".into(),
            up: true,
            state: "ERROR-ACTIVE".into(),
        });
        app.found.push(hardware::DiscoveredMotor {
            id: 7,
            uuid: [0; 8],
            model: Some("RS-00".into()),
            firmware: Some("0.0.3.32".into()),
            issue: None,
        });
        app.select_motor(7);
        assert_eq!(app.connection_label(), "Connected · Disabled");
        assert!(!app.can_disable_motor());
        // Calibration uses the same confirmed state as live monitoring.
        let (tx, rx) = mpsc::channel();
        app.rx = Some(rx);
        tx.send(Event::MotorEnabled(true)).unwrap();
        app.poll();
        assert_eq!(app.connection_label(), "Connected · Enabled");
        assert!(app.can_disable_motor());
        app.firmware_updating = true;
        assert!(!app.can_disable_motor());
        app.firmware_updating = false;
        tx.send(Event::MotorEnabled(false)).unwrap();
        app.poll();
        assert_eq!(app.connection_label(), "Connected · Disabled");
        assert!(!app.can_disable_motor());
        tx.send(Event::MotorEnabled(true)).unwrap();
        app.poll();
        drop(tx);
        app.poll();
        assert!(!app.can_disable_motor());
        app.motor_enabled = true;
        app.invalidate_connection();
        assert_eq!(app.connection_label(), "Not connected");
        assert!(!app.motor_enabled && !app.can_disable_motor());
    }
    #[test]
    fn detected_model_selects_its_preset_and_invalidated_identity_blocks_motion() {
        let mut app = CalibrationApp::default();
        app.interfaces.push(hardware::CanInterface {
            name: "can0".into(),
            up: true,
            state: "ERROR-ACTIVE".into(),
        });
        for profile in Profile::presets() {
            app.found = vec![hardware::DiscoveredMotor {
                id: 7,
                uuid: [0; 8],
                firmware: Some(format!("0.{}.0.1", &profile.model[4..])),
                model: Some(profile.model.clone()),
                issue: None,
            }];
            app.select_motor(7);
            assert_eq!(app.config.profile, profile);
            assert!(app.motor_ready());
            assert!(!app.reviewed);
            app.config.validate().unwrap();
        }
        app.found[0].model = None;
        assert!(!app.motor_ready());
        app.run();
        assert!(!app.busy());
        app.reviewed = true;
        app.invalidate_connection();
        assert!(!app.reviewed && !app.motor_ready());
    }
    #[test]
    fn ui_renders_without_a_motor_or_display() {
        let ctx = egui::Context::default();
        theme::install(&ctx);
        let mut app = CalibrationApp::default();
        let output = ctx.run(Default::default(), |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                for tab in [
                    SidebarTab::Calibrate,
                    SidebarTab::Test,
                    SidebarTab::Motor,
                    SidebarTab::Files,
                ] {
                    app.sidebar_tab = tab;
                    ui.push_id(format!("tab{}", tab as u8), |ui| app.controls(ui));
                }
                app.comparison(ui);
                app.manual_view(ui);
            });
        });
        assert!(!output.shapes.is_empty());
        assert!(!app.motor_ready());
        assert!(!app.reviewed);
        assert!(!app.busy());
    }
    #[test]
    fn selected_motor_test_and_update_controls_do_not_start_hardware_on_render() {
        for theme in [egui::Theme::Light, egui::Theme::Dark] {
            let ctx = egui::Context::default();
            theme::install(&ctx);
            ctx.set_theme(theme);
            let mut app = CalibrationApp::default();
            app.interfaces.push(hardware::CanInterface {
                name: "can0".into(),
                up: true,
                state: "ERROR-ACTIVE".into(),
            });
            app.found.push(hardware::DiscoveredMotor {
                id: 7,
                uuid: [0; 8],
                model: Some("RS-00".into()),
                firmware: Some("0.0.3.9".into()),
                issue: None,
            });
            app.select_motor(7);
            let output = ctx.run(Default::default(), |ctx| {
                egui::CentralPanel::default().show(ctx, |ui| {
                    app.sidebar_tab = SidebarTab::Test;
                    app.controls(ui);
                    app.manual_view(ui);
                    app.sidebar_tab = SidebarTab::Motor;
                    app.open_firmware = true;
                    app.controls(ui);
                });
            });
            assert!(!output.shapes.is_empty());
            assert!(app.manual.is_none());
            assert!(!app.busy());
            assert!(!app.jog_reviewed);
        }
    }
}
