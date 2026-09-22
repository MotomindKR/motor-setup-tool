# Supplemental dependency license texts

Some published Cargo crates omit their repository license files. These copies
fill those gaps. `SOURCE.txt` beside each license records its upstream URL or
the declared SPDX license choice. Commit URLs come from each published crate's
`.cargo_vcs_info.json`. They are included verbatim in the AppImage with the
crate's original Cargo manifest and the generated dependency inventory.

The `enum-map` crates declare MIT OR Apache-2.0; this package selects Apache-2.0.
`hexf-parse` declares CC0-1.0; the standard CC0 text is supplied from SPDX.
Embedded egui font licenses are copied directly from the published font crate.

`egui_material_icons` supplies MIT-licensed Rust code and the Apache-2.0
Material Symbols Rounded font. Both license texts are included.
