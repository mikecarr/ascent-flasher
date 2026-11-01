use ascent_proto::discovery::{find_devices, is_candidate, FoundDevice};
use ascent_proto::sim::{SimConnector, SimDevice};
use ascent_proto::{AckTiming, DeviceInfo, PortInfo};
use std::time::Duration;

const TIMING: AckTiming = AckTiming {
    resend_every: Duration::from_millis(20),
    give_up_after: Duration::from_millis(100),
};

#[test]
fn candidate_vids() {
    for v in [
        0x1D6B, 0x1D6C, 0x1D70, 0x1D74, 0x1D75, 0x1D78, 0x1D7B, 0x1D80, 0x1D82, 0x1D84,
    ] {
        assert!(is_candidate(v), "{v:#x}");
    }
    for v in [0x1D6A, 0x1D7C, 0x1D7F, 0x1D85, 0x1A86, 0x05AC] {
        assert!(!is_candidate(v), "{v:#x}");
    }
}

#[test]
fn find_devices_sends_only_find_device() {
    let c = SimConnector::new(
        "/dev/cu.usbmodemSIM1",
        0x1D6B,
        0x0104,
        SimDevice::lite_plus(),
    );
    let found = find_devices(&c, TIMING);
    assert_eq!(found.len(), 1);
    let f = found.into_iter().next().unwrap().expect("probe ok");
    assert_eq!(f.info.device_name, "ascent_lite_plus");
    assert_eq!(f.port.vid, 0x1D6B);
    let log = c.device.lock().unwrap().log.clone();
    assert!(!log.is_empty());
    assert!(log.iter().all(|h| h.command == 60), "{log:?}");
}

#[test]
fn find_devices_skips_non_candidates() {
    let c = SimConnector::new("/dev/cu.other", 0x05AC, 0x0001, SimDevice::lite_plus());
    assert!(find_devices(&c, TIMING).is_empty());
    assert!(c.device.lock().unwrap().log.is_empty());
}

fn found(name: &str) -> FoundDevice {
    FoundDevice {
        port: PortInfo {
            path: "p".into(),
            vid: 0x1D6B,
            pid: 1,
            serial: None,
        },
        info: DeviceInfo {
            device_name: name.into(),
            ..SimDevice::lite_plus().info
        },
        echoes_seq: None,
    }
}

#[test]
fn flashable_names() {
    assert!(found("ascent_lite_plus").is_flashable());
    assert!(found("ASCENT_LITE").is_flashable());
    assert!(found("Ascent_VRX_pro").is_flashable());
    assert!(!found("ascent_vrx").is_flashable());
}
