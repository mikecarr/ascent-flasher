// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod state;

use ascent_proto::serial::SerialConnector;
use ascent_proto::sim::{SimConnector, SimDevice};
use ascent_proto::Connector;
use state::{should_block_close, AppState, CloseBlocked, DeviceView, FirmwareView};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

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
fn start_flash(
    app: AppHandle,
    state: Shared,
    path: String,
    confirmed_firmware: String,
    confirmed_warnings: Vec<String>,
) -> Result<(), String> {
    state::start_flash(
        app,
        state.inner().clone(),
        path,
        confirmed_firmware,
        confirmed_warnings,
    )
}

#[tauri::command]
fn cancel_flash(state: Shared) {
    state::cancel_flash(&state);
}

/// If a flash is running, emit `close-blocked` and return true (the caller
/// then prevents the close or exit).
fn block_if_flashing(app: &AppHandle) -> bool {
    let state = app.state::<Arc<AppState>>();
    if !should_block_close(state.flashing.load(Ordering::SeqCst)) {
        return false;
    }
    let locked = state.locked.load(Ordering::SeqCst);
    tracing::info!(locked, "close/quit blocked: a flash is running");
    let _ = app.emit("close-blocked", CloseBlocked { locked });
    true
}

#[cfg(target_os = "macos")]
const QUIT_ID: &str = "ascent-quit";

/// macOS: the default menu's Quit (Cmd+Q) terminates the app without an
/// `ExitRequested` event, so it is replaced by an item that calls
/// `app.exit(0)`, which does go through `ExitRequested` (and can be blocked).
#[cfg(target_os = "macos")]
fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let handle = app.handle();
    let menu = Menu::default(handle)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        if let Some(MenuItemKind::Predefined(last)) = app_menu.items()?.last() {
            if last.text()?.starts_with("Quit") {
                app_menu.remove(last)?;
                let name = handle.package_info().name.clone();
                let quit = MenuItem::with_id(
                    handle,
                    QUIT_ID,
                    format!("Quit {name}"),
                    true,
                    Some("CmdOrCtrl+Q"),
                )?;
                app_menu.append(&quit)?;
            }
        }
    }
    app.set_menu(menu)?;
    Ok(())
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
        locked: AtomicBool::new(false),
        rescan: AtomicBool::new(false),
        scan_lock: Mutex::new(()),
        cancel: Mutex::new(None),
        _log_guard: Some(guard),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state.clone())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            install_menu(app)?;
            state::spawn_watcher(app.handle().clone(), state.clone());
            Ok(())
        })
        .on_menu_event(|_app, _event| {
            #[cfg(target_os = "macos")]
            if _event.id() == QUIT_ID {
                _app.exit(0);
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if block_if_flashing(window.app_handle()) {
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_device,
            inspect_firmware,
            start_flash,
            cancel_flash
        ])
        .build(tauri::generate_context!())
        .expect("error while building Ascent Flasher")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, .. } = event {
                if block_if_flashing(app) {
                    api.prevent_exit();
                }
            }
        });
}
