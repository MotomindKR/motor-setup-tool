//! Motomind's web design tokens, adapted to native egui widgets.
use eframe::egui::{self, Color32, FontData, FontFamily, FontId, RichText, Stroke, TextStyle};

pub const PRIMARY: Color32 = Color32::from_rgb(232, 46, 1);
pub const PRIMARY_HOVER: Color32 = Color32::from_rgb(207, 41, 1);
pub const WHITE: Color32 = Color32::WHITE;
#[derive(Clone, Copy)]
pub struct Palette {
    pub background: Color32,
    pub surface: Color32,
    pub subtle: Color32,
    pub ink: Color32,
    pub body: Color32,
    pub muted: Color32,
    pub border: Color32,
    pub tint: Color32,
    pub success: Color32,
    pub error: Color32,
    pub warning: Color32,
    pub link: Color32,
    pub measured: Color32,
    pub before: Color32,
    pub after: Color32,
}
impl Palette {
    pub fn for_theme(dark: bool) -> Self {
        if dark {
            Self {
                background: Color32::from_rgb(21, 16, 15),
                surface: Color32::from_rgb(28, 23, 22),
                subtle: Color32::from_rgb(42, 36, 34),
                border: Color32::from_rgb(50, 43, 41),
                ink: Color32::from_rgb(250, 250, 250),
                body: Color32::from_rgb(223, 218, 216),
                muted: Color32::from_rgb(176, 168, 165),
                tint: Color32::from_rgb(61, 43, 36),
                success: Color32::from_rgb(73, 210, 151),
                error: Color32::from_rgb(255, 125, 138),
                warning: Color32::from_rgb(255, 194, 100),
                link: Color32::from_rgb(255, 145, 122),
                measured: Color32::from_rgb(250, 250, 250),
                before: Color32::from_rgb(176, 168, 165),
                after: Color32::from_rgb(71, 211, 201),
            }
        } else {
            Self {
                background: WHITE,
                surface: Color32::from_rgb(249, 250, 251),
                subtle: Color32::from_rgb(242, 244, 246),
                border: Color32::from_rgb(229, 232, 235),
                ink: Color32::from_rgb(25, 31, 40),
                body: Color32::from_rgb(78, 89, 104),
                muted: Color32::from_rgb(100, 111, 125),
                tint: Color32::from_rgb(232, 243, 255),
                success: Color32::from_rgb(3, 120, 72),
                error: Color32::from_rgb(192, 40, 55),
                warning: Color32::from_rgb(143, 85, 0),
                link: Color32::from_rgb(201, 40, 1),
                measured: Color32::from_rgb(25, 31, 40),
                before: Color32::from_rgb(100, 111, 125),
                after: Color32::from_rgb(0, 120, 120),
            }
        }
    }
}
pub fn colors(ui: &egui::Ui) -> Palette {
    Palette::for_theme(ui.visuals().dark_mode)
}
pub fn context_colors(ctx: &egui::Context) -> Palette {
    Palette::for_theme(ctx.style().visuals.dark_mode)
}

pub fn bold() -> FontFamily {
    FontFamily::Name("Pretendard Bold".into())
}
pub fn numbers() -> FontFamily {
    FontFamily::Name("Motomind Numbers".into())
}
pub fn semibold() -> FontFamily {
    FontFamily::Name("Pretendard Semibold".into())
}

pub fn install(ctx: &egui::Context) {
    egui_extras::install_image_loaders(ctx);
    let mut fonts = egui::FontDefinitions::default();
    // A dedicated family is essential: Pretendard uses some of the same
    // private-use code points, including Material's play and stop symbols.
    let mut icons = FontData::from_static(egui_material_icons::FONT_DATA);
    icons.tweak.y_offset_factor = 0.05;
    fonts
        .font_data
        .insert("material-icons".into(), icons.into());
    fonts
        .families
        .insert(icon_family(), vec!["material-icons".into()]);
    for (name, data) in [
        (
            "Motomind Numbers",
            include_bytes!("../assets/fonts/MotomindNumbers-Bold.otf").as_slice(),
        ),
        (
            "Pretendard",
            include_bytes!("../assets/fonts/Pretendard-Regular.otf").as_slice(),
        ),
        (
            "Pretendard Semibold",
            include_bytes!("../assets/fonts/Pretendard-SemiBold.otf").as_slice(),
        ),
        (
            "Pretendard Bold",
            include_bytes!("../assets/fonts/Pretendard-Bold.otf").as_slice(),
        ),
    ] {
        fonts
            .font_data
            .insert(name.into(), FontData::from_static(data).into());
        let mut family = vec![name.to_owned()];
        family.extend(fonts.families[&FontFamily::Proportional].clone());
        fonts.families.insert(FontFamily::Name(name.into()), family);
    }
    fonts
        .families
        .get_mut(&FontFamily::Proportional)
        .unwrap()
        .insert(0, "Pretendard".into());
    // Korean fallback for technical logs, after the native fixed-width font.
    fonts
        .families
        .get_mut(&FontFamily::Monospace)
        .unwrap()
        .push("Pretendard".into());
    ctx.set_fonts(fonts);
    ctx.set_theme(egui::ThemePreference::System);
    ctx.options_mut(|o| o.fallback_theme = egui::Theme::Light);
    for theme in [egui::Theme::Light, egui::Theme::Dark] {
        let p = Palette::for_theme(theme == egui::Theme::Dark);
        let mut style = egui::Style::default();
        style
            .text_styles
            .insert(TextStyle::Body, FontId::proportional(14.));
        style
            .text_styles
            .insert(TextStyle::Button, FontId::new(14., semibold()));
        style
            .text_styles
            .insert(TextStyle::Heading, FontId::new(22., bold()));
        style
            .text_styles
            .insert(TextStyle::Small, FontId::proportional(12.));
        style
            .text_styles
            .insert(TextStyle::Monospace, FontId::monospace(13.));
        style.spacing.item_spacing = egui::vec2(8., 8.);
        style.spacing.button_padding = egui::vec2(16., 8.);
        style.spacing.interact_size = egui::vec2(36., 36.);
        style.spacing.combo_width = 170.;
        style.animation_time = 0.; // No motion competing with live measurements.
        let mut v = if theme == egui::Theme::Dark {
            egui::Visuals::dark()
        } else {
            egui::Visuals::light()
        };
        v.panel_fill = p.background;
        v.window_fill = p.background;
        v.window_stroke = Stroke::new(1_f32, p.border);
        v.window_corner_radius = 12.into();
        v.menu_corner_radius = 12.into();
        v.window_shadow = egui::epaint::Shadow {
            offset: [0, 2],
            blur: 8,
            spread: 0,
            color: Color32::from_black_alpha(20),
        };
        v.popup_shadow = v.window_shadow;
        v.weak_text_color = Some(p.muted);
        v.faint_bg_color = p.surface;
        v.extreme_bg_color = p.subtle;
        v.text_edit_bg_color = Some(p.subtle);
        v.code_bg_color = p.subtle;
        v.hyperlink_color = p.link;
        v.selection.bg_fill = p.tint;
        v.selection.stroke = Stroke::new(1.5_f32, PRIMARY);
        v.warn_fg_color = p.warning;
        v.error_fg_color = p.error;
        v.text_cursor.stroke = Stroke::new(1.5_f32, PRIMARY);
        v.widgets.noninteractive.fg_stroke = Stroke::new(1_f32, p.body);
        v.widgets.noninteractive.bg_stroke = Stroke::new(1_f32, p.border);
        v.widgets.noninteractive.corner_radius = 12.into();
        for w in [
            &mut v.widgets.inactive,
            &mut v.widgets.hovered,
            &mut v.widgets.active,
            &mut v.widgets.open,
        ] {
            w.corner_radius = 18.into();
            w.expansion = 0.;
            w.bg_stroke = Stroke::NONE;
            w.bg_fill = p.subtle;
            w.weak_bg_fill = p.subtle;
            w.fg_stroke = Stroke::new(1.5_f32, p.ink);
        }
        v.widgets.hovered.weak_bg_fill = p.tint;
        v.widgets.hovered.bg_stroke = Stroke::new(1_f32, PRIMARY);
        v.widgets.active.fg_stroke = Stroke::new(1.5_f32, p.link);
        v.widgets.open.fg_stroke = Stroke::new(1.5_f32, p.link);
        style.visuals = v;
        ctx.set_style_of(theme, style);
    }
}

pub fn card(ui: &egui::Ui) -> egui::Frame {
    let p = colors(ui);
    egui::Frame::new()
        .fill(p.background)
        .stroke(Stroke::new(1_f32, p.border))
        .corner_radius(12)
        .inner_margin(16)
}
pub fn badge(ui: &mut egui::Ui, text: &str, color: Color32) {
    egui::Frame::new()
        .fill(colors(ui).subtle)
        .corner_radius(12)
        .inner_margin(egui::Margin::symmetric(9, 4))
        .show(ui, |ui| {
            ui.label(
                RichText::new(text)
                    .size(12.)
                    .family(semibold())
                    .color(color),
            );
        });
}
pub fn primary(ui: &mut egui::Ui, icon: &str, label: &str, enabled: bool) -> egui::Response {
    ui.scope(|ui| {
        let widgets = &mut ui.visuals_mut().widgets;
        widgets.inactive.weak_bg_fill = PRIMARY;
        widgets.hovered.weak_bg_fill = PRIMARY_HOVER;
        widgets.active.weak_bg_fill = PRIMARY_HOVER;
        ui.add_enabled(
            enabled,
            egui::Button::new(action_layout(
                icon,
                label,
                FontId::new(19., bold()),
                22.,
                WHITE,
            ))
            .stroke(Stroke::NONE)
            .corner_radius(255)
            .min_size(egui::vec2(ui.available_width(), 44.)),
        )
    })
    .inner
}

fn icon_family() -> FontFamily {
    FontFamily::Name("Material Symbols".into())
}

fn action_layout(
    icon: &str,
    label: &str,
    text_font: FontId,
    icon_size: f32,
    color: Color32,
) -> egui::text::LayoutJob {
    let mut job = egui::text::LayoutJob::default();
    job.append(
        icon,
        0.,
        egui::TextFormat {
            font_id: FontId::new(icon_size, icon_family()),
            color,
            valign: egui::Align::Center,
            ..Default::default()
        },
    );
    job.append(
        label,
        6.,
        egui::TextFormat {
            font_id: text_font,
            color,
            valign: egui::Align::Center,
            ..Default::default()
        },
    );
    job
}

pub fn action(icon: &str, label: &str) -> egui::text::LayoutJob {
    action_colored(icon, label, Color32::PLACEHOLDER)
}

pub fn hold_button(ui: &mut egui::Ui, icon: &str, label: &str) -> bool {
    // Capture dragging so the surrounding ScrollArea cannot steal a held jog.
    // Moving off the button keeps the hold; releasing anywhere ends it.
    ui.add(egui::Button::new(action(icon, label)).sense(egui::Sense::click_and_drag()))
        .is_pointer_button_down_on()
}

pub fn action_colored(icon: &str, label: &str, color: Color32) -> egui::text::LayoutJob {
    action_layout(icon, label, FontId::new(14., semibold()), 18., color)
}

pub fn icon_button(ui: &mut egui::Ui, icon: &str, label: &str) -> egui::Response {
    let response = ui.add_sized(
        [36., 36.],
        egui::Button::new(RichText::new(icon).family(icon_family()).size(20.)),
    );
    response.widget_info(|| {
        egui::WidgetInfo::labeled(egui::WidgetType::Button, ui.is_enabled(), label)
    });
    response.on_hover_text(label)
}

pub fn checkbox(
    ui: &mut egui::Ui,
    value: &mut bool,
    text: impl Into<egui::WidgetText>,
) -> egui::Response {
    let palette = colors(ui);
    let text = text.into();
    let label = text.text().to_owned();
    let icon_id = egui::Id::new("motomind-checkbox");
    let mut atoms = egui::Atoms::new(text);
    atoms.push_left(egui::Atom::custom(icon_id, egui::vec2(20., 36.)));
    // Keep egui's native layout, label hit target, keyboard focus and checkbox
    // accessibility semantics; only the box and checkmark have custom paint.
    let mut prepared = egui::AtomLayout::new(atoms)
        .sense(egui::Sense::click())
        .min_size(egui::vec2(36., 36.))
        .allocate(ui);
    if prepared.response.clicked() {
        *value = !*value;
        prepared.response.mark_changed();
    }
    prepared.response.widget_info(|| {
        egui::WidgetInfo::selected(egui::WidgetType::Checkbox, ui.is_enabled(), *value, &label)
    });
    prepared.fallback_text_color = palette.ink;
    let painted = prepared.paint(ui);
    if let Some(slot) = painted.rect(icon_id) {
        let rect = egui::Rect::from_center_size(slot.center(), egui::vec2(20., 20.));
        let hovered = painted.response.hovered() || painted.response.is_pointer_button_down_on();
        let (fill, border) = if *value {
            (if hovered { PRIMARY_HOVER } else { PRIMARY }, Stroke::NONE)
        } else {
            (
                palette.background,
                Stroke::new(1.5_f32, if hovered { PRIMARY } else { palette.muted }),
            )
        };
        ui.painter()
            .rect(rect, 6, fill, border, egui::StrokeKind::Inside);
        if *value {
            ui.painter().text(
                rect.center(),
                egui::Align2::CENTER_CENTER,
                egui_material_icons::icons::ICON_CHECK,
                FontId::new(17., icon_family()),
                WHITE,
            );
        }
        if painted.response.has_focus() {
            ui.painter().rect_stroke(
                rect.expand(3.),
                8,
                Stroke::new(1_f32, PRIMARY),
                egui::StrokeKind::Outside,
            );
        }
    }
    painted.response
}

pub fn segmented(ui: &mut egui::Ui, contents: impl FnOnce(&mut egui::Ui)) {
    egui::Frame::new()
        .fill(colors(ui).subtle)
        .corner_radius(12)
        .inner_margin(4)
        .show(ui, |ui| {
            ui.visuals_mut().widgets.inactive.corner_radius = 8.into();
            ui.visuals_mut().widgets.hovered.corner_radius = 8.into();
            ui.visuals_mut().widgets.active.corner_radius = 8.into();
            ui.visuals_mut().selection.bg_fill = colors(ui).background;
            ui.visuals_mut().selection.stroke = Stroke::new(1_f32, colors(ui).ink);
            ui.horizontal(contents);
        });
}

// Winit's X11 backend reports no system theme. Read the desktop portal on a
// separate worker so desktop services can never delay motor or UI processing.
pub struct SystemThemeWatcher {
    pub current: Option<egui::Theme>,
    updates: std::sync::mpsc::Receiver<Option<egui::Theme>>,
    quit: std::sync::mpsc::Sender<()>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl SystemThemeWatcher {
    pub fn new(ctx: &egui::Context) -> Self {
        let current = desktop_theme();
        if let Some(theme) = current {
            ctx.options_mut(|o| o.fallback_theme = theme);
        }
        let (tx, updates) = std::sync::mpsc::channel();
        let (quit, stop) = std::sync::mpsc::channel();
        let ctx = ctx.clone();
        let worker = std::thread::spawn(move || {
            let mut previous = current;
            while matches!(
                stop.recv_timeout(std::time::Duration::from_secs(2)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ) {
                let theme = desktop_theme();
                if theme != previous {
                    previous = theme;
                    if tx.send(theme).is_err() {
                        break;
                    }
                    ctx.request_repaint();
                }
            }
        });
        Self {
            current,
            updates,
            quit,
            worker: Some(worker),
        }
    }
    pub fn poll(&mut self) {
        while let Ok(theme) = self.updates.try_recv() {
            self.current = theme;
        }
    }
}
impl Drop for SystemThemeWatcher {
    fn drop(&mut self) {
        let _ = self.quit.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn portal_theme(value: u32) -> Option<egui::Theme> {
    match value {
        0 | 2 => Some(egui::Theme::Light),
        1 => Some(egui::Theme::Dark),
        _ => None,
    }
}
pub fn desktop_theme() -> Option<egui::Theme> {
    let connection = zbus::blocking::connection::Builder::session()
        .ok()?
        .method_timeout(std::time::Duration::from_secs(1))
        .build()
        .ok()?;
    let proxy = zbus::blocking::Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Settings",
    )
    .ok()?;
    for method in ["ReadOne", "Read"] {
        let result: zbus::Result<zbus::zvariant::OwnedValue> =
            proxy.call(method, &("org.freedesktop.appearance", "color-scheme"));
        if let Ok(value) = result {
            // Older Read implementations return an extra variant wrapper.
            let mut value = &*value;
            while let zbus::zvariant::Value::Value(inner) = value {
                value = inner;
            }
            if let zbus::zvariant::Value::U32(value) = value {
                return portal_theme(*value);
            }
        }
    }
    // No portal: let winit supply the native preference, or egui's fallback.
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkbox_label_and_keyboard_toggle_but_disabled_control_does_not() {
        let ctx = egui::Context::default();
        install(&ctx);
        let mut checked = false;
        let mut frame = |events, enabled, focus| {
            let mut changed = false;
            let mut rect = egui::Rect::NOTHING;
            let _ = ctx.run(
                egui::RawInput {
                    screen_rect: Some(egui::Rect::from_min_size(
                        egui::Pos2::ZERO,
                        egui::vec2(400., 200.),
                    )),
                    focused: true,
                    events,
                    ..Default::default()
                },
                |ctx| {
                    egui::CentralPanel::default().show(ctx, |ui| {
                        ui.add_enabled_ui(enabled, |ui| {
                            let response =
                                checkbox(ui, &mut checked, "Motor secured · limits reviewed");
                            if focus {
                                response.request_focus();
                            }
                            changed = response.changed();
                            rect = response.rect;
                        });
                    });
                },
            );
            (checked, changed, rect)
        };
        let (_, _, rect) = frame(vec![], true, false);
        let label = egui::pos2(rect.right() - 8., rect.center().y);
        let pointer = |pressed| egui::Event::PointerButton {
            pos: label,
            button: egui::PointerButton::Primary,
            pressed,
            modifiers: Default::default(),
        };
        frame(
            vec![egui::Event::PointerMoved(label), pointer(true)],
            true,
            false,
        );
        let (checked, changed, _) = frame(vec![pointer(false)], true, true);
        assert!(checked && changed);
        let key = |pressed| egui::Event::Key {
            key: egui::Key::Space,
            physical_key: None,
            pressed,
            repeat: false,
            modifiers: Default::default(),
        };
        let (checked, changed, _) = frame(vec![key(true)], true, false);
        assert!(!checked && changed);
        frame(vec![key(false)], true, false);
        frame(vec![pointer(true)], false, false);
        let (checked, changed, _) = frame(vec![pointer(false), key(true)], false, false);
        assert!(!checked && !changed);
    }
    #[test]
    fn jog_hold_survives_pointer_drag_in_a_scroll_area_until_release() {
        let ctx = egui::Context::default();
        install(&ctx);
        let frame = |events| {
            let mut held = false;
            let _ = ctx.run(
                egui::RawInput {
                    screen_rect: Some(egui::Rect::from_min_size(
                        egui::Pos2::ZERO,
                        egui::vec2(400., 200.),
                    )),
                    focused: true,
                    events,
                    ..Default::default()
                },
                |ctx| {
                    egui::CentralPanel::default().show(ctx, |ui| {
                        egui::ScrollArea::vertical().show(ui, |ui| {
                            held = hold_button(
                                ui,
                                egui_material_icons::icons::ICON_ARROW_FORWARD,
                                "Jog +",
                            );
                            ui.add_space(1000.);
                        });
                    });
                },
            );
            held
        };
        assert!(!frame(vec![]));
        let press = egui::pos2(30., 25.);
        assert!(frame(vec![
            egui::Event::PointerMoved(press),
            egui::Event::PointerButton {
                pos: press,
                button: egui::PointerButton::Primary,
                pressed: true,
                modifiers: Default::default()
            }
        ]));
        let outside = egui::pos2(50., 100.);
        assert!(frame(vec![egui::Event::PointerMoved(outside)]));
        assert!(frame(vec![]));
        assert!(!frame(vec![egui::Event::PointerButton {
            pos: outside,
            button: egui::PointerButton::Primary,
            pressed: false,
            modifiers: Default::default()
        }]));
    }
    #[test]
    fn system_preference_switches_both_palettes_and_keeps_readable_text() {
        let ctx = egui::Context::default();
        install(&ctx);
        for theme in [egui::Theme::Light, egui::Theme::Dark] {
            let _ = ctx.run(
                egui::RawInput {
                    system_theme: Some(theme),
                    ..Default::default()
                },
                |ctx| {
                    assert_eq!(ctx.theme(), theme);
                    let palette = context_colors(ctx);
                    fn luminance(c: Color32) -> f64 {
                        let linear = |n: u8| {
                            let n = n as f64 / 255.;
                            if n <= 0.04045 {
                                n / 12.92
                            } else {
                                ((n + 0.055) / 1.055).powf(2.4)
                            }
                        };
                        0.2126 * linear(c.r()) + 0.7152 * linear(c.g()) + 0.0722 * linear(c.b())
                    }
                    for fg in [
                        palette.ink,
                        palette.body,
                        palette.muted,
                        palette.success,
                        palette.error,
                        palette.warning,
                        palette.link,
                        palette.after,
                    ] {
                        for bg in [palette.background, palette.surface, palette.subtle] {
                            let (a, b) = (luminance(fg), luminance(bg));
                            assert!(
                                (a.max(b) + 0.05) / (a.min(b) + 0.05) >= 4.5,
                                "Text contrast in {theme:?}: {fg:?} on {bg:?}"
                            );
                        }
                    }
                },
            );
        }
        assert_eq!(portal_theme(1), Some(egui::Theme::Dark));
        assert_eq!(portal_theme(2), Some(egui::Theme::Light));
        assert_eq!(portal_theme(0), Some(egui::Theme::Light));
    }
}
