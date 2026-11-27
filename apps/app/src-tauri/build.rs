fn main() {
    // iroh (netwatch) usa SystemConfiguration su iOS. Il progetto Xcode lo
    // collega da `bundle.iOS.frameworks` in tauri.conf.json; questa riga lo
    // dice anche a cargo, per chi collega la libreria a mano.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-lib=framework=SystemConfiguration");
    }
    tauri_build::build()
}
