fn main() {
    // iroh (netwatch) usa SystemConfiguration su iOS e macOS. Una staticlib
    // non porta con sé il collegamento, che resta al progetto Xcode; la
    // cdylib e i test sì, e senza questa riga non si collegano.
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os == "ios" || os == "macos" {
        println!("cargo:rustc-link-lib=framework=SystemConfiguration");
    }
    // netdev su iOS legge lo stato della rete con nw_path_monitor.
    if os == "ios" {
        println!("cargo:rustc-link-lib=framework=Network");
    }
}
