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

fn run_with(dev: SimDevice, fw: &Firmware, mut hook: impl FnMut(&Progress, &CancelToken)) -> Run {
    let conn = SimConnector::new(PATH, VID, PID, dev);
    let port = conn.list().unwrap().remove(0);
    let cancel = CancelToken::new();
    let mut events = Vec::new();
    let c2 = cancel.clone();
    let result = run_upgrade(&conn, &port, fw, &opts(), &cancel, &mut |p| {
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
