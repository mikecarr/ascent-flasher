//! App state, the device watcher and the flash runner. The pure mapping
//! functions are separate from the Tauri plumbing so they can be unit-tested.

use ascent_proto::discovery::{find_devices, is_candidate, FoundDevice};
use ascent_proto::firmware::{device_version, preflight, warning_text, FwVersion, Warning};
use ascent_proto::upgrade::{
    progress_text, run_upgrade, CancelToken, Phase, Progress, UpgradeError, UpgradeOptions,
};
use ascent_proto::{AckTiming, Connector, DeviceInfo, PortInfo};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub port: String,
    pub name: String,
    pub firmware: String,
    pub hardware: String,
    pub serial: String,
    pub temp_c: i32,
    pub flashable: bool,
    pub other_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarningView {
    pub kind: &'static str,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareView {
    pub file_name: String,
    pub version: Option<String>,
    pub warnings: Vec<WarningView>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub phase: &'static str,
    pub text: String,
    pub percent: Option<f32>,
    pub cancel_locked: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashDone {
    pub ok: bool,
    pub message: String,
    pub hint: Option<String>,
}

pub fn device_view(f: &FoundDevice, other_count: usize) -> DeviceView {
    DeviceView {
        port: f.port.path.clone(),
        name: f.info.device_name.clone(),
        firmware: f.info.firmware.clone(),
        hardware: f.info.hardware_version.clone(),
        serial: f.info.serial_number.clone(),
        temp_c: f.info.cpu_temp,
        flashable: f.is_flashable(),
        other_count,
    }
}

/// The device to show: the first flashable one, else the first that responded,
/// plus how many others responded.
pub fn choose_device(mut found: Vec<FoundDevice>) -> Option<(FoundDevice, usize)> {
    if found.is_empty() {
        return None;
    }
    let idx = found.iter().position(|f| f.is_flashable()).unwrap_or(0);
    let chosen = found.remove(idx);
    Some((chosen, found.len()))
}

pub fn warning_view(w: &Warning) -> WarningView {
    let kind = match w {
        Warning::Downgrade { .. } => "downgrade",
        Warning::NameMismatch { .. } => "nameMismatch",
        Warning::UnknownVersion => "unknownVersion",
    };
    WarningView {
        kind,
        text: warning_text(w),
    }
}

fn phase_name(p: Phase) -> &'static str {
    match p {
        Phase::Rebooting => "rebooting",
        Phase::Reconnecting => "reconnecting",
        Phase::EnteringUpgrade => "enteringUpgrade",
        Phase::StartingTransfer => "startingTransfer",
        Phase::Sending => "sending",
        Phase::Finishing => "finishing",
        Phase::Writing => "writing",
        Phase::Restarting => "restarting",
        Phase::Verifying => "verifying",
    }
}

/// Maps `Progress` to events; remembers that cancel became locked.
#[derive(Default)]
pub struct ProgressMapper {
    locked: bool,
}

impl ProgressMapper {
    pub fn map(&mut self, p: &Progress) -> Option<ProgressEvent> {
        if matches!(p, Progress::CancelLocked) {
            self.locked = true;
        }
        let text = progress_text(p)?;
        let (phase, percent) = match p {
            Progress::Phase(ph) => (phase_name(*ph), None),
            Progress::Sent { bytes, total } => {
                let f = if *total == 0 {
                    1.0
                } else {
                    *bytes as f32 / *total as f32
                };
                ("sending", Some(f.clamp(0.0, 1.0)))
            }
            Progress::Writing { percent } => ("writing", Some(f32::from(*percent) / 100.0)),
            Progress::CancelLocked => ("cancelLocked", None),
        };
        Some(ProgressEvent {
            phase,
            text,
            percent,
            cancel_locked: self.locked,
        })
    }
}

fn show(v: &Option<FwVersion>) -> String {
    v.as_ref().map_or("unknown".to_string(), |v| v.to_string())
}

pub fn done_ok(new_info: &DeviceInfo, file_version: &Option<FwVersion>) -> FlashDone {
    let new_ver = device_version(&new_info.firmware);
    let mut message = format!("Done — now on {}", show(&new_ver));
    if let (Some(n), Some(f)) = (&new_ver, file_version) {
        if n != f {
            message.push_str(&format!(
                ". Warning: device reports {n} but the file was {f}"
            ));
        }
    }
    FlashDone {
        ok: true,
        message,
        hint: None,
    }
}

pub fn done_err(e: &UpgradeError) -> FlashDone {
    FlashDone {
        ok: false,
        message: e.to_string(),
        hint: e.recovery_hint().map(str::to_string),
    }
}

/// Shared app state (managed by Tauri).
pub struct AppState {
    pub conn: Arc<dyn Connector>,
    pub simulate: bool,
    pub current: Mutex<Option<(FoundDevice, usize)>>,
    pub flashing: AtomicBool,
    pub rescan: AtomicBool,
    pub cancel: Mutex<Option<CancelToken>>,
    /// Keeps the log writer alive for the app lifetime.
    pub _log_guard: Option<tracing_appender::non_blocking::WorkerGuard>,
}

impl AppState {
    pub fn current_view(&self) -> Option<DeviceView> {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .map(|(f, n)| device_view(f, *n))
    }
}

fn candidate_set(conn: &dyn Connector) -> Vec<(String, u16, u16)> {
    let mut v: Vec<_> = conn
        .list()
        .unwrap_or_default()
        .into_iter()
        .filter(|p: &PortInfo| is_candidate(p.vid))
        .map(|p| (p.path, p.vid, p.pid))
        .collect();
    v.sort();
    v
}

/// Poll the port list every second; re-probe when the candidate set changes.
pub fn spawn_watcher(app: AppHandle, state: Arc<AppState>) {
    std::thread::spawn(move || {
        let mut last: Option<Vec<(String, u16, u16)>> = None;
        let mut unanswered = 0u32;
        let mut emitted: Option<DeviceView> = None;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if state.flashing.load(Ordering::SeqCst) {
                continue;
            }
            let set = candidate_set(state.conn.as_ref());
            let forced = state.rescan.swap(false, Ordering::SeqCst);
            // Retry a few times when candidates exist but none answered yet.
            let retry = unanswered > 0 && unanswered < 5;
            if !forced && !retry && last.as_ref() == Some(&set) {
                continue;
            }
            last = Some(set.clone());
            let found: Vec<FoundDevice> = find_devices(state.conn.as_ref(), AckTiming::default())
                .into_iter()
                .filter_map(Result::ok)
                .collect();
            let chosen = choose_device(found);
            unanswered = if chosen.is_none() && !set.is_empty() {
                unanswered + 1
            } else {
                0
            };
            let view = chosen.as_ref().map(|(f, n)| device_view(f, *n));
            *state.current.lock().unwrap() = chosen;
            if view != emitted || forced {
                eprintln!("[watcher] emit device-changed: {view:?}");
                let _ = app.emit("device-changed", &view);
                emitted = view;
            }
        }
    });
}

pub fn inspect(state: &AppState, path: &str) -> Result<FirmwareView, String> {
    let guard = state.current.lock().unwrap();
    let Some((dev, _)) = guard.as_ref() else {
        return Err("No device connected".into());
    };
    let (fw, warnings) = preflight(&dev.info, Path::new(path)).map_err(|e| e.to_string())?;
    Ok(FirmwareView {
        file_name: fw
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        version: fw.version.as_ref().map(|v| v.to_string()),
        warnings: warnings.iter().map(warning_view).collect(),
    })
}

/// Clears `flashing` (and requests a re-scan) when the flash thread ends.
struct FlashingGuard(Arc<AppState>);

impl Drop for FlashingGuard {
    fn drop(&mut self) {
        *self.0.cancel.lock().unwrap() = None;
        self.0.rescan.store(true, Ordering::SeqCst);
        self.0.flashing.store(false, Ordering::SeqCst);
    }
}

pub fn start_flash(app: AppHandle, state: Arc<AppState>, path: String) -> Result<(), String> {
    let device = match state.current.lock().unwrap().as_ref() {
        Some((f, _)) if f.is_flashable() => f.clone(),
        _ => return Err("No flashable device connected".into()),
    };
    if state
        .flashing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("A flash is already running".into());
    }
    let guard = FlashingGuard(state.clone());
    let (fw, _warnings) = preflight(&device.info, Path::new(&path)).map_err(|e| e.to_string())?;
    let cancel = CancelToken::new();
    *state.cancel.lock().unwrap() = Some(cancel.clone());

    std::thread::spawn(move || {
        let _guard = guard;
        let mut opts = UpgradeOptions::for_port(&device.port);
        if state.simulate {
            opts.reopen_delay = Duration::from_millis(50);
            opts.status_poll = Duration::from_millis(50);
        }
        let mut mapper = ProgressMapper::default();
        let result = run_upgrade(
            state.conn.as_ref(),
            &device.port,
            &fw,
            &opts,
            &cancel,
            &mut |p| {
                if let Some(ev) = mapper.map(&p) {
                    let _ = app.emit("flash-progress", &ev);
                }
            },
        );
        let done = match result {
            Ok(outcome) => done_ok(&outcome.info, &fw.version),
            Err(e) => done_err(&e),
        };
        let _ = app.emit("flash-done", &done);
    });
    Ok(())
}

pub fn cancel_flash(state: &AppState) {
    if let Some(t) = state.cancel.lock().unwrap().as_ref() {
        t.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(name: &str, fw: &str) -> DeviceInfo {
        DeviceInfo {
            receive_max_size: 1024,
            sdk_version: "sdk".into(),
            device_name: name.into(),
            cpu_temp: 41,
            firmware: fw.into(),
            serial_number: "SN1".into(),
            hardware_version: "HW2".into(),
            status: 0,
            detail: String::new(),
        }
    }

    fn found(path: &str, name: &str, fw: &str) -> FoundDevice {
        FoundDevice {
            port: PortInfo {
                path: path.into(),
                vid: 0x1D6B,
                pid: 0x0104,
                serial: None,
            },
            info: info(name, fw),
            echoes_seq: Some(true),
        }
    }

    #[test]
    fn device_view_maps_fields_and_serializes_camel_case() {
        let f = found("/dev/a", "Ascent_Lite_Plus", "Ascent_Lite_Plus_1_2_0");
        let v = device_view(&f, 2);
        assert_eq!(v.port, "/dev/a");
        assert_eq!(v.name, "Ascent_Lite_Plus");
        assert_eq!(v.firmware, "Ascent_Lite_Plus_1_2_0");
        assert_eq!(v.hardware, "HW2");
        assert_eq!(v.serial, "SN1");
        assert_eq!(v.temp_c, 41);
        assert!(v.flashable);
        assert_eq!(v.other_count, 2);
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j["tempC"], 41);
        assert_eq!(j["otherCount"], 2);
    }

    #[test]
    fn choose_prefers_flashable_and_counts_others() {
        assert!(choose_device(vec![]).is_none());
        let a = found("/dev/a", "Ascent_H", "Ascent_H_1_0_0");
        let b = found("/dev/b", "Ascent_Lite", "Ascent_Lite_1_0_0");
        let c = found("/dev/c", "Ascent_Lite_Plus", "Ascent_Lite_Plus_1_0_0");
        let (d, n) = choose_device(vec![a.clone(), b, c]).unwrap();
        assert_eq!(d.port.path, "/dev/b");
        assert_eq!(n, 2);
        let (d, n) = choose_device(vec![a]).unwrap();
        assert_eq!((d.port.path.as_str(), n), ("/dev/a", 0));
        assert!(!device_view(&d, n).flashable);
    }

    #[test]
    fn progress_mapping_percent_and_lock() {
        let mut m = ProgressMapper::default();
        let e = m.map(&Progress::Phase(Phase::Rebooting)).unwrap();
        assert_eq!(e.text, "Rebooting into upgrade mode…");
        assert_eq!((e.percent, e.cancel_locked), (None, false));
        let e = m
            .map(&Progress::Sent {
                bytes: 50,
                total: 200,
            })
            .unwrap();
        assert_eq!(e.text, "Sending firmware… 25%");
        assert_eq!(e.percent, Some(0.25));
        let e = m.map(&Progress::CancelLocked).unwrap();
        assert!(e.cancel_locked);
        assert_eq!(e.percent, None);
        let e = m.map(&Progress::Writing { percent: 40 }).unwrap();
        assert_eq!(e.percent, Some(0.4));
        assert!(e.cancel_locked);
        let j = serde_json::to_value(&e).unwrap();
        assert_eq!(j["cancelLocked"], true);
        assert_eq!(j["phase"], "writing");
    }

    #[test]
    fn done_ok_message_and_mismatch_note() {
        let i = info("Ascent_Lite_Plus", "Ascent_Lite_Plus_1_3_0");
        let v = device_version("x_1_3_0");
        let d = done_ok(&i, &v);
        assert!(d.ok && d.hint.is_none());
        assert_eq!(d.message, "Done — now on V1.3.0");
        let d = done_ok(&i, &device_version("x_1_4_0"));
        assert!(d.message.starts_with("Done — now on V1.3.0"));
        assert!(d
            .message
            .contains("device reports V1.3.0 but the file was V1.4.0"));
        assert_eq!(done_ok(&i, &None).message, "Done — now on V1.3.0");
    }

    #[test]
    fn done_err_has_message_and_hint() {
        let d = done_err(&UpgradeError::CancelledUnchanged);
        assert!(!d.ok && d.hint.is_none());
        assert_eq!(d.message, "upgrade cancelled (device unchanged)");
        let d = done_err(&UpgradeError::Cancelled { recovered: false });
        assert!(d.hint.is_some());
    }

    #[test]
    fn warning_kinds() {
        assert_eq!(
            warning_view(&Warning::UnknownVersion).kind,
            "unknownVersion"
        );
        let w = Warning::NameMismatch {
            expected: "X".into(),
        };
        assert_eq!(warning_view(&w).kind, "nameMismatch");
        assert!(warning_view(&w).text.contains("'X'"));
    }
}
