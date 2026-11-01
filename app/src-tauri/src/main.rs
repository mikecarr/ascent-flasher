// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod state;

use ascent_proto::serial::SerialConnector;
use ascent_proto::sim::{SimConnector, SimDevice};
use ascent_proto::Connector;
use state::{AppState, DeviceView, FirmwareView};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

type Shared<'a> = State<'a, Arc<AppState>>;

#[tauri::command]
fn get_device(state: Shared) -> Option<DeviceView> {
    state.current_view()
}

#[tauri::command]
fn inspect_firmware(state: Shared, path: String) -> Result<FirmwareView, String> {
    state::inspect(&state, &path)
}

#[tauri::command]
fn start_flash(app: AppHandle, state: Shared, path: String) -> Result<(), String> {
    state::start_flash(app, state.inner().clone(), path)
}

#[tauri::command]
fn cancel_flash(state: Shared) {
    state::cancel_flash(&state);
}

fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| v == "1")
}

fn main() {
    let guard = ascent_proto::logging::init(env_flag("ASCENT_DEBUG"));
    let simulate = env_flag("ASCENT_SIM");
    let conn: Arc<dyn Connector> = if simulate {
        Arc::new(SimConnector::new(
            "/dev/cu.usbmodemSIM1",
            0x1D6B,
            0x0104,
            SimDevice::lite_plus(),
        ))
    } else {
        Arc::new(SerialConnector)
    };
    let state = Arc::new(AppState {
        conn,
        simulate,
        current: Mutex::new(None),
        flashing: AtomicBool::new(false),
        rescan: AtomicBool::new(false),
        scan_lock: Mutex::new(()),
        cancel: Mutex::new(None),
        _log_guard: Some(guard),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state.clone())
        .setup(move |app| {
            state::spawn_watcher(app.handle().clone(), state.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_device,
            inspect_firmware,
            start_flash,
            cancel_flash
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ascent Flasher");
}
