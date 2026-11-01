use ascent_proto::discovery::reopen_delay_for_vid;
use ascent_proto::firmware::Firmware;
use ascent_proto::sim::{SimConnector, SimDevice};
use ascent_proto::upgrade::{
    run_upgrade, CancelToken, Progress, UpgradeError, UpgradeOptions, UpgradeOutcome,
};
use ascent_proto::*;
use md5::{Digest, Md5};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const PATH: &str = "/dev/cu.usbmodem1101";
const VID: u16 = 0x1D76;
const PID: u16 = 0x0101;

fn opts() -> UpgradeOptions {
    UpgradeOptions {
        timing: AckTiming {
            resend_every: Duration::from_millis(20),
            give_up_after: Duration::from_millis(100),
        },
        reopen_delay: Duration::from_millis(10),
        reconnect_timeout: Duration::from_millis(500),
        reconnect_retry: Duration::from_millis(5),
        status_poll: Duration::from_millis(5),
        max_status_polls: 200,
        writing_timeout: Duration::from_secs(10),
    }
}

fn firmware(len: usize) -> Firmware {
    let bytes: Vec<u8> = (0..len).map(|i| (i * 7 + 3) as u8).collect();
    let md5_hex = Md5::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Firmware {
        path: PathBuf::from("/Users/me/Downloads/Ascent_Lite_Plus_1_3_0.img"),
        bytes,
        md5_hex,
        version: None,
    }
}

struct Run {
    conn: SimConnector,
    result: Result<UpgradeOutcome, UpgradeError>,
    events: Vec<Progress>,
}

fn run_with(dev: SimDevice, fw: &Firmware, hook: impl FnMut(&Progress, &CancelToken)) -> Run {
    run_opts(dev, fw, &opts(), hook)
}

fn run_opts(
    dev: SimDevice,
    fw: &Firmware,
    o: &UpgradeOptions,
    hook: impl FnMut(&Progress, &CancelToken),
) -> Run {
    let expected = dev.info.clone();
    run_expect(dev, &expected, fw, o, hook)
}

fn run_expect(
    dev: SimDevice,
    expected: &DeviceInfo,
    fw: &Firmware,
    o: &UpgradeOptions,
    mut hook: impl FnMut(&Progress, &CancelToken),
) -> Run {
    let conn = SimConnector::new(PATH, VID, PID, dev);
    let port = conn.list().unwrap().remove(0);
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let c2 = cancel.clone();
    let result = run_upgrade(&conn, &port, expected, fw, o, &cancel, &mut |p| {
        hook(&p, &c2);
        events.push(p);
    });
    Run {
        conn,
        result,
        events,
    }
}

fn commands(r: &Run) -> Vec<u32> {
    r.conn
        .device
        .lock()
        .unwrap()
        .log
        .iter()
        .map(|h| h.command)
        .collect()
}

fn reboot_payloads(r: &Run) -> Vec<Vec<u8>> {
    r.conn
        .device
        .lock()
        .unwrap()
        .received_requests
        .iter()
        .filter(|(h, _)| h.command == 3)
        .map(|(_, p)| p.clone())
        .collect()
}

fn str_field(b: &[u8], off: usize, len: usize) -> String {
    let f = &b[off..off + len];
    let end = f.iter().position(|&c| c == 0).unwrap_or(len);
    String::from_utf8_lossy(&f[..end]).into_owned()
}

#[test]
fn reopen_delays_by_vid() {
    assert_eq!(reopen_delay_for_vid(0x1D76), Duration::from_millis(11_500));
    assert_eq!(reopen_delay_for_vid(0x1D6C), Duration::from_millis(8_000));
    assert_eq!(reopen_delay_for_vid(0x1D78), Duration::from_millis(12_000));
    assert_eq!(reopen_delay_for_vid(0x1D75), Duration::from_millis(9_500));
    assert_eq!(reopen_delay_for_vid(0x1D7A), Duration::from_millis(10_000));
    assert_eq!(reopen_delay_for_vid(0x1D80), Duration::from_millis(8_000));
    assert_eq!(reopen_delay_for_vid(0x1D83), Duration::from_millis(9_500));
    assert_eq!(reopen_delay_for_vid(0x05AC), Duration::from_millis(8_000));
    let port = PortInfo {
        path: PATH.into(),
        vid: 0x1D76,
        pid: PID,
        serial: None,
    };
    let o = UpgradeOptions::for_port(&port);
    assert_eq!(o.reopen_delay, Duration::from_millis(11_500));
    let d = UpgradeOptions::default();
    assert_eq!(d.reopen_delay, Duration::from_secs(8));
    assert_eq!(d.timing.resend_every, Duration::from_secs(2));
    assert_eq!(d.timing.give_up_after, Duration::from_secs(8));
    assert_eq!(d.reconnect_timeout, Duration::from_secs(200));
    assert_eq!(d.reconnect_retry, Duration::from_secs(1));
    assert_eq!(d.status_poll, Duration::from_secs(1));
    assert_eq!(d.max_status_polls, 200);
    assert_eq!(d.writing_timeout, Duration::from_secs(300));
    assert_eq!(o.reconnect_timeout, d.reconnect_timeout);
}

#[test]
fn happy_path_sequence() {
    let fw = firmware(10_000);
    let mut dev = SimDevice::lite_plus();
    dev.info.receive_max_size = 4096;
    dev.status_script = vec![
        UpgradeStatus {
            percent: 30,
            status: 2,
            detail: "OK".into(),
        },
        UpgradeStatus {
            percent: 100,
            status: 3,
            detail: "OK".into(),
        },
    ];
    let r = run_with(dev, &fw, |_, _| {});
    let outcome = r.result.as_ref().expect("upgrade ok");
    assert_eq!(outcome.port.path, PATH);
    assert_eq!(outcome.info.device_name, "ascent_lite_plus");

    assert_eq!(
        commands(&r),
        vec![60, 3, 60, 114, 115, 116, 116, 116, 117, 118, 118, 60]
    );
    let reboots = reboot_payloads(&r);
    assert_eq!(reboots.len(), 1);
    assert_eq!(reboots[0], reboot_mode("clean").to_vec());

    let d = r.conn.device.lock().unwrap();
    assert_eq!(d.received_file, fw.bytes);
    let (_, info) = d
        .received_requests
        .iter()
        .find(|(h, _)| h.command == 115)
        .unwrap();
    assert_eq!(str_field(info, 0, 64), fw.md5_hex);
    assert_eq!(
        str_field(info, 72, 128),
        "/tmp/pc/Ascent_Lite_Plus_1_3_0.img"
    );
    assert_eq!(
        str_field(info, 200, 128),
        "/Users/me/Downloads/Ascent_Lite_Plus_1_3_0.img"
    );
    drop(d);

    let last_sent = r
        .events
        .iter()
        .rposition(|e| matches!(e, Progress::Sent { .. }))
        .unwrap();
    let locked = r
        .events
        .iter()
        .position(|e| matches!(e, Progress::CancelLocked))
        .expect("CancelLocked emitted");
    let first_writing = r
        .events
        .iter()
        .position(|e| matches!(e, Progress::Writing { .. }))
        .unwrap();
    assert!(last_sent < locked && locked < first_writing);
    assert!(matches!(
        r.events[last_sent],
        Progress::Sent {
            bytes: 10_000,
            total: 10_000
        }
    ));
    assert!(r
        .events
        .iter()
        .any(|e| matches!(e, Progress::Writing { percent: 100 })));
}

#[test]
fn port_moves_after_reboot() {
    let fw = firmware(10_000);
    let mut dev = SimDevice::lite_plus();
    dev.reboot_moves_to = Some("/dev/cu.usbmodem1201".into());
    let r = run_with(dev, &fw, |_, _| {});
    let outcome = r.result.expect("upgrade ok");
    assert_eq!(outcome.port.path, "/dev/cu.usbmodem1201");
}

#[test]
fn device_error_status() {
    let fw = firmware(10_000);
    let mut dev = SimDevice::lite_plus();
    dev.status_script = vec![
        UpgradeStatus {
            percent: 10,
            status: 2,
            detail: "OK".into(),
        },
        UpgradeStatus {
            percent: 0,
            status: -5,
            detail: "WRONG".into(),
        },
    ];
    let r = run_with(dev, &fw, |_, _| {});
    match &r.result {
        Err(UpgradeError::Failed { cause, recovered }) => {
            assert!(*recovered);
            assert!(
                matches!(**cause, UpgradeError::Device { code: -5, message } if message == status_message(-5))
            );
        }
        other => panic!("unexpected {other:?}"),
    }
    assert!(r.result.as_ref().unwrap_err().recovery_hint().is_none());
    let reboots = reboot_payloads(&r);
    assert!(
        reboots.iter().any(|p| p.starts_with(b"normal")),
        "{reboots:?}"
    );
}

#[test]
fn cancel_before_end_recovers() {
    let fw = firmware(10_000);
    let r = run_with(SimDevice::lite_plus(), &fw, |p, c| {
        if matches!(p, Progress::Sent { .. }) {
            c.cancel();
        }
    });
    assert!(
        matches!(r.result, Err(UpgradeError::Cancelled { recovered: true })),
        "{:?}",
        r.result
    );
    let cmds = commands(&r);
    assert!(!cmds.contains(&117), "{cmds:?}");
    assert_eq!(cmds.iter().filter(|&&c| c == 116).count(), 1, "{cmds:?}");
    assert!(reboot_payloads(&r).iter().any(|p| p.starts_with(b"normal")));
}

#[test]
fn cancel_before_clean_reboot_is_unchanged() {
    let fw = firmware(10_000);
    let r = run_with(SimDevice::lite_plus(), &fw, |_, c| c.cancel());
    assert!(
        matches!(r.result, Err(UpgradeError::CancelledUnchanged)),
        "{:?}",
        r.result
    );
    assert!(r.result.as_ref().unwrap_err().recovery_hint().is_none());
    assert!(reboot_payloads(&r).is_empty());
}

#[test]
fn cancel_locked_is_emitted_before_117_request() {
    let fw = firmware(10_000);
    let conn = SimConnector::new(PATH, VID, PID, SimDevice::lite_plus());
    let port = conn.list().unwrap().remove(0);
    let dev = conn.device.clone();
    let expected = dev.lock().unwrap().info.clone();
    let mut ends_at_lock = None;
    let r = run_upgrade(
        &conn,
        &port,
        &expected,
        &fw,
        &opts(),
        &CancelToken::new(),
        &mut |p| {
            if matches!(p, Progress::CancelLocked) {
                let n = dev
                    .lock()
                    .unwrap()
                    .log
                    .iter()
                    .filter(|h| h.command == 117)
                    .count();
                ends_at_lock = Some(n);
            }
        },
    );
    assert!(r.is_ok(), "{r:?}");
    assert_eq!(ends_at_lock, Some(0));
}

#[test]
fn cancel_after_end_ignored() {
    let fw = firmware(10_000);
    let r = run_with(SimDevice::lite_plus(), &fw, |p, c| {
        if matches!(p, Progress::CancelLocked) {
            c.cancel();
        }
    });
    assert!(r.result.is_ok(), "{:?}", r.result);
    assert!(!reboot_payloads(&r).iter().any(|p| p.starts_with(b"normal")));
}

#[test]
fn unplug_mid_transfer() {
    let fw = firmware(10_000);
    let mut dev = SimDevice::lite_plus();
    dev.unplug_after_data_chunks = Some(1);
    let t = Instant::now();
    let r = run_with(dev, &fw, |_, _| {});
    assert!(t.elapsed() <= Duration::from_secs(2), "{:?}", t.elapsed());
    match &r.result {
        Err(
            e @ UpgradeError::Failed {
                recovered: false, ..
            },
        ) => assert!(e.recovery_hint().is_some()),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn chunk_size_clamped() {
    let fw = firmware(10_000);
    let mut dev = SimDevice::lite_plus();
    dev.info.receive_max_size = 0;
    let r = run_with(dev, &fw, |_, _| {});
    assert!(r.result.is_ok(), "{:?}", r.result);
    assert_eq!(commands(&r).iter().filter(|&&c| c == 116).count(), 1);
    assert_eq!(r.conn.device.lock().unwrap().received_file, fw.bytes);

    let fw = firmware(1_048_576 + 10);
    let mut dev = SimDevice::lite_plus();
    dev.info.receive_max_size = 50_000_000;
    let r = run_with(dev, &fw, |_, _| {});
    assert!(r.result.is_ok(), "{:?}", r.result);
    let d = r.conn.device.lock().unwrap();
    let chunks: Vec<usize> = d
        .received_requests
        .iter()
        .filter(|(h, _)| h.command == 116)
        .map(|(_, p)| p.len())
        .collect();
    assert_eq!(chunks, vec![1_048_576, 10]);
    assert_eq!(d.received_file, fw.bytes);
}

#[test]
fn transfer_rejected() {
    let fw = firmware(10_000);
    let mut dev = SimDevice::lite_plus();
    dev.end_detail = "BAD".into();
    let r = run_with(dev, &fw, |_, _| {});
    match &r.result {
        Err(UpgradeError::Failed { cause, .. }) => {
            assert!(matches!(&**cause, UpgradeError::TransferRejected(d) if d == "BAD"))
        }
        other => panic!("unexpected {other:?}"),
    }
}

fn only_clean_reboots(r: &Run) {
    let reboots = reboot_payloads(r);
    assert!(
        reboots.iter().all(|p| *p == reboot_mode("clean").to_vec()),
        "unexpected reboot after lock: {reboots:?}"
    );
}

#[test]
fn poll_timeout_after_lock_reconnects_without_reboot() {
    let fw = firmware(10_000);
    let mut dev = SimDevice::lite_plus();
    dev.ignore_until_find_device = Some(118);
    let r = run_with(dev, &fw, |_, _| {});
    assert!(r.result.is_ok(), "{:?}", r.result);
    only_clean_reboots(&r);
    let cmds = commands(&r);
    // initial, after clean reboot, the poll reconnect, final verify
    assert_eq!(cmds.iter().filter(|&&c| c == 60).count(), 4, "{cmds:?}");
    let end = cmds.iter().position(|&c| c == 117).unwrap();
    assert!(cmds[end..].contains(&60), "{cmds:?}");
}

#[test]
fn lost_117_reply_keeps_polling() {
    let fw = firmware(10_000);
    let mut dev = SimDevice::lite_plus();
    dev.ignore_until_find_device = Some(117);
    let r = run_with(dev, &fw, |_, _| {});
    assert!(
        matches!(
            r.result,
            Ok(_)
                | Err(UpgradeError::Failed {
                    recovered: false,
                    ..
                })
        ),
        "{:?}",
        r.result
    );
    only_clean_reboots(&r);
    assert!(commands(&r).contains(&118));
}

#[test]
fn poll_budget_exhausted_after_lock_no_reboot() {
    let fw = firmware(10_000);
    let mut dev = SimDevice::lite_plus();
    dev.status_script = (0..50)
        .map(|_| UpgradeStatus {
            percent: 10,
            status: 2,
            detail: "OK".into(),
        })
        .collect();
    let o = UpgradeOptions {
        max_status_polls: 5,
        ..opts()
    };
    let r = run_opts(dev, &fw, &o, |_, _| {});
    match &r.result {
        Err(
            e @ UpgradeError::Failed {
                cause,
                recovered: false,
            },
        ) => {
            assert!(
                matches!(**cause, UpgradeError::StatusPollLimit),
                "{cause:?}"
            );
            assert!(e.recovery_hint().is_some());
        }
        other => panic!("unexpected {other:?}"),
    }
    only_clean_reboots(&r);
    assert_eq!(commands(&r).iter().filter(|&&c| c == 118).count(), 5);
}

#[test]
fn final_reconnect_failure_skips_recovery() {
    let fw = firmware(10_000);
    let mut dev = SimDevice::lite_plus();
    // Back only after the final reconnect (500 ms) has given up, but within
    // the window a (wrong) recovery reconnect would still be searching.
    dev.self_reboot_offline_for = Some(Duration::from_millis(700));
    let r = run_with(dev, &fw, |_, _| {});
    match &r.result {
        Err(UpgradeError::Failed { cause, recovered }) => {
            assert!(!*recovered);
            assert!(matches!(**cause, UpgradeError::Reconnect), "{cause:?}");
        }
        other => panic!("unexpected {other:?}"),
    }
    only_clean_reboots(&r);
}

// ---- final-review fixes (F1, F2, F3, F9) ----

/// Firmware whose file name carries version 1.3.0 (the sim device is 1.2.3).
fn firmware_v130(len: usize) -> Firmware {
    let mut fw = firmware(len);
    fw.version = ascent_proto::firmware::file_version("Ascent_Lite_Plus_1_3_0.img");
    assert!(fw.version.is_some());
    fw
}

fn progress(percent: i32) -> UpgradeStatus {
    UpgradeStatus {
        percent,
        status: 2,
        detail: "OK".into(),
    }
}

#[test]
fn recovery_requires_link_drop() {
    let fw = firmware(10_000);
    let mut dev = SimDevice::lite_plus();
    dev.ignored_reboot_modes = vec!["normal".into()];
    let r = run_with(dev, &fw, |p, c| {
        if matches!(p, Progress::Sent { .. }) {
            c.cancel();
        }
    });
    match &r.result {
        Err(e @ UpgradeError::Cancelled { recovered: false }) => {
            assert!(e.recovery_hint().is_some())
        }
        other => panic!("unexpected {other:?}"),
    }
    // REBOOT normal was sent (and ignored by the device).
    assert!(reboot_payloads(&r).iter().any(|p| p.starts_with(b"normal")));
}

#[test]
fn device_changed_before_clean_reboot_sends_nothing() {
    let fw = firmware(10_000);
    let dev = SimDevice::lite_plus();
    let mut expected = dev.info.clone();
    expected.firmware = "Ascent_Lite_Plus_1_2_2".into();
    let r = run_expect(dev, &expected, &fw, &opts(), |_, _| {});
    match &r.result {
        Err(e @ UpgradeError::DeviceChanged) => {
            assert_eq!(
                e.to_string(),
                "the connected device changed since you confirmed — nothing was written"
            );
            assert!(e.recovery_hint().is_none());
        }
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(commands(&r), vec![60]);

    // A different device name is refused the same way.
    let dev = SimDevice::lite_plus();
    let mut expected = dev.info.clone();
    expected.device_name = "ascent_lite".into();
    let r = run_expect(dev, &expected, &fw, &opts(), |_, _| {});
    assert!(matches!(r.result, Err(UpgradeError::DeviceChanged)));
    assert_eq!(commands(&r), vec![60]);

    // So is a device that is not flashable, even if it matches `expected`.
    let mut dev = SimDevice::lite_plus();
    dev.info.device_name = "ascent_vrx".into();
    let r = run_with(dev, &fw, |_, _| {});
    assert!(matches!(r.result, Err(UpgradeError::DeviceChanged)));
    assert_eq!(commands(&r), vec![60]);
}

#[test]
fn self_reboot_missed_counts_as_success_when_version_changed() {
    let fw = firmware_v130(10_000);
    let mut dev = SimDevice::lite_plus();
    dev.status_script = vec![progress(40)];
    dev.silent_self_reboot_at_poll = Some(2);
    dev.firmware_after_self_reboot = Some("Ascent_Lite_Plus_1_3_0".into());
    let r = run_with(dev, &fw, |_, _| {});
    let outcome = r.result.as_ref().expect("upgrade ok");
    assert_eq!(outcome.info.firmware, "Ascent_Lite_Plus_1_3_0");
    only_clean_reboots(&r);
    let cmds = commands(&r);
    // The 100 % status was never seen: two polls, then the reconnect's 60.
    assert_eq!(&cmds[cmds.len() - 3..], &[118, 118, 60], "{cmds:?}");
}

#[test]
fn missed_self_reboot_same_version_is_outcome_unknown() {
    let fw = firmware_v130(10_000);
    let mut dev = SimDevice::lite_plus();
    // Poll 1: 40 %. Poll 2: no reply, self-reboot (same version). The one
    // status request after the reconnect gets a non-progress answer.
    dev.status_script = vec![
        progress(40),
        UpgradeStatus {
            percent: 0,
            status: -7,
            detail: "".into(),
        },
    ];
    dev.silent_self_reboot_at_poll = Some(2);
    let r = run_with(dev, &fw, |_, _| {});
    match &r.result {
        Err(e @ UpgradeError::OutcomeUnknown { firmware }) => {
            assert_eq!(firmware, "Ascent_Lite_Plus_1_2_3");
            assert_eq!(
                e.to_string(),
                "flash result unknown — the device now reports Ascent_Lite_Plus_1_2_3"
            );
            assert_eq!(
                e.recovery_hint(),
                Some("Check the version with `ascent-flash info` (or reopen the app). If it isn't the new version, flash again.")
            );
        }
        other => panic!("unexpected {other:?}"),
    }
    only_clean_reboots(&r);
    let cmds = commands(&r);
    assert_eq!(&cmds[cmds.len() - 4..], &[118, 118, 60, 118], "{cmds:?}");
}

#[test]
fn outcome_unknown_when_status_after_reconnect_is_silent() {
    let fw = firmware_v130(10_000);
    let mut dev = SimDevice::lite_plus();
    dev.status_script = vec![progress(40)];
    dev.silent_self_reboot_at_poll = Some(2);
    dev.status_silent_after_self_reboot = true;
    let r = run_with(dev, &fw, |_, _| {});
    assert!(
        matches!(&r.result, Err(UpgradeError::OutcomeUnknown { firmware }) if firmware == "Ascent_Lite_Plus_1_2_3"),
        "{:?}",
        r.result
    );
    only_clean_reboots(&r);
    let cmds = commands(&r);
    // After the reconnect: one status request (plus its same-seq resends),
    // nothing else.
    let last_find = cmds.iter().rposition(|&c| c == 60).unwrap();
    assert!(cmds[last_find - 1] == 118, "{cmds:?}");
    let tail = &cmds[last_find + 1..];
    assert!(
        !tail.is_empty() && tail.iter().all(|&c| c == 118),
        "{cmds:?}"
    );
}

#[test]
fn unknown_file_version_is_never_success_by_version_alone() {
    // File version unknown: the reconnect can't prove success, so one status
    // request decides (here the sim's default 100 %), then the normal verify.
    let fw = firmware(10_000);
    let mut dev = SimDevice::lite_plus();
    dev.status_script = vec![progress(40)];
    dev.silent_self_reboot_at_poll = Some(2);
    dev.firmware_after_self_reboot = Some("Ascent_Lite_Plus_1_3_0".into());
    let r = run_with(dev, &fw, |_, _| {});
    assert!(r.result.is_ok(), "{:?}", r.result);
    let cmds = commands(&r);
    assert_eq!(
        &cmds[cmds.len() - 5..],
        &[118, 118, 60, 118, 60],
        "{cmds:?}"
    );
    only_clean_reboots(&r);
}

#[test]
fn writing_timeout_returns_outcome_unknown() {
    let fw = firmware_v130(10_000);
    let mut dev = SimDevice::lite_plus();
    dev.status_script = (0..10_000).map(|_| progress(10)).collect();
    let o = UpgradeOptions {
        max_status_polls: 100_000,
        writing_timeout: Duration::from_millis(150),
        ..opts()
    };
    let t = Instant::now();
    let r = run_opts(dev, &fw, &o, |_, _| {});
    assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
    match &r.result {
        Err(e @ UpgradeError::OutcomeUnknown { firmware }) => {
            assert_eq!(firmware, "Ascent_Lite_Plus_1_2_3");
            assert!(e.recovery_hint().is_some());
        }
        other => panic!("unexpected {other:?}"),
    }
    only_clean_reboots(&r);
}

#[test]
fn io_failure_reconnects_before_recovery_reboot() {
    let fw = firmware(10_000);
    let mut dev = SimDevice::lite_plus();
    // The link breaks after the first chunk; the device stays online.
    dev.break_link_after_data_chunks = Some(1);
    let r = run_with(dev, &fw, |_, _| {});
    match &r.result {
        Err(UpgradeError::Failed { cause, recovered }) => {
            assert!(*recovered);
            assert!(
                matches!(**cause, UpgradeError::Session(SessionError::Io(_))),
                "{cause:?}"
            );
        }
        other => panic!("unexpected {other:?}"),
    }
    let cmds = commands(&r);
    let normal = cmds.iter().rposition(|&c| c == 3).unwrap();
    // A fresh FIND_DEVICE (reconnect) right before REBOOT normal.
    assert_eq!(cmds[normal - 1], 60, "{cmds:?}");
    assert!(reboot_payloads(&r).iter().any(|p| p.starts_with(b"normal")));
}
