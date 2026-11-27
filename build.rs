fn main() {
    let relative_rpath = match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("linux") => "$ORIGIN/lib",
        Ok("macos") => "@executable_path/lib",
        _ => return,
    };
    println!("cargo:rustc-link-arg=-Wl,-rpath,{relative_rpath}");

    // Development binaries also search the SDK that mujoco-rs linked.
    if std::env::var("PROFILE").as_deref() != Ok("release")
        && let Ok(lib) = std::env::var("DEP_MUJOCO_LIB_DIR")
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{lib}");
    }
}
