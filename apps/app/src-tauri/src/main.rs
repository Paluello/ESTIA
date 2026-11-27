// Niente console in più su Windows, in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    estia_app_lib::run()
}
