fn main() {
    // Installed/AppImage libraries are adjacent to bin/. Development builds
    // additionally use the downloaded library so cargo test works directly.
    println!("cargo:rerun-if-env-changed=MUJOCO_DYNAMIC_LINK_DIR");
    println!("cargo:rerun-if-env-changed=MUJOCO_DOWNLOAD_DIR");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib");
        if std::env::var("PROFILE").as_deref() == Ok("release") {
            return;
        }
        let lib = std::env::var("MUJOCO_DYNAMIC_LINK_DIR").unwrap_or_else(|_| {
            let root = std::env::var("MUJOCO_DOWNLOAD_DIR").unwrap_or_else(|_| {
                format!(
                    "{}/.tools/mujoco",
                    std::env::var("CARGO_MANIFEST_DIR").unwrap()
                )
            });
            format!("{root}/mujoco-3.12.0/lib")
        });
        println!("cargo:rustc-link-arg=-Wl,-rpath,{lib}");
    }
}
