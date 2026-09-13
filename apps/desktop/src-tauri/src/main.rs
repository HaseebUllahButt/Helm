// helm desktop.
//
// The window is the same app the phone runs, so there is one interface to
// maintain rather than two. What the desktop adds is a window of its own that
// stays open beside your editor, and a size worth using the two-pane layout on.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to start helm");
}
